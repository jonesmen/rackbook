// Dateiablage für den Editor: Bilder, Videos, Audio, PDFs und beliebige Anhänge.
// Der Dateityp wird anhand der ersten Bytes bestimmt (nicht anhand von Name oder Client-Angabe);
// nur bekannte, unkritische Typen werden im Browser angezeigt, alles andere wird als Download ausgeliefert.
import { createWriteStream, mkdirSync, existsSync, unlinkSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Router } from 'express';
import { db, getSetting } from './db.js';
import { config } from './config.js';
import { HttpError, randomToken, safeEqual } from './security.js';
import { requireRole, audit } from './auth.js';
const ctrlStrip = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '');

export const EDITOR_DEFAULTS = {
  uploads: true, // Datei-Uploads erlaubt
  uploadMaxMb: 25, // maximale Dateigröße
  embeds: true, // externe Inhalte (YouTube, Figma, iframes, externe Bilder) erlauben
  drawioUrl: 'https://embed.diagrams.net', // Draw.io-Editor (öffentlich oder selbst gehostet)
};

export function getEditorSettings() {
  const s = { ...EDITOR_DEFAULTS, ...(getSetting('editor', {}) || {}) };
  s.uploadMaxMb = Math.min(2048, Math.max(1, Math.round(Number(s.uploadMaxMb) || EDITOR_DEFAULTS.uploadMaxMb)));
  s.uploads = !!s.uploads;
  s.embeds = !!s.embeds;
  s.drawioUrl = normDrawioUrl(s.drawioUrl) || '';
  return s;
}

// CSP-Ergänzungen aus den Editor-Einstellungen (kurz zwischengespeichert)
let cspCache = { at: 0, v: null };
export function invalidateCsp() { cspCache = { at: 0, v: null }; }
export function editorCspExtra() {
  if (cspCache.v && Date.now() - cspCache.at < 5000) return cspCache.v;
  let v = { frame: [], img: [], media: [] };
  try {
    const s = getEditorSettings();
    if (s.embeds) v = { frame: ['https:'], img: ['https:'], media: ['https:'] };
    else if (s.drawioUrl) v.frame.push(new URL(s.drawioUrl).origin);
  } catch { return v; } // Datenbank noch nicht bereit
  cspCache = { at: Date.now(), v };
  return v;
}

export function normDrawioUrl(v) {
  if (v === '' || v === null) return '';
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

export const filesDir = join(config.dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
const pathOf = id => join(filesDir, id.slice(0, 2), id);

// ---------- Typ-Erkennung ----------
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm', 'application/pdf']);

export function sniff(buf, name = '') {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const at = (off, str) => buf.length >= off + str.length && buf.toString('latin1', off, off + str.length) === str;
  if (buf[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav';
  if (at(0, '%PDF-')) return 'application/pdf';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, 'OggS')) return ['ogv', 'ogm'].includes(ext) ? 'video/ogg' : 'audio/ogg';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return ext === 'weba' ? 'audio/webm' : 'video/webm';
  if (at(4, 'ftyp')) {
    const brand = buf.toString('latin1', 8, 12);
    if (/^avi[fs]/.test(brand)) return 'image/avif';
    if (/^M4A|^M4B/.test(brand) || ['m4a', 'm4b'].includes(ext)) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (at(0, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ext === 'mp3')) return 'audio/mpeg';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^﻿/, '').trimStart();
  if ((ext === 'svg' || /^<(\?xml|svg|!--)/i.test(head)) && /<svg[\s>]/i.test(buf.toString('utf8', 0, Math.min(buf.length, 4096)))) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function normFileName(n) {
  const s = ctrlStrip(n).replace(/[/\\<>:"|?*]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180);
  return s || 'datei';
}

// ---------- Ablage ----------
export async function storeUpload(req, { name, docId, userId, maxBytes }) {
  const id = randomToken(15);
  mkdirSync(join(filesDir, id.slice(0, 2)), { recursive: true });
  const tmp = pathOf(id) + '.part';
  const hash = createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const fail = err => { req.unpipe(out); out.destroy(); try { unlinkSync(tmp); } catch { /* weg */ } reject(err); };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.pause(); fail(new HttpError(413, `Datei zu groß (max. ${Math.round(maxBytes / 1048576)} MB).`)); return; }
      hash.update(chunk);
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'Upload abgebrochen.')));
    out.on('error', fail);
    out.on('finish', resolve);
    req.pipe(out);
  });
  if (!size) { try { unlinkSync(tmp); } catch { /* weg */ } throw new HttpError(400, 'Die Datei ist leer.'); }
  const fh = await open(tmp, 'r');
  const head = Buffer.alloc(4096);
  const { bytesRead } = await fh.read(head, 0, 4096, 0);
  await fh.close();
  const mime = sniff(head.subarray(0, bytesRead), name);
  renameSync(tmp, pathOf(id));
  const row = { id, name: normFileName(name), mime, size, sha256: hash.digest('hex'), doc_id: docId || null, created_by: userId ?? null, created_at: Date.now() };
  db.prepare('INSERT INTO files (id, name, mime, size, sha256, doc_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name, row.mime, row.size, row.sha256, row.doc_id, row.created_by, row.created_at);
  return fileDto(row);
}

// Datei aus einem Puffer speichern (z. B. Upload über den MCP-Server)
export function storeBuffer(buf, { name, docId, userId }) {
  if (!buf || !buf.length) throw new HttpError(400, 'Die Datei ist leer.');
  const id = randomToken(15);
  mkdirSync(join(filesDir, id.slice(0, 2)), { recursive: true });
  writeFileSync(pathOf(id), buf, { mode: 0o600, flag: 'wx' });
  const row = {
    id, name: normFileName(name), mime: sniff(buf.subarray(0, 4096), name), size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'), doc_id: docId || null, created_by: userId ?? null, created_at: Date.now(),
  };
  db.prepare('INSERT INTO files (id, name, mime, size, sha256, doc_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.name, row.mime, row.size, row.sha256, row.doc_id, row.created_by, row.created_at);
  return fileDto(row);
}
export const getFileRow = id => (/^[A-Za-z0-9_-]{20}$/.test(String(id || '')) ? db.prepare('SELECT * FROM files WHERE id = ?').get(String(id)) : undefined);
export function readFileBuffer(id) {
  const p = pathOf(String(id));
  return existsSync(p) ? readFileSync(p) : null;
}
// Markdown, mit dem eine Datei in ein Dokument eingebunden wird
export function fileSnippet(f, caption) {
  if (f.mime.startsWith('image/')) return `![${String(caption || f.name.replace(/\.[a-z0-9]+$/i, '')).replace(/[[\]\n]/g, '')}](/files/${f.id})`;
  const kind = f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? 'audio' : f.mime === 'application/pdf' ? 'pdf' : 'file';
  return `::${kind} ${JSON.stringify({ src: `/files/${f.id}`, name: f.name, size: f.size })}`;
}

export const fileDto = f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/files/${f.id}`, created: f.created_at });

// ---------- Signierte Links (für öffentliche Freigaben ohne Sitzung) ----------
// Gültigkeit auf volle Stunden gerundet, damit Browser-Caches greifen.
const fileMac = (id, exp) => createHmac('sha256', config.hmacKey).update(`file:${id}:${exp}`).digest('base64url').slice(0, 32);
export function signedFileUrl(id) {
  const exp = Math.ceil(Date.now() / 3600000) * 3600000 + 6 * 3600000;
  return `/files/${id}?e=${exp}&s=${fileMac(id, exp)}`;
}
function validSignature(id, e, sig) {
  const exp = Number(e);
  return Number.isFinite(exp) && exp > Date.now() && typeof sig === 'string' && safeEqual(sig, fileMac(id, exp));
}

// Alle /files/<id>-Verweise in einem Text
// Kein \b am Ende: IDs dürfen auf „-“ enden (base64url)
export const FILE_REF = /\/files\/([A-Za-z0-9_-]{20})(?![A-Za-z0-9_-])/g;
export function fileRefs(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(FILE_REF)) out.add(m[1]);
  return out;
}

export function deleteFile(id) {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  try { unlinkSync(pathOf(id)); } catch { /* bereits weg */ }
}

// Dateien, auf die nichts mehr verweist (auch keine Version und kein Papierkorb), nach einem Tag löschen.
export function cleanupFiles() {
  const cutoff = Date.now() - 86400000;
  const rows = db.prepare('SELECT id FROM files WHERE created_at < ?').all(cutoff);
  if (!rows.length) return 0;
  const used = new Set();
  for (const r of db.prepare('SELECT content FROM documents').iterate()) fileRefs(r.content).forEach(x => used.add(x));
  for (const r of db.prepare('SELECT content FROM revisions').iterate()) fileRefs(r.content).forEach(x => used.add(x));
  for (const r of db.prepare('SELECT content FROM synced_blocks').iterate()) fileRefs(r.content).forEach(x => used.add(x));
  let n = 0;
  for (const r of rows) if (!used.has(r.id)) { deleteFile(r.id); n++; }
  return n;
}

// Für Backups
export function exportFiles() {
  return db.prepare('SELECT * FROM files ORDER BY created_at').all().filter(f => existsSync(pathOf(f.id))).map(f => ({
    id: f.id, name: f.name, mime: f.mime, size: f.size, doc: f.doc_id, created: f.created_at, data: readFileSync(pathOf(f.id)).toString('base64'),
  }));
}
export function importFile(f, userId) {
  if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{20}$/.test(f.id) || typeof f.data !== 'string') return false;
  const buf = Buffer.from(f.data, 'base64');
  if (!buf.length) return false;
  mkdirSync(join(filesDir, f.id.slice(0, 2)), { recursive: true });
  writeFileSync(pathOf(f.id), buf, { mode: 0o600 });
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, doc_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, mime = excluded.mime, size = excluded.size, sha256 = excluded.sha256`)
    .run(f.id, normFileName(f.name), sniff(buf.subarray(0, 4096), f.name), buf.length, createHash('sha256').update(buf).digest('hex'),
      typeof f.doc === 'string' ? f.doc : null, userId ?? null, Number(f.created) || Date.now());
  return true;
}

// ---------- Routen ----------
// API (angemeldet): Upload und Metadaten
export const fileApi = Router();

fileApi.post('/', requireRole('editor'), async (req, res) => {
  const s = getEditorSettings();
  if (!s.uploads) throw new HttpError(403, 'Datei-Uploads sind deaktiviert.');
  if (req.is('application/json')) throw new HttpError(400, 'Datei als Rohdaten senden.');
  const len = Number(req.get('content-length') || 0);
  const maxBytes = s.uploadMaxMb * 1048576;
  if (len > maxBytes) throw new HttpError(413, `Datei zu groß (max. ${s.uploadMaxMb} MB).`);
  const name = String(req.query.name || 'datei');
  const docId = req.query.doc && db.prepare('SELECT id FROM documents WHERE id = ?').get(String(req.query.doc)) ? String(req.query.doc) : null;
  const file = await storeUpload(req, { name, docId, userId: req.user.id, maxBytes });
  audit(req, 'file.uploaded', file.id, { name: file.name, size: file.size, mime: file.mime });
  res.status(201).json({ file });
});

fileApi.get('/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.id));
  if (!f) throw new HttpError(404, 'Datei nicht gefunden.');
  res.json({ file: fileDto(f) });
});

// Auslieferung: angemeldet (Sitzung) oder mit signiertem Link aus einer Freigabe
export function serveFile(req, res, next) {
  const id = String(req.params.id || '');
  const signed = req.query.s !== undefined && validSignature(id, req.query.e, req.query.s);
  const allowed = (req.user && !req.user.mustChangePassword) || signed;
  if (!allowed) return next(new HttpError(req.user || req.query.s ? 403 : 401, 'Kein Zugriff auf diese Datei.'));
  const f = /^[A-Za-z0-9_-]{20}$/.test(id) && db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!f || !existsSync(pathOf(f.id))) return next(new HttpError(404, 'Datei nicht gefunden.'));
  const inline = INLINE.has(f.mime) && req.query.download === undefined;
  const type = INLINE.has(f.mime) ? f.mime : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Eigene, sehr enge CSP: SVGs dürfen kein Skript ausführen; PDFs dürfen nur in Rackbook eingebettet werden.
  res.setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; frame-ancestors 'self'${f.mime === 'application/pdf' ? '' : '; sandbox'}`);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(pathOf(f.id), { dotfiles: 'deny', lastModified: false, headers: {} }, err => {
    if (err && !res.headersSent) next(err);
  });
}

export function fileStats() {
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get();
  return { count: r.n, bytes: r.bytes };
}

