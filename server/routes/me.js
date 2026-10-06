import { Router } from 'express';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { config } from '../config.js';
import {
  HttpError, hashPassword, verifyPassword, validatePassword, encrypt, decrypt, newTotpSecret, verifyTotp,
} from '../security.js';
import { audit, publicUser, revokeUserSessions } from '../auth.js';
import { cleanName } from './auth.js';

const r = Router();

// Erlaubte Nutzereinstellungen inkl. Validierung.
const SETTINGS = {
  livePreview: v => typeof v === 'boolean',
  wrap: v => typeof v === 'boolean',
  fontSize: v => [13, 14, 16].includes(v),
  accent: v => ['mint', 'blau', 'violett'].includes(v),
  startPage: v => ['dashboard', 'docs'].includes(v),
  sidebarCollapsed: v => typeof v === 'boolean',
  bmOpen: v => typeof v === 'boolean',
};

const load = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

r.get('/', (req, res) => res.json({ user: publicUser(load(req.user.id)), csrfToken: req.csrfToken }));

r.patch('/', (req, res) => {
  const u = load(req.user.id);
  const body = req.body || {};
  let displayName = u.display_name;
  if (body.displayName !== undefined) {
    displayName = cleanName(body.displayName);
    if (!displayName) throw new HttpError(400, 'Der Anzeigename darf nicht leer sein.');
  }
  const settings = JSON.parse(u.settings || '{}');
  if (body.settings && typeof body.settings === 'object') {
    for (const [k, v] of Object.entries(body.settings)) {
      if (!SETTINGS[k]) continue;
      if (!SETTINGS[k](v)) throw new HttpError(400, `Ungültiger Wert für ${k}.`);
      settings[k] = v;
    }
  }
  db.prepare('UPDATE users SET display_name = ?, settings = ?, updated_at = ? WHERE id = ?')
    .run(displayName, JSON.stringify(settings), Date.now(), u.id);
  res.json({ user: publicUser(load(u.id)) });
});

async function requirePassword(u, pw) {
  if (typeof pw !== 'string' || !(await verifyPassword(pw, u.password_hash))) {
    throw new HttpError(403, 'Das aktuelle Passwort ist falsch.');
  }
}

r.post('/password', async (req, res) => {
  const u = load(req.user.id);
  const { currentPassword, newPassword } = req.body || {};
  await requirePassword(u, currentPassword);
  const err = validatePassword(newPassword, u.username);
  if (err) throw new HttpError(400, err);
  if (await verifyPassword(newPassword, u.password_hash)) throw new HttpError(400, 'Das neue Passwort muss sich vom alten unterscheiden.');
  db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(await hashPassword(newPassword), Date.now(), Date.now(), u.id);
  revokeUserSessions(u.id, req.sessionId);
  audit(req, 'user.password_changed', u.username);
  res.json({ user: publicUser(load(u.id)) });
});

// ---------- Sitzungen ----------
r.get('/sessions', (req, res) => {
  const rows = db.prepare('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(req.user.id);
  res.json({
    sessions: rows.map(s => ({
      id: s.id.slice(0, 16), current: s.id === req.sessionId, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent,
    })),
  });
});

r.delete('/sessions/:id', (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{16}$/.test(id)) throw new HttpError(400, 'Ungültige Sitzung.');
  const n = db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ? AND id <> ?").run(req.user.id, id, req.sessionId).changes;
  if (!n) throw new HttpError(404, 'Sitzung nicht gefunden.');
  audit(req, 'session.revoked', req.user.username);
  res.json({ ok: true });
});

r.delete('/sessions', (req, res) => {
  revokeUserSessions(req.user.id, req.sessionId);
  audit(req, 'session.revoked_all', req.user.username);
  res.json({ ok: true });
});

// ---------- Zwei-Faktor-Authentifizierung (TOTP) ----------
r.post('/totp/setup', async (req, res) => {
  const u = load(req.user.id);
  if (u.totp_enabled) throw new HttpError(400, '2FA ist bereits aktiv.');
  const secret = newTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encrypt(secret), u.id);
  const label = encodeURIComponent(`${config.appName}:${u.username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}&algorithm=SHA1&digits=6&period=30`;
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  res.json({ secret, uri, qr });
});

r.post('/totp/enable', (req, res) => {
  const u = load(req.user.id);
  if (u.totp_enabled) throw new HttpError(400, '2FA ist bereits aktiv.');
  if (!u.totp_secret) throw new HttpError(400, 'Bitte die Einrichtung zuerst starten.');
  const step = verifyTotp(decrypt(u.totp_secret), req.body?.code, 0);
  if (step === null) throw new HttpError(400, 'Der Code ist ungültig. Uhrzeit des Geräts prüfen.');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?').run(step, Date.now(), u.id);
  revokeUserSessions(u.id, req.sessionId);
  audit(req, 'user.2fa_enabled', u.username);
  res.json({ user: publicUser(load(u.id)) });
});

r.post('/totp/disable', async (req, res) => {
  const u = load(req.user.id);
  if (!u.totp_enabled) throw new HttpError(400, '2FA ist nicht aktiv.');
  await requirePassword(u, req.body?.password);
  if (verifyTotp(decrypt(u.totp_secret), req.body?.code, u.totp_last_step) === null) throw new HttpError(400, 'Der Code ist ungültig.');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?').run(Date.now(), u.id);
  audit(req, 'user.2fa_disabled', u.username);
  res.json({ user: publicUser(load(u.id)) });
});

export default r;
