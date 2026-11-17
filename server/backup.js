// Vollständige Sicherungen: ein Archiv (tar.gz) mit einem konsistenten Abbild der Datenbank und allen Dateien.
// Im Unterschied zum JSON-Export enthält es alles (Benutzer, Freigaben, Versionen, Einstellungen) und wird
// gestreamt geschrieben – unabhängig von der Datenmenge und ohne alles in den Arbeitsspeicher zu laden.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, openSync, writeSync, closeSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Router } from 'express';
import { db, getSetting, setSetting, SCHEMA_VERSION } from './db.js';
import { config } from './config.js';
import { HttpError, randomToken } from './security.js';
import { audit } from './auth.js';
import { filesDir } from './files.js';

export const backupDir = join(config.dataDir, 'backups');
const NAME_RE = /^rackbook-(auto|manuell|upload)-\d{8}-\d{6}(-[a-z0-9]{1,6})?\.tar\.gz$/;
const FILE_ID = /^[A-Za-z0-9_-]{20}$/;
const secretFile = join(config.dataDir, '.app_secret');

export const BACKUP_DEFAULTS = { schedule: 'daily', keep: 5 };
export function getBackupSettings() {
  const s = { ...BACKUP_DEFAULTS, ...(getSetting('backup', {}) || {}) };
  if (!['off', 'daily', 'weekly'].includes(s.schedule)) s.schedule = BACKUP_DEFAULTS.schedule;
  s.keep = Math.min(60, Math.max(1, Math.round(Number(s.keep) || BACKUP_DEFAULTS.keep)));
  return s;
}

// ---------- tar (ustar) ----------
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.fill(' ', 148, 156);
  h.write('0', 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = n => (512 - (n % 512)) % 512;

async function write(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}
async function addBuffer(out, name, buf) {
  await write(out, tarHeader(name, buf.length, Date.now()));
  await write(out, buf);
  if (pad(buf.length)) await write(out, Buffer.alloc(pad(buf.length)));
}
async function addFile(out, name, path) {
  const st = statSync(path);
  await write(out, tarHeader(name, st.size, st.mtimeMs));
  let n = 0;
  for await (const chunk of createReadStream(path)) { n += chunk.length; await write(out, chunk); }
  if (n !== st.size) throw new Error(`Datei ${name} hat sich während der Sicherung geändert.`);
  if (pad(n)) await write(out, Buffer.alloc(pad(n)));
}

// Archiv lesen: ruft onEntry(name, size) auf; dessen Rückgabe ist ein Dateideskriptor (Zahl), 'buffer' oder null (überspringen)
async function readTar(path, onEntry) {
  const src = createReadStream(path).pipe(createGunzip());
  let buf = Buffer.alloc(0), cur = null, left = 0, skip = 0;
  const out = {};
  for await (const chunk of src) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (cur) {
        const take = Math.min(left, buf.length);
        if (take) {
          if (typeof cur.sink === 'number') writeSync(cur.sink, buf, 0, take);
          else if (cur.sink === 'buffer') cur.parts.push(buf.subarray(0, take));
          buf = buf.subarray(take); left -= take;
        }
        if (left) break;
        if (typeof cur.sink === 'number') closeSync(cur.sink);
        if (cur.sink === 'buffer') out[cur.name] = Buffer.concat(cur.parts);
        skip = pad(cur.size); cur = null;
      }
      if (skip) { const t = Math.min(skip, buf.length); buf = buf.subarray(t); skip -= t; if (skip) break; }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every(b => b === 0)) continue; // Endmarkierung
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/[\0 ]/g, ''), 8);
      if (!Number.isFinite(size) || size < 0) throw new HttpError(400, 'Das Archiv ist beschädigt.');
      cur = { name, size, sink: onEntry(name, size), parts: [] };
      left = size;
    }
  }
  if (cur || skip) throw new HttpError(400, 'Das Archiv ist unvollständig.');
  return out;
}

// ---------- Sicherung anlegen ----------
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
let running = null;

export function createSnapshot(kind = 'manuell') {
  if (running) return running;
  running = (async () => {
    mkdirSync(backupDir, { recursive: true });
    const name = `rackbook-${kind}-${stamp()}.tar.gz`;
    const target = join(backupDir, name), part = target + '.part';
    const snap = join(backupDir, `.snap-${randomToken(6)}.db`);
    try {
      // Konsistentes Abbild der Datenbank (auch während des Betriebs)
      db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      const files = db.prepare('SELECT id FROM files ORDER BY id').all().map(f => f.id).filter(id => existsSync(join(filesDir, id.slice(0, 2), id)));
      const gz = createGzip({ level: 6 });
      const file = createWriteStream(part, { mode: 0o600 });
      const done = once(file, 'finish');
      gz.pipe(file);
      await addBuffer(gz, 'manifest.json', Buffer.from(JSON.stringify({ app: 'rackbook', format: 'snapshot-1', createdAt: Date.now(), schema: SCHEMA_VERSION, files: files.length, hasSecret: existsSync(secretFile) })));
      await addFile(gz, 'rackbook.db', snap);
      // Schlüssel für verschlüsselte Felder (2FA, SSO) – nötig, um die Sicherung auf einem anderen System einzuspielen
      if (existsSync(secretFile)) await addBuffer(gz, 'app_secret', readFileSync(secretFile));
      for (const id of files) await addFile(gz, 'files/' + id, join(filesDir, id.slice(0, 2), id));
      await write(gz, Buffer.alloc(1024));
      gz.end();
      await done;
      renameSync(part, target);
      setSetting('backup_last', { at: Date.now(), name, ok: true });
      return { name, size: statSync(target).size, created: Date.now() };
    } catch (e) {
      try { unlinkSync(part); } catch { /* nicht vorhanden */ }
      setSetting('backup_last', { at: Date.now(), ok: false, error: String(e.message || e).slice(0, 200) });
      throw e;
    } finally {
      try { unlinkSync(snap); } catch { /* nicht vorhanden */ }
    }
  })().finally(() => { running = null; });
  return running;
}

export function listSnapshots() {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir).filter(n => NAME_RE.test(n)).map(n => {
    const st = statSync(join(backupDir, n));
    return { name: n, size: st.size, created: st.mtimeMs, kind: n.split('-')[1] };
  }).sort((a, b) => b.created - a.created);
}

function freeBytes() {
  try { const s = statfsSync(config.dataDir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// Automatische Sicherung nach Zeitplan; alte automatische Sicherungen entfernen
export async function scheduledBackup() {
  const s = getBackupSettings();
  // Reste abgebrochener Läufe
  if (existsSync(backupDir) && !running) for (const n of readdirSync(backupDir)) if (/\.part$|^\.snap-/.test(n)) { try { rmSync(join(backupDir, n), { force: true }); } catch { /* egal */ } }
  if (s.schedule === 'off') return null;
  const list = listSnapshots();
  const last = list.filter(x => x.kind === 'auto')[0];
  const every = s.schedule === 'weekly' ? 7 * 86400000 : 86400000;
  let made = null;
  if (!last || Date.now() - last.created > every - 30 * 60000) {
    const need = (list[0] ? list[0].size : 0) * 2 + 50 * 1048576;
    const free = freeBytes();
    if (free !== null && free < need) {
      setSetting('backup_last', { at: Date.now(), ok: false, error: 'Zu wenig freier Speicherplatz für die automatische Sicherung.' });
      console.warn('Automatische Sicherung übersprungen: zu wenig freier Speicherplatz.');
    } else made = await createSnapshot('auto');
  }
  listSnapshots().filter(x => x.kind === 'auto').slice(s.keep).forEach(x => { try { unlinkSync(join(backupDir, x.name)); } catch { /* egal */ } });
  return made;
}

// ---------- Wiederherstellen ----------
// Archiv prüfen und nach DATA_DIR/restore-tmp entpacken. Liefert das Manifest.
async function unpack(path) {
  const tmp = join(config.dataDir, 'restore-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'files'), { recursive: true });
  const got = await readTar(path, (name, size) => {
    if (name === 'manifest.json' || name === 'app_secret') { if (size > 65536) throw new HttpError(400, 'Das Archiv ist ungültig.'); return 'buffer'; }
    if (name === 'rackbook.db') return openSync(join(tmp, 'rackbook.db'), 'w', 0o600);
    const m = name.match(/^files\/(.+)$/);
    if (m && FILE_ID.test(m[1])) { mkdirSync(join(tmp, 'files', m[1].slice(0, 2)), { recursive: true }); return openSync(join(tmp, 'files', m[1].slice(0, 2), m[1]), 'w', 0o600); }
    return null; // Unbekanntes ignorieren (keine Pfade außerhalb des Zielordners)
  });
  let manifest;
  try { manifest = JSON.parse(String(got['manifest.json'])); } catch { manifest = null; }
  if (!manifest || manifest.app !== 'rackbook' || manifest.format !== 'snapshot-1' || !existsSync(join(tmp, 'rackbook.db'))) throw new HttpError(400, 'Das ist keine Rackbook-Sicherung.');
  // Datenbank prüfen
  let check;
  try {
    check = new DatabaseSync(join(tmp, 'rackbook.db'), { readOnly: true });
    const v = check.prepare('PRAGMA user_version').get().user_version;
    if (v > SCHEMA_VERSION) throw new HttpError(409, 'Die Sicherung stammt von einer neueren Rackbook-Version. Bitte zuerst Rackbook aktualisieren.');
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || !check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) throw new HttpError(400, 'Die Datenbank in der Sicherung ist beschädigt.');
    manifest.users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    manifest.documents = check.prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL').get().n;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Die Datenbank in der Sicherung ist nicht lesbar.');
  } finally { try { check && check.close(); } catch { /* egal */ } }
  return { tmp, manifest, secret: got.app_secret || null };
}

// Aktuellen Stand durch die Sicherung ersetzen. Danach muss der Prozess neu starten (macht der Aufrufer).
export async function restoreSnapshot(path) {
  const { tmp, manifest, secret } = await unpack(path);
  const old = join(config.dataDir, 'before-restore');
  rmSync(old, { recursive: true, force: true });
  mkdirSync(old, { recursive: true });
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* egal */ }
  db.close();
  // Bisherigen Stand aufheben (eine Generation), dann tauschen
  renameSync(config.dbFile, join(old, 'rackbook.db'));
  for (const ext of ['-wal', '-shm']) rmSync(config.dbFile + ext, { force: true });
  if (existsSync(filesDir)) renameSync(filesDir, join(old, 'files'));
  renameSync(join(tmp, 'rackbook.db'), config.dbFile);
  renameSync(join(tmp, 'files'), filesDir);
  if (secret && !process.env.APP_SECRET) {
    if (existsSync(secretFile)) copyFileSync(secretFile, join(old, '.app_secret'));
    const fd = openSync(secretFile, 'w', 0o600); writeSync(fd, secret); closeSync(fd);
  }
  rmSync(tmp, { recursive: true, force: true });
  return manifest;
}

// ---------- Routen (nur Admin, eingehängt unter /api/admin/snapshots) ----------
export const snapshotApi = Router();
const pathFor = name => { if (!NAME_RE.test(String(name))) throw new HttpError(404, 'Sicherung nicht gefunden.'); const p = join(backupDir, name); if (!existsSync(p)) throw new HttpError(404, 'Sicherung nicht gefunden.'); return p; };

snapshotApi.get('/', (req, res) => {
  const list = listSnapshots();
  res.json({
    snapshots: list, settings: getBackupSettings(), last: getSetting('backup_last', null), running: !!running,
    disk: { free: freeBytes(), backups: list.reduce((n, x) => n + x.size, 0) }, dir: backupDir,
  });
});
snapshotApi.put('/settings', (req, res) => {
  const b = req.body || {}, cur = getBackupSettings();
  if (b.schedule !== undefined) { if (!['off', 'daily', 'weekly'].includes(b.schedule)) throw new HttpError(400, 'Ungültiger Zeitplan.'); cur.schedule = b.schedule; }
  if (b.keep !== undefined) { const n = Math.round(Number(b.keep)); if (!(n >= 1 && n <= 60)) throw new HttpError(400, 'Es müssen zwischen 1 und 60 Sicherungen aufbewahrt werden.'); cur.keep = n; }
  setSetting('backup', cur);
  audit(req, 'admin.backup_settings', null, cur);
  res.json({ settings: getBackupSettings() });
});
snapshotApi.post('/', async (req, res) => {
  const s = await createSnapshot('manuell');
  audit(req, 'admin.snapshot_created', s.name, { size: s.size });
  res.status(201).json({ snapshot: s });
});
// Sicherung hochladen (Rohdaten) – wird geprüft und in die Liste aufgenommen
snapshotApi.post('/upload', async (req, res) => {
  if (req.is('application/json')) throw new HttpError(400, 'Archiv als Rohdaten senden.');
  mkdirSync(backupDir, { recursive: true });
  const name = `rackbook-upload-${stamp()}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}.tar.gz`;
  const part = join(backupDir, name + '.part');
  try {
    const out = createWriteStream(part, { mode: 0o600 });
    for await (const chunk of req) await write(out, chunk);
    out.end();
    await once(out, 'finish');
    const { tmp, manifest } = await unpack(part);
    rmSync(tmp, { recursive: true, force: true });
    renameSync(part, join(backupDir, name));
    audit(req, 'admin.snapshot_uploaded', name, { documents: manifest.documents });
    res.status(201).json({ snapshot: { name, size: statSync(join(backupDir, name)).size, created: Date.now(), kind: 'upload' }, manifest });
  } catch (e) {
    try { unlinkSync(part); } catch { /* nicht vorhanden */ }
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Die Datei ist keine gültige Rackbook-Sicherung.');
  }
});
snapshotApi.get('/:name', (req, res, next) => {
  const p = pathFor(req.params.name);
  audit(req, 'admin.snapshot_downloaded', req.params.name);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.sendFile(p, { dotfiles: 'deny' }, err => { if (err && !res.headersSent) next(err); });
});
snapshotApi.delete('/:name', (req, res) => {
  unlinkSync(pathFor(req.params.name));
  audit(req, 'admin.snapshot_deleted', req.params.name);
  res.json({ ok: true });
});
// Wiederherstellen: ersetzt den gesamten Datenbestand und startet den Server neu
snapshotApi.post('/:name/restore', async (req, res) => {
  const p = pathFor(req.params.name);
  if (req.body?.confirm !== 'WIEDERHERSTELLEN') throw new HttpError(400, 'Bitte die Wiederherstellung bestätigen.');
  audit(req, 'admin.snapshot_restored', req.params.name);
  const manifest = await restoreSnapshot(p);
  res.json({ ok: true, restart: true, documents: manifest.documents, users: manifest.users });
  // Neu starten, damit die wiederhergestellte Datenbank geladen wird (Docker startet den Container neu)
  console.log(`Sicherung ${req.params.name} wiederhergestellt – Neustart …`);
  setTimeout(() => process.exit(0), 300).unref();
});
