// Zentrale Konfiguration – ausschließlich über Umgebungsvariablen (siehe .env).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const env = process.env;
// Ganzzahl aus der Umgebung; ungültige oder zu kleine Werte fallen auf den Standard zurück (mit Hinweis)
const int = (v, d, min = 0, name = '') => {
  if (v === undefined || v === '') return d;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min) { console.warn(`Konfiguration: ungültiger Wert ${name ? name + '=' : ''}${JSON.stringify(v)} – verwende ${d}.`); return d; }
  return n;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const dataDir = resolve(env.DATA_DIR || '/data');
mkdirSync(dataDir, { recursive: true });

// Schlüssel für die Verschlüsselung sensibler Felder (z. B. TOTP-Secrets).
// Wird APP_SECRET nicht gesetzt, wird einmalig ein zufälliger Schlüssel im Datenverzeichnis erzeugt.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (env.APP_SECRET) throw new Error('APP_SECRET muss mindestens 32 Zeichen lang sein.');
  const file = join(dataDir, '.app_secret');
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf8').trim();
    if (s.length < 32) throw new Error(`Die Schlüsseldatei ${file} ist leer oder beschädigt. Aus einem Backup wiederherstellen oder APP_SECRET setzen.`);
    return s;
  }
  const s = randomBytes(48).toString('base64url');
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();
const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
if (publicUrl) {
  let ok = false;
  try { ok = /^https?:$/.test(new URL(publicUrl).protocol); } catch { ok = false; }
  if (!ok) throw new Error(`PUBLIC_URL ist keine gültige Adresse: ${publicUrl} (erwartet z. B. https://doku.example.org)`);
}
const secret = loadSecret();

export const config = {
  port: int(env.PORT, 3000, 1, 'PORT'),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbFile: join(dataDir, 'rackbook.db'),
  publicUrl,
  // Optional: Die Ersteinrichtung (erster Administrator) verlangt dieses Token
  setupToken: env.SETUP_TOKEN || '',
  trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? false
    : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY)
    : /^(true|false)$/i.test(env.TRUST_PROXY) ? /^true$/i.test(env.TRUST_PROXY)
    : env.TRUST_PROXY,
  cookieSecure: cookieSecure === 'auto' ? 'auto' : bool(cookieSecure, true),
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 720, 1, 'SESSION_IDLE_MINUTES'),
  sessionMaxDays: int(env.SESSION_MAX_DAYS, 14, 1, 'SESSION_MAX_DAYS'),
  loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 5, 1, 'LOGIN_MAX_ATTEMPTS'),
  loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15, 1, 'LOGIN_LOCK_MINUTES'),
  rateLimitAuthPerWindow: int(env.RATE_LIMIT_AUTH, 20, 1, 'RATE_LIMIT_AUTH'),
  rateLimitWindowMinutes: int(env.RATE_LIMIT_WINDOW_MINUTES, 15, 1, 'RATE_LIMIT_WINDOW_MINUTES'),
  passwordMinLength: Math.max(8, int(env.PASSWORD_MIN_LENGTH, 10, 1, 'PASSWORD_MIN_LENGTH')),
  allowRegistrationDefault: bool(env.ALLOW_REGISTRATION, false),
  requireApprovalDefault: bool(env.REGISTRATION_REQUIRES_APPROVAL, true),
  defaultRole: ['viewer', 'editor'].includes(env.DEFAULT_ROLE) ? env.DEFAULT_ROLE : 'viewer',
  staleDaysDefault: int(env.STALE_DAYS, 90, 1, 'STALE_DAYS'),
  trashRetentionDays: int(env.TRASH_RETENTION_DAYS, 30, 0, 'TRASH_RETENTION_DAYS'),
  revisionLimit: int(env.REVISION_LIMIT, 50, 0, 'REVISION_LIMIT'),
  auditRetentionDays: int(env.AUDIT_RETENTION_DAYS, 365, 1, 'AUDIT_RETENTION_DAYS'),
  maxDocBytes: int(env.MAX_DOC_KB, 1024, 16, 'MAX_DOC_KB') * 1024,
  seedSampleDocs: bool(env.SEED_SAMPLE_DOCS, false),
  accessLog: bool(env.ACCESS_LOG, false),
  appName: env.APP_NAME || 'Rackbook',
  encKey: createHash('sha256').update('rackbook-enc:' + secret).digest(),
  hmacKey: createHash('sha256').update('rackbook-mac:' + secret).digest(),
};
