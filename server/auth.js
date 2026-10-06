import { db } from './db.js';
import { config } from './config.js';
import { HttpError, randomToken, sha256, safeEqual } from './security.js';

export const COOKIE = 'rb_session';
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

export function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function audit(req, action, target, details) {
  const u = req?.user;
  db.prepare('INSERT INTO audit_log (ts, user_id, username, action, target, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), u?.id ?? null, u?.username ?? null, action, target ?? null, req ? clientIp(req) : null,
      details === undefined ? null : JSON.stringify(details));
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieSecure(req) {
  return config.cookieSecure === 'auto' ? !!req.secure : config.cookieSecure;
}

function setCookie(req, res, value, maxAgeSec) {
  const secure = cookieSecure(req);
  // __Host- Präfix nur bei HTTPS: erzwingt Secure, Path=/ und keine Domain.
  const name = secure ? `__Host-${COOKIE}` : COOKIE;
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function createSession(req, res, user) {
  const token = randomToken(32);
  const now = Date.now();
  const csrf = randomToken(24);
  const expires = now + config.sessionMaxDays * 86400000;
  db.prepare(`INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), user.id, csrf, now, now, expires, clientIp(req), String(req.get('user-agent') || '').slice(0, 300));
  db.prepare('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = 0 WHERE id = ?').run(now, user.id);
  setCookie(req, res, token, config.sessionMaxDays * 86400);
  return csrf;
}

export function destroySession(req, res) {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  setCookie(req, res, '', 0);
}

export function revokeUserSessions(userId, exceptSessionId = null) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId);
}

// Lädt Sitzung + Nutzer aus dem Cookie. Idle- und absolutes Timeout werden geprüft.
export function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[`__Host-${COOKIE}`] || cookies[COOKIE];
  if (!token || token.length > 100) return next();
  const id = sha256(token);
  const row = db.prepare(`SELECT s.id AS sid, s.csrf_token, s.last_seen_at, s.expires_at, u.*
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id);
  if (!row) return next();
  const now = Date.now();
  if (row.expires_at < now || now - row.last_seen_at > config.sessionIdleMinutes * 60000 || row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    setCookie(req, res, '', 0);
    return next();
  }
  if (now - row.last_seen_at > 60000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
  req.sessionId = id;
  req.csrfToken = row.csrf_token;
  req.user = publicUser(row);
  next();
}

export function publicUser(u) {
  let settings = {};
  try { settings = JSON.parse(u.settings || '{}'); } catch { /* ignore */ }
  return {
    id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status,
    totpEnabled: !!u.totp_enabled, mustChangePassword: !!u.must_change_password,
    hasPassword: String(u.password_hash || '').startsWith('scrypt$'),
    sso: !!db.prepare('SELECT 1 FROM user_identities WHERE user_id = ?').get(u.id),
    createdAt: u.created_at, lastLoginAt: u.last_login_at ?? null, settings,
  };
}

// CSRF-Schutz: SameSite=Strict-Cookie + Origin-Prüfung + Synchronizer-Token im Header.
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try {
      const o = new URL(origin);
      if (config.publicUrl) ok = o.origin === new URL(config.publicUrl).origin;
      else ok = o.host === req.get('host');
    } catch { ok = false; }
    if (!ok) return next(new HttpError(403, 'Ungültige Herkunft der Anfrage.'));
  }
  if (req.user) {
    const t = req.get('x-csrf-token');
    if (!t || !safeEqual(t, req.csrfToken)) return next(new HttpError(403, 'Ungültiges CSRF-Token. Bitte Seite neu laden.'));
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Nicht angemeldet.'));
  if (req.user.mustChangePassword && !req.path.startsWith('/me')) {
    return next(new HttpError(403, 'Bitte zuerst das Passwort ändern.', { code: 'must_change_password' }));
  }
  next();
}

export const requireRole = role => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Nicht angemeldet.'));
  if ((ROLE_RANK[req.user.role] || 0) < ROLE_RANK[role]) return next(new HttpError(403, 'Keine Berechtigung für diese Aktion.'));
  next();
};
