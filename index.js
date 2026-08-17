// ============================================================================
// Solf-ai — Yandex Cloud Functions (API + PostgreSQL)
// ============================================================================
//   - module.exports.handler(event, context)
//   - DATABASE_URL → обычный PostgreSQL (Yandex MDB / любой postgres://)
//   - /generate → DeepSeek
//   - сессии/OTP: kv_store
// ============================================================================

const crypto = require("crypto");
const { Pool } = require("pg");

let pgPool = null;
let pgPoolUrl = null;

function getPgPool() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is missing in environment variables");
  if (!pgPool || pgPoolUrl !== databaseUrl) {
    if (pgPool) pgPool.end().catch(() => {});
    // sslmode=require в URL у Node часто требует проверку CA и падает на цепочке Яндекса.
    // SSL включаем сами, без проверки самоподписанного CA.
    let connectionString = databaseUrl;
    try {
      const u = new URL(databaseUrl);
      u.searchParams.delete("sslmode");
      u.searchParams.delete("ssl");
      connectionString = u.toString();
    } catch (_) {}
    pgPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 15000,
    });
    pgPoolUrl = databaseUrl;
  }
  return pgPool;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Auth-Token",
};

/** Единый helper: любой ответ функции всегда с CORS. */
function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data == null ? {} : data, (_k, v) =>
      typeof v === "bigint" ? Number(v) : v
    ),
  };
}

function getHeader(headers, name) {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? (value[0] || "") : String(value || "");
    }
  }
  return "";
}

function getPathname(event) {
  // Прямой HTTPS-вызов Яндекса НЕ поддерживает суффиксы пути
  // (/d4e.../auth/google → "invalid functionID"). Роут передаём через ?path=
  const qp = event.queryStringParameters || {};
  const fromQuery = qp.path || qp.route || "";
  if (fromQuery) {
    const p = String(fromQuery);
    return p.startsWith("/") ? p : "/" + p;
  }

  const raw = event.url || event.path || event.requestContext?.http?.path || "/";
  let path = "/";
  try {
    if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname || "/";
    else {
      const q = String(raw).indexOf("?");
      path = q >= 0 ? String(raw).slice(0, q) : String(raw);
    }
  } catch (_) {
    path = String(raw).split("?")[0] || "/";
  }
  path = path || "/";

  // На всякий случай: /d4e2k40l9pmi9221vs4j/auth/google → /auth/google
  const fnId = process.env.FUNCTION_ID || "d4e2k40l9pmi9221vs4j";
  if (path === "/" + fnId) return "/";
  if (path.startsWith("/" + fnId + "/")) {
    path = path.slice(fnId.length + 1) || "/";
  }
  return path;
}

function getHttpMethod(event, headers) {
  const raw =
    event.httpMethod ||
    event.requestContext?.httpMethod ||
    event.requestContext?.http?.method ||
    event.method ||
    "";
  if (raw) return String(raw).toUpperCase();
  if (getHeader(headers, "Access-Control-Request-Method")) return "OPTIONS";
  return "GET";
}

function getQueryParams(event) {
  if (event.queryStringParameters && typeof event.queryStringParameters === "object") {
    return event.queryStringParameters;
  }
  const raw = event.url || event.path || "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      const out = {};
      new URL(raw).searchParams.forEach((v, k) => { out[k] = v; });
      return out;
    }
  } catch (_) {}
  const q = raw.indexOf("?");
  if (q < 0) return {};
  const out = {};
  new URLSearchParams(raw.slice(q + 1)).forEach((v, k) => { out[k] = v; });
  return out;
}

function parseBody(event) {
  if (event.body == null || event.body === "") return null;
  if (typeof event.body === "object") return event.body;
  let raw = String(event.body);
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports.handler = async function (event, context) {
  try {
    event = event || {};
    const headers = event.headers || {};
    const httpMethod = getHttpMethod(event, headers);
    const pathname = getPathname(event);
    const query = getQueryParams(event);

    // CORS preflight — сразу 200 с CORS-заголовками
    if (event.httpMethod === "OPTIONS" || httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: { ...corsHeaders },
        body: "",
      };
    }

    if (httpMethod === "GET" && (pathname === "/" || pathname === "")) {
      return jsonResponse(200, { status: "Solf-ai API is running" });
    }

  async function neonQuery(queryText, params = []) {
    const result = await getPgPool().query(queryText, params);
    return { rows: result.rows, fields: result.fields, rowCount: result.rowCount };
  }

  // Таблицы сами создаются на пустой БД
  let schemaReady = false;
  let schemaInitError = null;

  async function ensureKvTable() {
    if (schemaReady) return;
    if (schemaInitError) throw schemaInitError;
    try {
      await neonQuery(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT,
          name TEXT,
          picture TEXT,
          plan_type TEXT DEFAULT 'free',
          requests_count BIGINT DEFAULT 0,
          requests_window_start BIGINT DEFAULT 0,
          images_count BIGINT DEFAULT 0,
          images_window_start BIGINT DEFAULT 0,
          quiz_count BIGINT DEFAULT 0,
          quiz_window_start BIGINT DEFAULT 0
        )
      `);
      await neonQuery(`
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT,
          messages JSONB,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await neonQuery(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at TEXT
        )
      `);
      schemaReady = true;
    } catch (err) {
      schemaInitError = err;
      throw err;
    }
  }

  const kv = {
    async get(key) {
      await ensureKvTable();
      const data = await neonQuery(
        `SELECT value, expires_at FROM kv_store WHERE key = $1`,
        [key]
      );
      const row = data.rows?.[0];
      if (!row) return null;
      const exp = Number(row.expires_at) || 0;
      if (exp > 0 && exp < Date.now()) {
        await neonQuery(`DELETE FROM kv_store WHERE key = $1`, [key]).catch(() => {});
        return null;
      }
      return row.value;
    },
    async put(key, value, opts = {}) {
      await ensureKvTable();
      const ttl = Number(opts.expirationTtl) || 0;
      // Храним ms как TEXT — так Neon/Postgres не кастуют в date/time (ошибка 22008)
      const expiresAt = ttl > 0 ? String(Date.now() + ttl * 1000) : "0";
      await neonQuery(
        `INSERT INTO kv_store (key, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, String(value), expiresAt]
      );
    },
    async delete(key) {
      await ensureKvTable();
      await neonQuery(`DELETE FROM kv_store WHERE key = $1`, [key]);
    },
  };

  function sessionStore() {
    return kv;
  }

  // ========== USAGE LIMITS (sliding windows) ==========
  const PLAN_LIMITS = {
    free: { requests: 3, images: 0, quizzes: 3 },
    basic: { requests: 10, images: 0, quizzes: 10 },
    pro: { requests: 50, images: 5, quizzes: Infinity },
    unlimited: { requests: Infinity, images: Infinity, quizzes: Infinity },
  };

  const USAGE_WINDOWS_MS = {
    request: 24 * 60 * 60 * 1000,
    image: 24 * 60 * 60 * 1000,
    quiz: 12 * 60 * 60 * 1000,
  };

  function planLimits(planType) {
    return PLAN_LIMITS[planType] || PLAN_LIMITS.free;
  }

  const PLAN_TIER = { free: 0, basic: 1, pro: 2, unlimited: 3 };

  function isPlanUpgrade(oldPlan, newPlan) {
    return (PLAN_TIER[newPlan] ?? 0) > (PLAN_TIER[oldPlan] ?? 0);
  }

  /** При апгрейде тарифа сбрасываем счётчики — пользователь получает полный лимит нового плана. */
  async function refillUsageOnPlanUpgrade(user, previousPlanType) {
    if (!user?.id || !previousPlanType) return user;
    const currentPlan = user.plan_type || "free";
    if (previousPlanType === currentPlan || !isPlanUpgrade(previousPlanType, currentPlan)) return user;
    const now = Date.now();
    const refilled = {
      ...user,
      requests_count: 0,
      images_count: 0,
      quiz_count: 0,
      requests_window_start: now,
      images_window_start: now,
      quiz_window_start: now,
    };
    return persistUsageWindows(refilled);
  }

  function usageFields(type) {
    if (type === "image") return { count: "images_count", start: "images_window_start", window: USAGE_WINDOWS_MS.image };
    if (type === "quiz") return { count: "quiz_count", start: "quiz_window_start", window: USAGE_WINDOWS_MS.quiz };
    return { count: "requests_count", start: "requests_window_start", window: USAGE_WINDOWS_MS.request };
  }

  function shouldResetWindow(startMs, windowMs) {
    const start = Number(startMs) || 0;
    // Нет метки окна — НЕ сбрасываем счётчик (иначе null window_start обнуляет usage в БД).
    // Простое истечение окна — только когда start уже был записан.
    if (!start) return false;
    return Date.now() - start >= windowMs;
  }

  function applyUsageWindows(user) {
    const now = Date.now();
    const next = { ...user };
    for (const type of ["request", "image", "quiz"]) {
      const { count, start, window } = usageFields(type);
      const startMs = Number(user[start]) || 0;
      const countVal = Number(user[count]) || 0;
      if (shouldResetWindow(startMs, window)) {
        next[count] = 0;
        next[start] = now;
      } else {
        next[count] = countVal;
        // Инициализируем окно, если его ещё не было — без обнуления счётчика.
        next[start] = startMs || now;
      }
    }
    return next;
  }

  async function fetchUserById(userId) {
    const data = await neonQuery("SELECT * FROM users WHERE id = $1", [userId]);
    return data.rows[0] || null;
  }

  async function persistUsageWindows(user) {
    const now = Date.now();
    try {
      const data = await neonQuery(
        `UPDATE users SET
           requests_count = $2,
           requests_window_start = $3,
           images_count = $4,
           images_window_start = $5,
           quiz_count = $6,
           quiz_window_start = $7
         WHERE id = $1
         RETURNING *`,
        [
          user.id,
          Number(user.requests_count) || 0,
          Number(user.requests_window_start) || now,
          Number(user.images_count) || 0,
          Number(user.images_window_start) || now,
          Number(user.quiz_count) || 0,
          Number(user.quiz_window_start) || now,
        ]
      );
      return data.rows[0] || user;
    } catch (err) {
      console.warn("[usage] window columns missing? run db/schema.sql", err);
      return user;
    }
  }

  async function getUserWithFreshUsage(userId) {
    const row = await fetchUserById(userId);
    if (!row) return null;
    const normalized = applyUsageWindows(row);
    const changed =
      normalized.requests_count !== row.requests_count ||
      normalized.images_count !== row.images_count ||
      normalized.quiz_count !== row.quiz_count ||
      normalized.requests_window_start !== row.requests_window_start ||
      normalized.images_window_start !== row.images_window_start ||
      normalized.quiz_window_start !== row.quiz_window_start;
    return changed ? persistUsageWindows(normalized) : normalized;
  }

  function remainingUsage(user, type) {
    const limits = planLimits(user.plan_type || "free");
    const { count } = usageFields(type);
    const limit = type === "image" ? limits.images : type === "quiz" ? limits.quizzes : limits.requests;
    if (limit === Infinity) return Infinity;
    return Math.max(0, limit - (Number(user[count]) || 0));
  }

  function canUse(user, type) {
    return remainingUsage(user, type) > 0;
  }

  function usageSnapshot(user) {
    if (!user) return null;
    return {
      requests_count: Number(user.requests_count) || 0,
      images_count: Number(user.images_count) || 0,
      quiz_count: Number(user.quiz_count) || 0,
      requests_window_start: Number(user.requests_window_start) || 0,
      images_window_start: Number(user.images_window_start) || 0,
      quiz_window_start: Number(user.quiz_window_start) || 0,
      plan_type: user.plan_type || "free",
    };
  }

  /**
   * Атомарное списание: UPDATE ... SET count = count + 1 WHERE count < limit.
   * Нельзя делать read→+1→write абсолютным значением — два устройства
   * перезаписывают друг друга (last-write-wins) и «теряют» списания.
   *
   * Fallback на legacy write, если атомарный SQL не поддерживается / вернул пусто
   * при ещё доступном лимите (ложные 429 из‑за формата ответа Neon).
   */
  async function incrementUsageForUser(userId, type) {
    let user = await getUserWithFreshUsage(userId);
    if (!user) return { error: "User not found", status: 404 };

    const limits = planLimits(user.plan_type || "free");
    const now = Date.now();

    if (type === "image") {
      if (limits.images === 0) {
        return { error: "Images not available on your plan", status: 403, code: "LIMIT_IMAGES", user };
      }
      if (limits.images !== Infinity && !canUse(user, "image")) {
        return { error: "Image limit reached", status: 429, code: "LIMIT_IMAGES", user };
      }
      if (limits.requests !== Infinity && !canUse(user, "request")) {
        return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS", user };
      }
    } else if (type === "quiz") {
      if (limits.quizzes !== Infinity && !canUse(user, "quiz")) {
        return { error: "Quiz limit reached", status: 429, code: "LIMIT_QUIZ", user };
      }
    } else if (limits.requests !== Infinity && !canUse(user, "request")) {
      return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS", user };
    }

    const limitError = () => {
      if (type === "image") return { error: "Image limit reached", status: 429, code: "LIMIT_IMAGES" };
      if (type === "quiz") return { error: "Quiz limit reached", status: 429, code: "LIMIT_QUIZ" };
      return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS" };
    };

    async function legacyWrite(baseUser) {
      const next = { ...baseUser };
      if (type === "image") {
        next.images_count = (Number(next.images_count) || 0) + 1;
        if (!next.images_window_start) next.images_window_start = now;
        next.requests_count = (Number(next.requests_count) || 0) + 1;
        if (!next.requests_window_start) next.requests_window_start = now;
      } else if (type === "quiz") {
        next.quiz_count = (Number(next.quiz_count) || 0) + 1;
        if (!next.quiz_window_start) next.quiz_window_start = now;
      } else {
        next.requests_count = (Number(next.requests_count) || 0) + 1;
        if (!next.requests_window_start) next.requests_window_start = now;
      }
      const saved = await persistUsageWindows(next);
      return { user: saved };
    }

    try {
      let data;
      if (type === "image") {
        if (limits.images === Infinity && limits.requests === Infinity) {
          data = await neonQuery(
            `UPDATE users SET
               images_count = COALESCE(images_count, 0) + 1,
               images_window_start = CASE WHEN COALESCE(images_window_start, 0) = 0 THEN $2 ELSE images_window_start END,
               requests_count = COALESCE(requests_count, 0) + 1,
               requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
             WHERE id = $1
             RETURNING *`,
            [userId, now]
          );
        } else if (limits.images === Infinity) {
          data = await neonQuery(
            `UPDATE users SET
               images_count = COALESCE(images_count, 0) + 1,
               images_window_start = CASE WHEN COALESCE(images_window_start, 0) = 0 THEN $2 ELSE images_window_start END,
               requests_count = COALESCE(requests_count, 0) + 1,
               requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
             WHERE id = $1 AND COALESCE(requests_count, 0) < $3
             RETURNING *`,
            [userId, now, limits.requests]
          );
        } else if (limits.requests === Infinity) {
          data = await neonQuery(
            `UPDATE users SET
               images_count = COALESCE(images_count, 0) + 1,
               images_window_start = CASE WHEN COALESCE(images_window_start, 0) = 0 THEN $2 ELSE images_window_start END,
               requests_count = COALESCE(requests_count, 0) + 1,
               requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
             WHERE id = $1 AND COALESCE(images_count, 0) < $3
             RETURNING *`,
            [userId, now, limits.images]
          );
        } else {
          data = await neonQuery(
            `UPDATE users SET
               images_count = COALESCE(images_count, 0) + 1,
               images_window_start = CASE WHEN COALESCE(images_window_start, 0) = 0 THEN $2 ELSE images_window_start END,
               requests_count = COALESCE(requests_count, 0) + 1,
               requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
             WHERE id = $1
               AND COALESCE(images_count, 0) < $3
               AND COALESCE(requests_count, 0) < $4
             RETURNING *`,
            [userId, now, limits.images, limits.requests]
          );
        }
      } else if (type === "quiz") {
        if (limits.quizzes === Infinity) {
          data = await neonQuery(
            `UPDATE users SET
               quiz_count = COALESCE(quiz_count, 0) + 1,
               quiz_window_start = CASE WHEN COALESCE(quiz_window_start, 0) = 0 THEN $2 ELSE quiz_window_start END
             WHERE id = $1
             RETURNING *`,
            [userId, now]
          );
        } else {
          data = await neonQuery(
            `UPDATE users SET
               quiz_count = COALESCE(quiz_count, 0) + 1,
               quiz_window_start = CASE WHEN COALESCE(quiz_window_start, 0) = 0 THEN $2 ELSE quiz_window_start END
             WHERE id = $1 AND COALESCE(quiz_count, 0) < $3
             RETURNING *`,
            [userId, now, limits.quizzes]
          );
        }
      } else if (limits.requests === Infinity) {
        data = await neonQuery(
          `UPDATE users SET
             requests_count = COALESCE(requests_count, 0) + 1,
             requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
           WHERE id = $1
           RETURNING *`,
          [userId, now]
        );
      } else {
        data = await neonQuery(
          `UPDATE users SET
             requests_count = COALESCE(requests_count, 0) + 1,
             requests_window_start = CASE WHEN COALESCE(requests_window_start, 0) = 0 THEN $2 ELSE requests_window_start END
           WHERE id = $1 AND COALESCE(requests_count, 0) < $3
           RETURNING *`,
          [userId, now, limits.requests]
        );
      }

      const row = data?.rows?.[0];
      if (row) return { user: row };

      // Пустой RETURNING: либо лимит, либо глюк ответа — перепроверяем
      user = await getUserWithFreshUsage(userId);
      if (type === "image") {
        if ((limits.images === Infinity || canUse(user, "image")) &&
            (limits.requests === Infinity || canUse(user, "request"))) {
          return legacyWrite(user);
        }
      } else if (type === "quiz") {
        if (limits.quizzes === Infinity || canUse(user, "quiz")) return legacyWrite(user);
      } else if (limits.requests === Infinity || canUse(user, "request")) {
        return legacyWrite(user);
      }
      return { ...limitError(), user };
    } catch (err) {
      console.warn("[usage] atomic increment failed, legacy fallback", err);
      user = await getUserWithFreshUsage(userId);
      if (!user) return { error: "User not found", status: 404 };
      if (type === "image") {
        if (limits.images === 0) return { error: "Images not available on your plan", status: 403, code: "LIMIT_IMAGES", user };
        if (limits.images !== Infinity && !canUse(user, "image")) return { ...limitError(), user };
        if (limits.requests !== Infinity && !canUse(user, "request")) {
          return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS", user };
        }
      } else if (type === "quiz") {
        if (limits.quizzes !== Infinity && !canUse(user, "quiz")) return { ...limitError(), user };
      } else if (limits.requests !== Infinity && !canUse(user, "request")) {
        return { ...limitError(), user };
      }
      return legacyWrite(user);
    }
  }

  /** Откат списания (например, DeepSeek упал после pre-charge). */
  async function decrementUsageForUser(userId, type) {
    try {
      if (type === "image") {
        const data = await neonQuery(
          `UPDATE users SET
             images_count = GREATEST(COALESCE(images_count, 0) - 1, 0),
             requests_count = GREATEST(COALESCE(requests_count, 0) - 1, 0)
           WHERE id = $1
           RETURNING *`,
          [userId]
        );
        if (data?.rows?.[0]) return data.rows[0];
      } else if (type === "quiz") {
        const data = await neonQuery(
          `UPDATE users SET quiz_count = GREATEST(COALESCE(quiz_count, 0) - 1, 0) WHERE id = $1 RETURNING *`,
          [userId]
        );
        if (data?.rows?.[0]) return data.rows[0];
      } else {
        const data = await neonQuery(
          `UPDATE users SET requests_count = GREATEST(COALESCE(requests_count, 0) - 1, 0) WHERE id = $1 RETURNING *`,
          [userId]
        );
        if (data?.rows?.[0]) return data.rows[0];
      }
    } catch (err) {
      console.warn("[usage] atomic decrement failed, legacy fallback", err);
    }
    const user = await getUserWithFreshUsage(userId);
    if (!user) return null;
    if (type === "image") {
      user.images_count = Math.max(0, (Number(user.images_count) || 0) - 1);
      user.requests_count = Math.max(0, (Number(user.requests_count) || 0) - 1);
    } else if (type === "quiz") {
      user.quiz_count = Math.max(0, (Number(user.quiz_count) || 0) - 1);
    } else {
      user.requests_count = Math.max(0, (Number(user.requests_count) || 0) - 1);
    }
    return persistUsageWindows(user);
  }

  // ========== SESSION AUTH ==========
  const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
  // Телефон + ПК (+ запас) — ок. 4-й логин выкидывает самую старую сессию.
  const MAX_SESSIONS_PER_USER = 3;

  function userSessionsKey(userId) {
    return "usess:" + userId;
  }

  async function readUserSessionList(store, userId) {
    try {
      const raw = await store.get(userSessionsKey(userId));
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter((e) => e && e.token) : [];
    } catch (_) {
      return [];
    }
  }

  async function writeUserSessionList(store, userId, list) {
    await store.put(userSessionsKey(userId), JSON.stringify(list), {
      expirationTtl: SESSION_TTL_SEC,
    });
  }

  /** Убрать токен из индекса сессий пользователя (без удаления самого sess:). */
  async function removeTokenFromUserSessions(userId, token) {
    const store = sessionStore();
    if (!store || !userId || !token) return;
    const list = await readUserSessionList(store, userId);
    const next = list.filter((e) => e.token !== token);
    if (next.length === list.length) return;
    if (next.length === 0) {
      await store.delete(userSessionsKey(userId));
    } else {
      await writeUserSessionList(store, userId, next);
    }
  }

  /**
   * Зарегистрировать новую сессию. Если у юзера уже MAX — удаляем самые старые sess:.
   * Старый клиент получит 401 на следующем запросе (существующий редирект на login).
   */
  async function registerUserSession(userId, token, createdAt) {
    const store = sessionStore();
    if (!store) return;
    let list = await readUserSessionList(store, userId);
    list.push({ token, createdAt });
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    while (list.length > MAX_SESSIONS_PER_USER) {
      const oldest = list.shift();
      if (oldest?.token) {
        try {
          await store.delete("sess:" + oldest.token);
        } catch (_) {}
      }
    }
    await writeUserSessionList(store, userId, list);
  }

  async function createSession(userId) {
    const store = sessionStore();
    if (!store) throw new Error("Session storage is required for auth");
    const token = (crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"));
    const createdAt = Date.now();
    try {
      await store.put(
        "sess:" + token,
        JSON.stringify({ userId, createdAt }),
        { expirationTtl: SESSION_TTL_SEC }
      );
    } catch (err) {
      throw new Error("Session KV write failed: " + (err.message || String(err)));
    }
    try {
      await registerUserSession(userId, token, createdAt);
    } catch (err) {
      console.warn("[session] registerUserSession failed:", err);
      // Токен уже записан — логин всё равно возможен
    }
    return token;
  }

  /** Logout / отзыв: удалить sess: и убрать из списка usess:. */
  async function destroySession(token) {
    const store = sessionStore();
    if (!store || !token) return;
    let userId = null;
    try {
      const raw = await store.get("sess:" + token);
      if (raw) userId = JSON.parse(raw).userId || null;
    } catch (_) {}
    try {
      await store.delete("sess:" + token);
    } catch (_) {}
    if (userId) await removeTokenFromUserSessions(userId, token);
  }

  function extractBearerToken() {
    // Yandex Cloud Functions: заголовок Authorization с не-IAM токеном
    // даёт платформенный 403 "Forbidden: Not authorized" до handler'а.
    // Фронт шлёт сессию только в X-Auth-Token.
    const candidates = [
      getHeader(headers, "X-Auth-Token"),
      getHeader(headers, "Authorization"),
      getHeader(headers, "X-Yf-Remapped-Authorization"),
    ];
    for (const raw of candidates) {
      if (!raw) continue;
      const v = String(raw).trim();
      if (v.toLowerCase().startsWith("bearer ")) {
        const t = v.slice(7).trim();
        if (t) return t;
      } else if (v) {
        return v;
      }
    }
    return null;
  }

  async function getSessionUserId() {
    const store = sessionStore();
    if (!store) return null;
    const token = extractBearerToken();
    if (!token) return null;
    const raw = await store.get("sess:" + token);
    if (!raw) return null;
    try {
      return JSON.parse(raw).userId || null;
    } catch (_) {
      return null;
    }
  }

  async function requireAuth() {
    const userId = await getSessionUserId();
    if (!userId) {
      return { error: jsonResponse(401, { error: "Unauthorized", code: "AUTH_REQUIRED" }) };
    }
    return { userId };
  }

  function forbidSelfOnly(sessionUserId, targetUserId) {
    if (!targetUserId || String(sessionUserId) !== String(targetUserId)) {
      return jsonResponse(403, { error: "Forbidden", code: "FORBIDDEN" });
    }
    return null;
  }

  async function upsertOAuthUser(user) {
    await neonQuery(
      `INSERT INTO users (id, email, name, picture, plan_type)
       VALUES ($1, $2, $3, $4, 'free')
       ON CONFLICT (id) DO UPDATE
       SET email = COALESCE($2, users.email),
           name = COALESCE($3, users.name),
           picture = COALESCE($4, users.picture)
       RETURNING *;`,
      [user.id, user.email || "", user.name || "", user.picture || ""]
    );
    return getUserWithFreshUsage(user.id);
  }

  async function handleGoogleAuth(body) {
    console.log("Auth payload:", body);
    try {
      if (!sessionStore()) {
        return jsonResponse(503, { error: "Session storage not configured" });
      }
      const credential = body?.credential;
      if (!credential) {
        return jsonResponse(400, { error: "Missing Google credential" });
      }

      let verifyRes;
      let payload;
      try {
        verifyRes = await fetch(
          "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
        );
        payload = await verifyRes.json().catch(() => ({}));
      } catch (googleErr) {
        console.error("[auth/google] tokeninfo failed:", googleErr);
        return jsonResponse(502, {
          error: "Could not verify Google token",
          details: googleErr.message || String(googleErr),
        });
      }

      if (!verifyRes.ok || payload.error || !payload.sub) {
        return jsonResponse(401, {
          error: "Invalid Google token",
          details: payload.error || payload.error_description || undefined,
        });
      }

      // Если GOOGLE_CLIENT_ID задан — сверяем aud. Если нет — принимаем валидный tokeninfo без жёсткой проверки.
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && payload.aud && payload.aud !== clientId) {
        return jsonResponse(401, { error: "Google token audience mismatch" });
      }
      if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
        return jsonResponse(401, { error: "Google token expired" });
      }

      const profile = {
        id: String(payload.sub),
        email: payload.email || "",
        name: payload.name || payload.email || "User",
        picture: payload.picture || "",
      };

      let dbUser;
      let sessionToken;
      try {
        dbUser = await upsertOAuthUser(profile);
      } catch (dbErr) {
        console.error("[auth/google] save user error:", dbErr);
        return jsonResponse(500, {
          error: "Failed to save user",
          details: dbErr.message || String(dbErr),
        });
      }
      try {
        sessionToken = await createSession(profile.id);
      } catch (sessErr) {
        console.error("[auth/google] session error:", sessErr);
        return jsonResponse(500, {
          error: "Failed to create user session",
          details: sessErr.message || String(sessErr),
        });
      }

      return jsonResponse(200, { user: dbUser || profile, sessionToken });
    } catch (err) {
      console.error("[auth/google]", err);
      return jsonResponse(500, {
        error: err.message || "Google auth failed",
      });
    }
  }

  async function handleVkAuth(body) {
    try {
      if (!sessionStore()) {
        return jsonResponse(503, { error: "Session storage not configured" });
      }
      const clientId = String(process.env.VK_APP_ID || body?.client_id || "54641545");
      let vkUserId = null;
      let name = "";
      let email = "";
      let picture = "";

      if (body?.id_token) {
        const res = await fetch("https://id.vk.com/oauth2/public_info", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ id_token: body.id_token, client_id: clientId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return jsonResponse(401, { error: "Invalid VK token", details: data });
        }
        const u = data.user || data;
        vkUserId = u.user_id || u.userId || data.user_id;
        name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        email = u.email || "";
        picture = u.avatar || u.photo_200 || "";
      } else if (body?.access_token) {
        const res = await fetch("https://id.vk.com/oauth2/user_info", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ access_token: body.access_token, client_id: clientId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return jsonResponse(401, { error: "Invalid VK access token", details: data });
        }
        const u = data.user || data;
        vkUserId = u.user_id || u.userId || data.user_id;
        name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        email = u.email || "";
        picture = u.avatar || u.photo_200 || "";
      } else {
        return jsonResponse(400, { error: "Missing VK id_token or access_token" });
      }

      if (!vkUserId) {
        return jsonResponse(401, { error: "Could not resolve VK user id" });
      }

      const profile = {
        id: "vk_" + vkUserId,
        email,
        name: name || "VK User",
        picture,
      };
      const dbUser = await upsertOAuthUser(profile);
      const sessionToken = await createSession(profile.id);
      return jsonResponse(200, { user: dbUser || profile, sessionToken });
    } catch (err) {
      console.error("[auth/vk]", err);
      return jsonResponse(500, { error: err.message || "VK auth failed" });
    }
  }

  async function handleLogout() {
    try {
      const token = extractBearerToken();
      if (token) await destroySession(token);
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error("[auth/logout]", err);
      return jsonResponse(200, { ok: true });
    }
  }

  // ========== OTP AUTH (email / phone) ==========
  const OTP_TTL_SEC = 600;
  const SEND_COOLDOWN_SEC = 60;
  const MAX_VERIFY_ATTEMPTS = 5;

  function parseContact(raw) {
    const value = String(raw || "").trim();
    if (!value) return { error: "Enter your email or phone number" };

    if (value.includes("@")) {
      const email = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: "Invalid email address" };
      }
      return { type: "email", normalized: email, display: email };
    }

    let digits = value.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
    if (digits.length === 10) digits = "7" + digits;
    if (digits.length < 10 || digits.length > 15) {
      return { error: "Invalid phone number" };
    }
    return { type: "phone", normalized: digits, display: "+" + digits };
  }

  function otpKey(contact) {
    return "otp:" + contact.type + ":" + contact.normalized;
  }

  function rateKey(kind, value) {
    return "rl:" + kind + ":" + value;
  }

  function generateCode() {
    const n = crypto.randomInt(0, 1000000);
    return String(n).padStart(6, "0");
  }

  function userFromContact(contact) {
    const id = contact.type === "email"
      ? "email_" + contact.normalized.replace("@", "_at_")
      : "phone_" + contact.normalized;
    const name = contact.type === "email"
      ? contact.normalized.split("@")[0]
      : contact.display;
    return {
      id,
      email: contact.type === "email" ? contact.normalized : "",
      name,
      picture: "",
    };
  }

  async function checkRateLimit(store, key, windowSec, max) {
    const raw = await store.get(key);
    const now = Date.now();
    let entry = raw ? JSON.parse(raw) : { count: 0, reset: now + windowSec * 1000 };
    if (now > entry.reset) entry = { count: 0, reset: now + windowSec * 1000 };
    entry.count += 1;
    await store.put(key, JSON.stringify(entry), { expirationTtl: windowSec + 60 });
    return entry.count <= max;
  }

  async function sendOtpEmail(to, code) {
    if (!process.env.RESEND_API_KEY || !process.env.OTP_FROM_EMAIL) {
      throw new Error("Email delivery is not configured (RESEND_API_KEY, OTP_FROM_EMAIL)");
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL,
        to: [to],
        subject: "Your Solf-ai sign-in code",
        html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes.</p>`,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error("Failed to send email: " + err.slice(0, 200));
    }
  }

  async function sendOtpSms(phoneDigits, code) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
      throw new Error("SMS delivery is not configured (Twilio secrets)");
    }
    const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: "+" + phoneDigits,
          From: process.env.TWILIO_FROM_NUMBER,
          Body: `Your Solf-ai code: ${code}. Valid for 10 minutes.`,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error("Failed to send SMS: " + err.slice(0, 200));
    }
  }

  async function handleSendCode(body) {
    const store = sessionStore();
    if (!store) {
      return jsonResponse(503, { error: "Session/OTP storage is not available" });
    }

    const contact = parseContact(body?.contact);
    if (contact.error) {
      return jsonResponse(400, { error: contact.error });
    }

    const ip =
      getHeader(headers, "X-Forwarded-For").split(",")[0].trim() ||
      getHeader(headers, "X-Real-IP") ||
      event.requestContext?.identity?.sourceIp ||
      "unknown";
    if (!(await checkRateLimit(store, rateKey("ip", ip), 3600, 10))) {
      return jsonResponse(429, { error: "Too many requests. Try again later." });
    }
    if (!(await checkRateLimit(store, rateKey("send", contact.normalized), 3600, 5))) {
      return jsonResponse(429, { error: "Too many codes sent. Try again later." });
    }

    const cooldown = await store.get(rateKey("cooldown", contact.normalized));
    if (cooldown) {
      const wait = Math.max(1, Math.ceil((Number(cooldown) - Date.now()) / 1000));
      return jsonResponse(429, { error: `Wait ${wait}s before requesting a new code`, retryAfter: wait });
    }

    const code = generateCode();
    const payload = { code, attempts: 0, type: contact.type, normalized: contact.normalized, created: Date.now() };

    try {
      if (contact.type === "email") {
        await sendOtpEmail(contact.normalized, code);
      } else {
        await sendOtpSms(contact.normalized, code);
      }
    } catch (err) {
      console.error("[auth-otp]", err);
      return jsonResponse(503, { error: err.message || "Could not send verification code" });
    }

    await store.put(otpKey(contact), JSON.stringify(payload), { expirationTtl: OTP_TTL_SEC });
    await store.put(rateKey("cooldown", contact.normalized), String(Date.now() + SEND_COOLDOWN_SEC * 1000), { expirationTtl: SEND_COOLDOWN_SEC + 10 });

    return jsonResponse(200, {
      ok: true,
      channel: contact.type,
      masked: contact.type === "email"
        ? contact.normalized.replace(/(.{2}).+(@.+)/, "$1***$2")
        : "+" + contact.normalized.slice(0, 1) + " *** *** " + contact.normalized.slice(-2),
      expiresIn: OTP_TTL_SEC,
      resendIn: SEND_COOLDOWN_SEC,
    });
  }

  async function handleVerifyCode(body) {
    const store = sessionStore();
    if (!store) {
      return jsonResponse(503, { error: "Session/OTP storage is not available" });
    }

    const contact = parseContact(body?.contact);
    if (contact.error) {
      return jsonResponse(400, { error: contact.error });
    }

    const ip =
      getHeader(headers, "X-Forwarded-For").split(",")[0].trim() ||
      getHeader(headers, "X-Real-IP") ||
      event.requestContext?.identity?.sourceIp ||
      "unknown";
    if (!(await checkRateLimit(store, rateKey("verify-ip", ip), 3600, 30))) {
      return jsonResponse(429, { error: "Too many attempts. Try again later." });
    }

    const code = String(body?.code || "").trim().replace(/\D/g, "");
    if (code.length !== 6) {
      return jsonResponse(400, { error: "Enter the 6-digit code" });
    }

    const storedRaw = await store.get(otpKey(contact));
    if (!storedRaw) {
      return jsonResponse(400, { error: "Code expired or not found. Request a new one." });
    }

    const stored = JSON.parse(storedRaw);
    if (stored.normalized !== contact.normalized) {
      return jsonResponse(400, { error: "Code expired or not found. Request a new one." });
    }

    stored.attempts = (stored.attempts || 0) + 1;
    if (stored.attempts > MAX_VERIFY_ATTEMPTS) {
      await store.delete(otpKey(contact));
      return jsonResponse(400, { error: "Too many attempts. Request a new code." });
    }
    await store.put(otpKey(contact), JSON.stringify(stored), { expirationTtl: OTP_TTL_SEC });

    if (stored.code !== code) {
      return jsonResponse(400, { error: "Incorrect code", attemptsLeft: MAX_VERIFY_ATTEMPTS - stored.attempts });
    }

    await store.delete(otpKey(contact));
    const user = userFromContact(contact);

    // Сохраняем пользователя в Neon (как Google/VK)
    await neonQuery(
      `INSERT INTO users (id, email, name, picture, plan_type)
       VALUES ($1, $2, $3, $4, 'free')
       ON CONFLICT (id) DO UPDATE
       SET email = COALESCE($2, users.email),
           name = COALESCE($3, users.name),
           picture = COALESCE($4, users.picture)
       RETURNING *;`,
      [user.id, user.email, user.name, user.picture]
    );

    const sessionToken = await createSession(user.id);
    const dbUser = await getUserWithFreshUsage(user.id);

    return jsonResponse(200, { ok: true, user: dbUser || user, sessionToken });
  }

    const body = (httpMethod === "POST" || httpMethod === "PUT" || httpMethod === "PATCH")
      ? parseBody(event)
      : null;

    if (httpMethod === "GET" && pathname === "/health") {
      const info = {
        ok: true,
        build: "2026-08-16-ycpg1",
        generateProvider: "deepseek",
        deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        hasDeepseekKey: Boolean(process.env.DEEPSEEK_API_KEY),
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
        hasGoogleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
        node: process.version,
      };
      if (!process.env.DATABASE_URL) {
        return jsonResponse(500, { ...info, ok: false, error: "DATABASE_URL missing" });
      }
      try {
        const ping = await neonQuery("SELECT 1 AS ok");
        info.db = "ok";
        info.dbRows = ping.rows || [];
        try {
          await ensureKvTable();
          info.kv_store = "ok";
        } catch (kvErr) {
          info.kv_store = "fail";
          info.kv_error = kvErr.message || String(kvErr);
        }
        return jsonResponse(info.kv_store === "ok" ? 200 : 500, info);
      } catch (dbErr) {
        return jsonResponse(500, {
          ...info,
          ok: false,
          db: "fail",
          error: dbErr.message || String(dbErr),
        });
      }
    }

    // Быстрая проверка DeepSeek
    if (httpMethod === "GET" && pathname === "/health/deepseek") {
      const key = String(process.env.DEEPSEEK_API_KEY || "").trim();
      if (!key) {
        return jsonResponse(500, { ok: false, error: "DEEPSEEK_API_KEY missing" });
      }
      try {
        const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with one word: ok" }],
            max_tokens: 16,
            temperature: 0,
            thinking: { type: "disabled" },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          return jsonResponse(res.status || 500, {
            ok: false,
            status: res.status,
            provider: "deepseek",
            model,
            error: data.error?.message || data.message || "DeepSeek request failed",
            deepseek_error: data.error || data,
          });
        }
        const text = data?.choices?.[0]?.message?.content || "";
        return jsonResponse(200, {
          ok: true,
          provider: "deepseek",
          model,
          text: String(text).slice(0, 80),
        });
      } catch (err) {
        return jsonResponse(502, {
          ok: false,
          error: "Cannot reach DeepSeek: " + (err.message || String(err)),
        });
      }
    }

    // OTP / OAuth routes (с учётом возможного хвоста в path)
    const isAuthPath = (suffix) =>
      pathname === suffix || pathname.endsWith(suffix);

    if (isAuthPath("/auth/send-code") && httpMethod === "POST") {
      return await handleSendCode(body);
    }
    if (isAuthPath("/auth/verify-code") && httpMethod === "POST") {
      return await handleVerifyCode(body);
    }

    if ((isAuthPath("/auth/google") || pathname === "/auth") && httpMethod === "POST") {
      return await handleGoogleAuth(body);
    }
    if (isAuthPath("/auth/vk") && httpMethod === "POST") {
      return await handleVkAuth(body);
    }
    if (isAuthPath("/auth/logout") && httpMethod === "POST") {
      return await handleLogout();
    }

    if (pathname === "/get-user" && httpMethod === "GET") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const userId = query.id;
      if (!userId) return jsonResponse(400, { error: "No ID" });
      const forbid = forbidSelfOnly(auth.userId, userId);
      if (forbid) return forbid;

      // Важно: refillUsageOnPlanUpgrade здесь НЕ вызываем.
      // Refill только в /update-plan.
      const user = await getUserWithFreshUsage(userId);
      if (!user) return jsonResponse(404, { error: "Not found" });

      return jsonResponse(200, user);
    }

    if (pathname === "/update-plan" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const id = body?.id;
      const planType = body?.plan_type;
      if (!id) return jsonResponse(400, { error: "User ID is required" });
      const forbid = forbidSelfOnly(auth.userId, id);
      if (forbid) return forbid;
      if (!planType || !PLAN_LIMITS[planType]) {
        return jsonResponse(400, { error: "Invalid plan_type" });
      }

      const prev = await fetchUserById(id);
      if (!prev) return jsonResponse(404, { error: "Not found" });

      await neonQuery(`UPDATE users SET plan_type = $2 WHERE id = $1 RETURNING *`, [id, planType]);
      let user = await getUserWithFreshUsage(id);
      user = await refillUsageOnPlanUpgrade(user, prev.plan_type || "free");
      return jsonResponse(200, user);
    }

    if (pathname === "/save-user" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const user = body;
      if (!user?.id) return jsonResponse(400, { error: "User ID is required" });
      const forbid = forbidSelfOnly(auth.userId, user.id);
      if (forbid) return forbid;

      const queryText = `
        INSERT INTO users (id, email, name, picture, plan_type)
        VALUES ($1, $2, $3, $4, 'free')
        ON CONFLICT (id) DO UPDATE
        SET email = COALESCE($2, users.email),
            name = COALESCE($3, users.name),
            picture = COALESCE($4, users.picture)
        RETURNING *;
      `;
      const data = await neonQuery(queryText, [user.id, user.email, user.name, user.picture]);
      const fresh = await getUserWithFreshUsage(user.id);
      return jsonResponse(200, fresh || data.rows[0]);
    }

    if (pathname === "/increment-usage" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const id = body?.id;
      const type = body?.type;
      if (!id) return jsonResponse(400, { error: "User ID is required" });
      const forbid = forbidSelfOnly(auth.userId, id);
      if (forbid) return forbid;

      const usageType = type === "image" ? "image" : type === "quiz" ? "quiz" : "request";
      const result = await incrementUsageForUser(id, usageType);
      if (result.error) {
        return jsonResponse(result.status || 400, {
          error: result.error,
          code: result.code,
          // Актуальные счётчики из БД — клиент на другом устройстве синхронизирует UI
          ...(usageSnapshot(result.user) || {}),
        });
      }
      return jsonResponse(200, result.user);
    }

    if (pathname === "/decrement-usage" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const id = body?.id;
      const type = body?.type;
      if (!id) return jsonResponse(400, { error: "User ID is required" });
      const forbid = forbidSelfOnly(auth.userId, id);
      if (forbid) return forbid;

      const usageType = type === "image" ? "image" : type === "quiz" ? "quiz" : "request";
      const user = await decrementUsageForUser(id, usageType);
      if (!user) return jsonResponse(404, { error: "User not found" });
      return jsonResponse(200, user);
    }

    if (pathname === "/generate" && httpMethod === "POST") {
      const deepseekKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
      const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
      if (!deepseekKey) {
        return jsonResponse(500, {
          error: "DEEPSEEK_API_KEY not configured",
          provider: "deepseek",
          build: "2026-08-15-ds3",
        });
      }

      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const messages = body?.messages || [];
      const rawImage = body?.image;
      const image = (rawImage && typeof rawImage === "object" && rawImage.data && String(rawImage.data).length > 32)
        ? rawImage
        : null;
      // Всегда сессия — body.userId мог отличаться по типу (number vs string) и давать ложный 403.
      const userId = auth.userId;
      const bodyUserId = body?.userId || body?.user_id;
      if (bodyUserId != null && String(bodyUserId) !== String(userId)) {
        console.warn("[generate] body userId mismatch, using session:", bodyUserId, "vs", userId);
      }

      const user = await getUserWithFreshUsage(userId);
      if (!user) {
        return jsonResponse(404, { error: "User not found", provider: "deepseek" });
      }

      const skipUsageCharge = Boolean(body?.usageAlreadyCounted);
      // DeepSeek text model — картинки не отправляем в API (иначе ломает запрос).
      const chargeType = image ? "image" : "request";
      let usagePayload = usageSnapshot(user);

      // Списание ДО вызова DeepSeek (атомарно).
      if (!skipUsageCharge) {
        const usageResult = await incrementUsageForUser(userId, chargeType);
        if (usageResult.error) {
          return jsonResponse(usageResult.status || 400, {
            error: usageResult.error,
            code: usageResult.code,
            provider: "deepseek",
            usage: usageSnapshot(usageResult.user),
            ...(usageSnapshot(usageResult.user) || {}),
          });
        }
        usagePayload = usageSnapshot(usageResult.user);
      }

      // === ЛИМИТ ТОКЕНОВ: уважаем то, что просит фронтенд (app.js) ===
      const requestedTokens = Number(body?.maxOutputTokens ?? body?.max_tokens ?? 2048);
      const maxTokens = Math.max(256, Math.min(Number.isFinite(requestedTokens) ? requestedTokens : 2048, 8192));

      // OpenAI-совместимый формат для DeepSeek (только текст)
      const openaiMessages = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        let textContent = typeof msg.content === "string"
          ? msg.content
          : (msg.content?.[0]?.text || "");

        if (msg.role === "system") {
          if (textContent) openaiMessages.push({ role: "system", content: textContent });
          continue;
        }

        const role = msg.role === "assistant" ? "assistant" : "user";
        const isLastMessage = i === messages.length - 1;
        if (image && isLastMessage && role === "user") {
          textContent = (textContent || "Analyze image") +
            "\n\n[User attached an image. Vision is not available on this model — answer from the text only.]";
        }
        if (!textContent && role === "assistant") textContent = " ";
        openaiMessages.push({ role, content: textContent || " " });
      }

      if (!openaiMessages.length) {
        if (!skipUsageCharge) {
          const refunded = await decrementUsageForUser(userId, chargeType);
          if (refunded) usagePayload = usageSnapshot(refunded);
        }
        return jsonResponse(400, {
          error: "No messages to send to DeepSeek",
          provider: "deepseek",
          usage: usagePayload || undefined,
        });
      }

      let response;
      let data = {};
      try {
        response = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + deepseekKey,
          },
          body: JSON.stringify({
            model: deepseekModel,
            messages: openaiMessages,
            temperature: body?.temperature ?? 0.7,
            max_tokens: maxTokens,
            thinking: { type: "disabled" },
          }),
        });
        data = await response.json().catch(() => ({}));
      } catch (netErr) {
        console.error("[generate] DeepSeek network error:", netErr);
        if (!skipUsageCharge) {
          const refunded = await decrementUsageForUser(userId, chargeType);
          if (refunded) usagePayload = usageSnapshot(refunded);
        }
        return jsonResponse(502, {
          error: "[DeepSeek] Cannot reach API: " + (netErr.message || String(netErr)),
          message: "[DeepSeek] Cannot reach API: " + (netErr.message || String(netErr)),
          provider: "deepseek",
          build: "2026-08-15-ds3",
          usage: usagePayload || undefined,
        });
      }

      if (!response.ok || data.error) {
        if (!skipUsageCharge) {
          const refunded = await decrementUsageForUser(userId, chargeType);
          if (refunded) usagePayload = usageSnapshot(refunded);
        }
        const rawMsg =
          data.error?.message ||
          data.message ||
          (typeof data.error === "string" ? data.error : null) ||
          `HTTP ${response.status}`;
        const errMsg = "[DeepSeek] " + rawMsg;
        console.error("[generate] DeepSeek API error:", response.status, data.error || data);
        return jsonResponse(response.status || 500, {
          error: errMsg,
          message: errMsg,
          provider: "deepseek",
          model: deepseekModel,
          build: "2026-08-15-ds3",
          deepseek_error: data.error || data,
          usage: usagePayload || undefined,
        });
      }

      const text = data?.choices?.[0]?.message?.content || "Empty response from the model";

      return jsonResponse(200, {
        text,
        provider: "deepseek",
        model: deepseekModel,
        build: "2026-08-15-ds3",
        usage: usagePayload || undefined,
      });
    }

    if (pathname === "/save-chat" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const chat = body;
      if (!chat?.id || !chat?.user_id) return jsonResponse(400, { error: "Missing id or user_id" });
      const forbid = forbidSelfOnly(auth.userId, chat.user_id);
      if (forbid) return forbid;

      const queryText = `
        INSERT INTO chats (id, user_id, title, messages)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE
        SET title = $3, messages = $4, updated_at = CURRENT_TIMESTAMP;
      `;
      await neonQuery(queryText, [chat.id, chat.user_id, chat.title || "New Chat", JSON.stringify(chat)]);
      return jsonResponse(200, { success: true });
    }

    if (pathname === "/get-chats" && httpMethod === "GET") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const userId = query.user_id;
      if (!userId) return jsonResponse(400, { error: "Missing user_id" });
      const forbid = forbidSelfOnly(auth.userId, userId);
      if (forbid) return forbid;

      const queryText = `SELECT messages FROM chats WHERE user_id = $1 ORDER BY updated_at DESC;`;
      const data = await neonQuery(queryText, [userId]);

      const chats = data.rows.map((row) => typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages);
      return jsonResponse(200, { chats });
    }

    if (pathname === "/delete-chat" && httpMethod === "POST") {
      const auth = await requireAuth();
      if (auth.error) return auth.error;

      const forbid = forbidSelfOnly(auth.userId, body?.user_id);
      if (forbid) return forbid;

      await neonQuery(`DELETE FROM chats WHERE id = $1 AND user_id = $2`, [body?.id, body?.user_id]);
      return jsonResponse(200, { success: true });
    }

    return jsonResponse(404, { error: "Route not found" });
  } catch (err) {
    console.error("CRITICAL ERROR:", err);
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: err.message || "Internal server error" }),
    };
  }
};
