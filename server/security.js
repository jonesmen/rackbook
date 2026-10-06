import { scrypt, randomBytes, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1 };
const KEYLEN = 64;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- Passwörter (scrypt, memory-hard) ----------
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { ...SCRYPT, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: 128 * +N * +r * 2 });
  return timingSafeEqual(expected, actual);
}

// Hash für nicht existierende Nutzer, damit Anmeldeversuche gleich lange dauern (keine Nutzer-Enumeration).
let dummyHash = null;
export async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

const COMMON = new Set(['password', 'passwort', '12345678', '123456789', '1234567890', 'qwertzuiop', 'qwertyuiop',
  'passwort123', 'password123', 'administrator', 'rackbook', 'letmein123', 'willkommen', 'hallo12345', 'iloveyou']);

export function validatePassword(pw, username) {
  if (typeof pw !== 'string') return 'Passwort fehlt.';
  if (pw.length < config.passwordMinLength) return `Das Passwort muss mindestens ${config.passwordMinLength} Zeichen lang sein.`;
  if (pw.length > 256) return 'Das Passwort ist zu lang (max. 256 Zeichen).';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'Dieses Passwort ist zu verbreitet.';
  if (username && lower.includes(String(username).toLowerCase())) return 'Das Passwort darf den Benutzernamen nicht enthalten.';
  if (new Set(pw).size < 5) return 'Das Passwort ist zu einfach.';
  return null;
}

// ---------- Tokens ----------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = s => createHash('sha256').update(s).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- Symmetrische Verschlüsselung (AES-256-GCM) ----------
export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.encKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unbekanntes Format');
  const d = createDecipheriv('aes-256-gcm', config.encKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// ---------- Signierte Kurzzeit-Tickets (z. B. 2FA-Zwischenschritt) ----------
export function signTicket(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, n: randomToken(8) })).toString('base64url');
  const mac = createHmac('sha256', config.hmacKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verifyTicket(ticket) {
  const [body, mac] = String(ticket || '').split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.hmacKey).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}
// Gibt den verwendeten Zeitschritt zurück (für Replay-Schutz) oder null.
export function verifyTotp(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d;
    if (step <= lastStep) continue;
    if (safeEqual(totpAt(secret, step), c)) return step;
  }
  return null;
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

// ---------- Rate-Limiting (In-Memory, Sliding Window) ----------
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit; this.windowMs = windowMs; this.hits = new Map();
    setInterval(() => this.sweep(), Math.min(windowMs, 60000)).unref();
  }
  hit(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length <= this.limit;
  }
  retryAfter(key) {
    const arr = this.hits.get(key) || [];
    return arr.length ? Math.ceil((arr[0] + this.windowMs - Date.now()) / 1000) : 0;
  }
  reset(key) { this.hits.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      const f = arr.filter(t => now - t < this.windowMs);
      if (f.length) this.hits.set(k, f); else this.hits.delete(k);
    }
  }
}

// ---------- HTTP-Sicherheitsheader ----------
// Erweiterungen der CSP (z. B. erlaubte Einbettungen), von der App zur Laufzeit gesetzt.
let cspExtra = () => ({ frame: [], img: [], media: [] });
export function setCspExtra(fn) { cspExtra = fn; }

export function securityHeaders(req, res, next) {
  const x = cspExtra();
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    ["img-src 'self' data: blob:", ...x.img].join(' '),
    ["media-src 'self' blob:", ...x.media].join(' '),
    ["frame-src 'self'", ...x.frame].join(' '),
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
