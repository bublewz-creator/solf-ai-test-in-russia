// Shared session helpers for Solf-ai API (Yandex Cloud Functions)
const SOLF_SESSION_KEY = 'solfai_session';

function getSolfSessionToken() {
    try {
        return localStorage.getItem(SOLF_SESSION_KEY) || '';
    } catch (_) {
        return '';
    }
}

function setSolfSessionToken(token) {
    try {
        if (token) localStorage.setItem(SOLF_SESSION_KEY, token);
        else localStorage.removeItem(SOLF_SESSION_KEY);
    } catch (_) {}
}

function solfAuthHeaders(extra = {}) {
    const headers = { ...extra };
    const token = getSolfSessionToken();
    if (token) {
        // Важно: НЕ слать Authorization на functions.yandexcloud.net —
        // Яндекс принимает его как IAM-токен и отвечает
        // {"errorMessage":"Forbidden: Not authorized"} ещё до нашей функции.
        // Сессия только через X-Auth-Token.
        headers['X-Auth-Token'] = token;
    }
    return headers;
}

/** URL для Yandex Function: путь только через ?path= (суффиксы /auth/... ломают functionID). */
function workerApi(path, query = {}) {
    const base = (typeof WORKER_URL !== 'undefined' && WORKER_URL)
        ? WORKER_URL
        : 'https://functions.yandexcloud.net/d4e2k40l9pmi9221vs4j';
    const u = new URL(base);
    const p = String(path || '/');
    u.searchParams.set('path', p.startsWith('/') ? p : '/' + p);
    Object.entries(query || {}).forEach(([k, v]) => {
        if (v != null && v !== '') u.searchParams.set(k, String(v));
    });
    return u.toString();
}

function clearSolfAuth() {
    setSolfSessionToken('');
    try { localStorage.removeItem('solfai_user'); } catch (_) {}
}

function storeSolfAuth(user, sessionToken) {
    if (sessionToken) setSolfSessionToken(sessionToken);
    if (user) {
        try { localStorage.setItem('solfai_user', JSON.stringify(user)); } catch (_) {}
        try { applyUiPrefsFromServer(user); } catch (_) {}
    }
}

const UI_PREF_ALLOWED = {
    color: ['default', 'blue', 'green', 'rose'],
    theme: ['default', 'light'],
    lang: ['en', 'ru', 'de', 'es', 'zh', 'ja'],
    font: ['sm', 'md', 'lg'],
};

function collectUiPrefs() {
    try {
        return {
            color: localStorage.getItem('solfai_color') || 'default',
            theme: localStorage.getItem('solfai_theme') || 'default',
            lang: localStorage.getItem('solfai_lang') || 'en',
            font: localStorage.getItem('solfai_font_size') || 'md',
        };
    } catch (_) {
        return { color: 'default', theme: 'default', lang: 'en', font: 'md' };
    }
}

let persistUiPrefsTimer = null;
let uiPrefsDirty = false;

function persistUiPrefs(immediate) {
    if (window.__solfSkipPrefPersist) return;
    if (typeof getSolfSessionToken !== 'function' || !getSolfSessionToken()) return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('solfai_user') || 'null'); } catch (_) {}
    if (!user?.id) return;
    uiPrefsDirty = true;
    clearTimeout(persistUiPrefsTimer);

    const send = () => {
        const payload = collectUiPrefs();
        fetch(workerApi('/save-prefs'), {
            method: 'POST',
            headers: solfAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
        }).then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (res.ok && data && data.ok !== false && !data.error && !data.skipped) {
                uiPrefsDirty = false;
            }
        }).catch(() => {});
    };

    if (immediate) send();
    else persistUiPrefsTimer = setTimeout(send, 250);
}

function applyUiPrefValue(kind, value) {
    if (kind === 'color') {
        localStorage.setItem('solfai_color', value);
        if (typeof setColor === 'function') setColor(value);
        else if (value === 'default') document.documentElement.removeAttribute('data-color');
        else document.documentElement.setAttribute('data-color', value);
        return;
    }
    if (kind === 'theme') {
        localStorage.setItem('solfai_theme', value);
        if (typeof setTheme === 'function') setTheme(value);
        else if (value === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
        return;
    }
    if (kind === 'lang') {
        localStorage.setItem('solfai_lang', value);
        if (typeof setLanguage === 'function') setLanguage(value);
        return;
    }
    localStorage.setItem('solfai_font_size', value);
    if (typeof setFontSize === 'function') setFontSize(value);
    else document.documentElement.setAttribute('data-font-size', value);
}

function applyUiPrefsFromServer(user) {
    if (!user) return;
    const hasServerPrefs = !!(user.ui_color || user.ui_theme || user.ui_lang || user.ui_font);
    if (!hasServerPrefs) {
        setTimeout(() => persistUiPrefs(), 0);
        return;
    }
    if (uiPrefsDirty) return;

    window.__solfSkipPrefPersist = true;
    try {
        if (UI_PREF_ALLOWED.color.includes(user.ui_color)) applyUiPrefValue('color', user.ui_color);
        if (UI_PREF_ALLOWED.theme.includes(user.ui_theme)) applyUiPrefValue('theme', user.ui_theme);
        if (UI_PREF_ALLOWED.lang.includes(user.ui_lang)) applyUiPrefValue('lang', user.ui_lang);
        if (UI_PREF_ALLOWED.font.includes(user.ui_font)) applyUiPrefValue('font', user.ui_font);
    } finally {
        window.__solfSkipPrefPersist = false;
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
        if (uiPrefsDirty) persistUiPrefs(true);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && uiPrefsDirty) persistUiPrefs(true);
    });
}
