// Magic-link auth shim. Backwards-compatible API for pages that previously used Supabase.
// Token lives in localStorage; the Worker (workers/api.js) verifies it on every request.

const REBWB_API_BASE = 'https://api.realestatewithoutbullshit.com';
const REBWB_TOKEN_KEY = 'rebwb_jwt';

function _getToken() {
    return localStorage.getItem(REBWB_TOKEN_KEY);
}

function _clearToken() {
    localStorage.removeItem(REBWB_TOKEN_KEY);
}

async function _apiFetch(path, init = {}) {
    const token = _getToken();
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${REBWB_API_BASE}${path}`, { ...init, headers });
    if (res.status === 401) _clearToken();
    return res;
}

async function getSession() {
    const token = _getToken();
    return token ? { access_token: token } : null;
}

async function getCurrentUser() {
    if (!_getToken()) return null;
    try {
        const res = await _apiFetch('/api/me');
        if (!res.ok) return null;
        const { user } = await res.json();
        return user;
    } catch {
        return null;
    }
}

async function isLoggedIn() {
    return !!_getToken();
}

async function requireAuth() {
    if (!_getToken()) {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
        return false;
    }
    return true;
}

async function signOut() {
    _clearToken();
    window.location.href = '/';
}

async function updateNavForAuth() {
    const loggedIn = await isLoggedIn();
    document.querySelectorAll('.auth-nav-item').forEach(el => {
        el.style.display = loggedIn ? 'block' : 'none';
    });
    document.querySelectorAll('.login-nav-item').forEach(el => {
        el.style.display = loggedIn ? 'none' : 'block';
    });
}

// Password-based functions removed in magic-link migration.
async function signIn() { throw new Error('Password auth removed. Sign in at /login.html'); }
async function signUp() { throw new Error('Password auth removed. Sign up at /signup.html'); }
async function resetPassword() { throw new Error('Magic-link auth has no passwords.'); }
async function updatePassword() { throw new Error('Magic-link auth has no passwords.'); }
