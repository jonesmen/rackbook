// Zentrale Konfiguration – ausschließlich über Umgebungsvariablen (siehe .env).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

const dataDir = resolve(env.DATA_DIR || '/data');
mkdirSync(dataDir, { recursive: true });

// Schlüssel für die Verschlüsselung sensibler Felder (z. B. TOTP-Secrets).
// Wird APP_SECRET nicht gesetzt, wird einmalig ein zufälliger Schlüssel im Datenverzeichnis erzeugt.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (env.APP_SECRET) throw new Error('APP_SECRET muss mindestens 32 Zeichen lang sein.');
  const file = join(dataDir, '.app_secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = randomBytes(48).toString('base64url');
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();
const secret = loadSecret();

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbFile: join(dataDir, 'rackbook.db'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? false
    : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY)
    : /^(true|false)$/i.test(env.TRUST_PROXY) ? /^true$/i.test(env.TRUST_PROXY)
    : env.TRUST_PROXY,
  cookieSecure: cookieSecure === 'auto' ? 'auto' : bool(cookieSecure, true),
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 720),
  sessionMaxDays: int(env.SESSION_MAX_DAYS, 14),
  loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 5),
  loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
  rateLimitAuthPerWindow: int(env.RATE_LIMIT_AUTH, 20),
  rateLimitWindowMinutes: int(env.RATE_LIMIT_WINDOW_MINUTES, 15),
  passwordMinLength: Math.max(8, int(env.PASSWORD_MIN_LENGTH, 10)),
  allowRegistrationDefault: bool(env.ALLOW_REGISTRATION, false),
  requireApprovalDefault: bool(env.REGISTRATION_REQUIRES_APPROVAL, true),
  defaultRole: ['viewer', 'editor'].includes(env.DEFAULT_ROLE) ? env.DEFAULT_ROLE : 'viewer',
  staleDaysDefault: int(env.STALE_DAYS, 90),
  trashRetentionDays: int(env.TRASH_RETENTION_DAYS, 30),
  revisionLimit: int(env.REVISION_LIMIT, 50),
  auditRetentionDays: int(env.AUDIT_RETENTION_DAYS, 365),
  maxDocBytes: int(env.MAX_DOC_KB, 1024) * 1024,
  seedSampleDocs: bool(env.SEED_SAMPLE_DOCS, false),
  appName: env.APP_NAME || 'Rackbook',
  encKey: createHash('sha256').update('rackbook-enc:' + secret).digest(),
  hmacKey: createHash('sha256').update('rackbook-mac:' + secret).digest(),
};
