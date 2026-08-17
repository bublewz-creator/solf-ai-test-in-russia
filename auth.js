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

function persistUiPrefs() {
    if (window.__solfSkipPrefPersist) return;
    if (typeof getSolfSessionToken !== 'function' || !getSolfSessionToken()) return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('solfai_user') || 'null'); } catch (_) {}
    if (!user?.id) return;
    uiPrefsDirty = true;
    clearTimeout(persistUiPrefsTimer);
    persistUiPrefsTimer = setTimeout(() => {
        fetch(workerApi('/save-prefs'), {
            method: 'POST',
            headers: solfAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(collectUiPrefs()),
        }).then((res) => {
            if (res && res.ok) uiPrefsDirty = false;
        }).catch(() => {});
    }, 250);
}

function applyUiPrefsFromServer(user) {
    if (!user || uiPrefsDirty) return;
    const hasServerPrefs = !!(user.ui_color || user.ui_theme || user.ui_lang || user.ui_font);
    if (!hasServerPrefs) return;

    window.__solfSkipPrefPersist = true;
    try {
        if (UI_PREF_ALLOWED.color.includes(user.ui_color)) {
            localStorage.setItem('solfai_color', user.ui_color);
            if (typeof setColor === 'function') setColor(user.ui_color);
            else if (user.ui_color === 'default') document.documentElement.removeAttribute('data-color');
            else document.documentElement.setAttribute('data-color', user.ui_color);
        }
        if (UI_PREF_ALLOWED.theme.includes(user.ui_theme)) {
            localStorage.setItem('solfai_theme', user.ui_theme);
            if (typeof setTheme === 'function') setTheme(user.ui_theme);
            else if (user.ui_theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
        }
        if (UI_PREF_ALLOWED.lang.includes(user.ui_lang)) {
            localStorage.setItem('solfai_lang', user.ui_lang);
            if (typeof setLanguage === 'function') setLanguage(user.ui_lang);
        }
        if (UI_PREF_ALLOWED.font.includes(user.ui_font)) {
            localStorage.setItem('solfai_font_size', user.ui_font);
            if (typeof setFontSize === 'function') setFontSize(user.ui_font);
            else document.documentElement.setAttribute('data-font-size', user.ui_font);
        }
    } finally {
        window.__solfSkipPrefPersist = false;
    }
}
