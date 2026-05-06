// REBWB auth helpers — magic-link JWT stored in localStorage.
const API_BASE = 'https://api.realestatewithoutbullshit.com';
const TOKEN_KEY = 'rebwb_jwt';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function isSignedIn() {
  return !!getToken();
}

async function apiFetch(path, init = {}) {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) clearToken();
  return res;
}

window.REBWB = { getToken, setToken, clearToken, isSignedIn, apiFetch, API_BASE };
