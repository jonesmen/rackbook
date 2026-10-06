import { Router } from 'express';
import { db, tx, getSetting } from '../db.js';
import { config } from '../config.js';
import {
  HttpError, RateLimiter, hashPassword, verifyPassword, dummyVerify, validatePassword,
  signTicket, verifyTicket, verifyTotp, decrypt,
} from '../security.js';
import { audit, clientIp, createSession, destroySession, publicUser } from '../auth.js';

const r = Router();
const limiter = new RateLimiter(config.rateLimitAuthPerWindow, config.rateLimitWindowMinutes * 60000);

function rateLimit(req, res, next) {
  const key = clientIp(req);
  if (!limiter.hit(key)) {
    res.setHeader('Retry-After', String(limiter.retryAfter(key)));
    return next(new HttpError(429, 'Zu viele Versuche. Bitte später erneut versuchen.'));
  }
  next();
}

export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
export const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

r.get('/state', (req, res) => {
  const setupRequired = userCount() === 0;
  res.json({
    appName: config.appName,
    setupRequired,
    registrationEnabled: setupRequired || !!getSetting('registration_enabled', config.allowRegistrationDefault),
    passwordMinLength: config.passwordMinLength,
    user: req.user || null,
    csrfToken: req.user ? req.csrfToken : null,
  });
});

r.post('/register', rateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  const displayName = cleanName(req.body?.displayName) || String(username || '');
  if (!USERNAME_RE.test(String(username || ''))) throw new HttpError(400, 'Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.');
  const pwErr = validatePassword(password, username);
  if (pwErr) throw new HttpError(400, pwErr);
  const hash = await hashPassword(password);

  // Transaktion, damit bei gleichzeitigen Registrierungen genau EIN Nutzer Admin wird.
  const result = tx(() => {
    const first = userCount() === 0;
    if (!first && !getSetting('registration_enabled', config.allowRegistrationDefault)) {
      throw new HttpError(403, 'Die Registrierung ist deaktiviert. Bitte einen Administrator um ein Konto bitten.');
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben.');
    }
    const role = first ? 'admin' : getSetting('default_role', config.defaultRole);
    const status = first || !getSetting('registration_requires_approval', config.requireApprovalDefault) ? 'active' : 'pending';
    const now = Date.now();
    const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at, password_changed_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(username, displayName, hash, role, status, now, now, now);
    return { id: Number(info.lastInsertRowid), first, status };
  });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.id);
  req.user = publicUser(user);
  audit(req, result.first ? 'setup.admin_created' : 'user.registered', username, { status: result.status });
  if (result.status !== 'active') {
    req.user = null;
    return res.status(202).json({ pending: true, message: 'Konto angelegt. Ein Administrator muss es noch freischalten.' });
  }
  const csrfToken = createSession(req, res, user);
  res.status(201).json({ user: publicUser(user), csrfToken });
});

async function checkCredentials(req, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || password.length > 256) {
    throw new HttpError(400, 'Benutzername und Passwort angeben.');
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const generic = new HttpError(401, 'Benutzername oder Passwort ist falsch.');
  if (!user) { await dummyVerify(password); audit(req, 'login.failed', username, { reason: 'unknown_user' }); throw generic; }
  if (user.locked_until > Date.now()) {
    await dummyVerify(password);
    audit(req, 'login.locked', username);
    throw new HttpError(423, `Konto vorübergehend gesperrt. Bitte in ${Math.ceil((user.locked_until - Date.now()) / 60000)} Minuten erneut versuchen.`);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const fails = user.failed_logins + 1;
    const lock = fails >= config.loginMaxAttempts ? Date.now() + config.loginLockMinutes * 60000 : 0;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
    audit(req, lock ? 'login.lockout' : 'login.failed', username, { reason: 'bad_password' });
    throw generic;
  }
  if (user.status === 'pending') throw new HttpError(403, 'Dein Konto wartet noch auf Freischaltung durch einen Administrator.');
  if (user.status !== 'active') { audit(req, 'login.failed', username, { reason: 'disabled' }); throw new HttpError(403, 'Dieses Konto ist deaktiviert.'); }
  return user;
}

r.post('/login', rateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  const user = await checkCredentials(req, username, password);
  if (user.totp_enabled) {
    const ticket = signTicket({ uid: user.id, pwc: user.password_changed_at, purpose: 'mfa' }, 5 * 60000);
    return res.json({ mfaRequired: true, ticket });
  }
  req.user = publicUser(user);
  const csrfToken = createSession(req, res, user);
  audit(req, 'login.success', user.username);
  res.json({ user: publicUser(user), csrfToken });
});

const mfaAttempts = new RateLimiter(5, 5 * 60000);
r.post('/login/mfa', rateLimit, (req, res) => {
  const t = verifyTicket(req.body?.ticket);
  if (!t || t.purpose !== 'mfa') throw new HttpError(401, 'Anmeldung abgelaufen. Bitte erneut anmelden.');
  if (!mfaAttempts.hit('u' + t.uid)) throw new HttpError(429, 'Zu viele falsche Codes. Bitte erneut anmelden.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(t.uid);
  if (!user || user.status !== 'active' || !user.totp_enabled || user.password_changed_at !== t.pwc) {
    throw new HttpError(401, 'Anmeldung abgelaufen. Bitte erneut anmelden.');
  }
  const step = verifyTotp(decrypt(user.totp_secret), req.body?.code, user.totp_last_step);
  if (step === null) {
    req.user = publicUser(user);
    audit(req, 'login.mfa_failed', user.username);
    throw new HttpError(401, 'Der Code ist ungültig.');
  }
  db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  mfaAttempts.reset('u' + t.uid);
  req.user = publicUser(user);
  const csrfToken = createSession(req, res, user);
  audit(req, 'login.success', user.username, { mfa: true });
  res.json({ user: publicUser(user), csrfToken });
});

r.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout', req.user.username);
  destroySession(req, res);
  res.json({ ok: true });
});

export default r;
