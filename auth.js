// Shared session helpers for Solf.ai API (Yandex Cloud Functions)
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
    }
}
