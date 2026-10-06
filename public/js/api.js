// Fetch-Wrapper: JSON, Cookies (same-origin) und CSRF-Header.
let csrf = null;
export const setCsrf = t => { csrf = t; };

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Fehler ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, { error: 'Server nicht erreichbar.' });
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
