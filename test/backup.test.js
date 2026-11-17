// Vollständige Sicherungen: erstellen, herunterladen, hochladen, wiederherstellen; Kontingent; Aufräumen
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-bak-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase, housekeeping } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { createSnapshot, listSnapshots, scheduledBackup, backupDir } = await import('../server/backup.js');
const { filesDir } = await import('../server/files.js');

let server, base, admin;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const PW = 'Ein-Langes-Passwort-1';
async function api(method, path, body, who = admin) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const upload = (name, body, type = 'text/plain') => fetch(base + '/api/files?name=' + name, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': type }, body });

let ids = {};
test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
  admin = { cookie: reg.headers.getSetCookie()[0].split(';')[0], csrf: (await reg.json()).csrfToken };
  const folder = (await api('GET', '/folders')).data.folders[0].id;
  const f = await (await upload('notiz.txt', 'Inhalt der Datei')).json();
  ids.file = f.file;
  const d = await api('POST', '/docs', { title: 'Vor der Sicherung', folder, content: `Stand eins\n\n::file {"src":"${f.file.url}","name":"notiz.txt"}`, tags: '' });
  ids.doc = d.data.doc.id; ids.folder = folder;
});

test('Sicherung erstellen, auflisten, herunterladen', async () => {
  assert.equal((await api('GET', '/admin/snapshots', null, null)).status, 401);
  const c = await api('POST', '/admin/snapshots', {});
  assert.equal(c.status, 201);
  assert.match(c.data.snapshot.name, /^rackbook-manuell-\d{8}-\d{6}\.tar\.gz$/);
  const l = await api('GET', '/admin/snapshots');
  assert.equal(l.data.snapshots.length, 1);
  assert.equal(l.data.settings.schedule, 'daily');
  const dl = await fetch(base + '/api/admin/snapshots/' + c.data.snapshot.name, { headers: { cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  ids.archive = Buffer.from(await dl.arrayBuffer());
  assert.equal(ids.archive.subarray(0, 2).toString('hex'), '1f8b');
  ids.snapshot = c.data.snapshot.name;
  // Pfade außerhalb des Sicherungsordners sind nicht erreichbar
  assert.equal((await fetch(base + '/api/admin/snapshots/..%2Frackbook.db', { headers: { cookie: admin.cookie } })).status, 404);
});

test('Hochladen prüft das Archiv', async () => {
  const bad = await fetch(base + '/api/admin/snapshots/upload', { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/gzip' }, body: Buffer.from('kein archiv') });
  assert.equal(bad.status, 400);
  const ok = await fetch(base + '/api/admin/snapshots/upload', { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/gzip' }, body: ids.archive });
  assert.equal(ok.status, 201);
  const j = await ok.json();
  assert.equal(j.manifest.documents, 1);
  assert.equal(j.snapshot.kind, 'upload');
  assert.equal(listSnapshots().length, 2);
  assert.ok(!readdirSync(backupDir).some(n => n.endsWith('.part')));
  assert.equal((await api('DELETE', '/admin/snapshots/' + j.snapshot.name)).status, 200);
});

test('Automatische Sicherung: Zeitplan und Aufbewahrung', async () => {
  assert.equal((await api('PUT', '/admin/snapshots/settings', { schedule: 'monatlich' })).status, 400);
  assert.equal((await api('PUT', '/admin/snapshots/settings', { schedule: 'daily', keep: 2 })).status, 200);
  const first = await scheduledBackup();
  assert.match(first.name, /^rackbook-auto-/);
  assert.equal(await scheduledBackup(), null, 'innerhalb des Intervalls keine zweite');
  // Ältere automatische Sicherungen simulieren → nur „keep“ bleiben
  for (let i = 1; i <= 3; i++) {
    const p = join(backupDir, `rackbook-auto-2020010${i}-000000.tar.gz`);
    writeFileSync(p, 'x'); utimesSync(p, new Date(2020, 0, i), new Date(2020, 0, i));
  }
  await scheduledBackup();
  assert.equal(listSnapshots().filter(s => s.kind === 'auto').length, 2);
  assert.equal(listSnapshots().filter(s => s.kind === 'manuell').length, 1, 'manuelle bleiben');
  await api('PUT', '/admin/snapshots/settings', { schedule: 'off' });
  assert.equal(await scheduledBackup(), null);
});

test('Kontingent für Dateien', async () => {
  assert.equal((await api('PUT', '/admin/editor', { uploadQuotaMb: 1 })).status, 200);
  assert.equal((await upload('gross.bin', Buffer.alloc(1100000, 1), 'application/octet-stream')).status, 413);
  assert.equal((await upload('klein.txt', 'ok')).status, 201);
  await api('PUT', '/admin/editor', { uploadQuotaMb: 0 });
  assert.equal((await upload('gross.bin', Buffer.alloc(1100000, 1), 'application/octet-stream')).status, 201);
});

test('Aufräumen: Dateien in Vorlagen bleiben, verwaiste Dateien auf der Platte verschwinden', async () => {
  const f = (await (await upload('vorlage.txt', 'in der Vorlage')).json()).file;
  await api('POST', '/templates', { name: 'Mit Datei', content: `::file {"src":"${f.url}","name":"vorlage.txt"}` });
  const lone = (await (await upload('allein.txt', 'unbenutzt')).json()).file;
  db.prepare('UPDATE files SET created_at = ?').run(Date.now() - 2 * 86400000);
  // Rest eines abgebrochenen Uploads und eine Datei ohne Datenbank-Eintrag
  mkdirSync(join(filesDir, 'zz'), { recursive: true });
  const part = join(filesDir, 'zz', 'zzzzzzzzzzzzzzzzzzzz.part'), ghost = join(filesDir, 'zz', 'zzzzzzzzzzzzzzzzzzzz');
  for (const p of [part, ghost]) { writeFileSync(p, 'x'); utimesSync(p, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000)); }
  housekeeping();
  assert.ok(db.prepare('SELECT 1 FROM files WHERE id = ?').get(f.id), 'Datei aus Vorlage bleibt');
  assert.ok(db.prepare('SELECT 1 FROM files WHERE id = ?').get(ids.file.id), 'Datei aus Dokument bleibt');
  assert.ok(!db.prepare('SELECT 1 FROM files WHERE id = ?').get(lone.id), 'unbenutzte Datei entfernt');
  assert.ok(!existsSync(part) && !existsSync(ghost));
});

test('JSON einspielen hebt den bisherigen Stand als Version auf', async () => {
  const before = await api('GET', `/docs/${ids.doc}/revisions`);
  const r = await api('POST', '/admin/restore', { documents: [{ id: ids.doc, title: 'Vor der Sicherung', folder: ids.folder, content: 'Aus dem JSON', tags: [] }] });
  assert.equal(r.data.updated, 1);
  const after = await api('GET', `/docs/${ids.doc}/revisions`);
  assert.equal(after.data.revisions.length, before.data.revisions.length + 1);
});

test('Wiederherstellen ersetzt den gesamten Stand (eigener Prozess, Neustart)', async () => {
  // In einem eigenen Server-Prozess, weil die Wiederherstellung den Prozess beendet
  const d2 = mkdtempSync(join(tmpdir(), 'rackbook-bak2-'));
  mkdirSync(join(d2, 'backups'), { recursive: true });
  writeFileSync(join(d2, 'backups', ids.snapshot), ids.archive);
  const port = 41000 + Math.floor(Math.random() * 2000);
  const start = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env: { ...process.env, DATA_DIR: d2, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = c => { out += c; if (/läuft auf/.test(out)) resolve(p); };
    p.stdout.on('data', onData); p.stderr.on('data', c => { out += c; });
    p.on('exit', code => { p.exitCode2 = code; });
    setTimeout(() => reject(new Error('Server startet nicht: ' + out)), 15000).unref();
  });
  const b2 = `http://127.0.0.1:${port}`;
  let p = await start();
  try {
    // Frische Instanz: anderer Admin, anderes Dokument
    const reg = await fetch(b2 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'neu', password: PW }) });
    const who = { cookie: reg.headers.getSetCookie()[0].split(';')[0], csrf: (await reg.json()).csrfToken };
    const h = { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': 'application/json' };
    const noConfirm = await fetch(`${b2}/api/admin/snapshots/${ids.snapshot}/restore`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(noConfirm.status, 400);
    const r = await fetch(`${b2}/api/admin/snapshots/${ids.snapshot}/restore`, { method: 'POST', headers: h, body: JSON.stringify({ confirm: 'WIEDERHERSTELLEN' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).documents, 1);
    await new Promise(res => (p.exitCode !== null ? res() : p.once('exit', res)));
    assert.equal(p.exitCode, 0, 'Server beendet sich für den Neustart');
    assert.ok(existsSync(join(d2, 'before-restore', 'rackbook.db')), 'bisheriger Stand bleibt einmalig erhalten');
    p = await start();
    // Jetzt gilt der Stand aus der Sicherung: Benutzer „chef“, Dokument und Datei vorhanden
    assert.equal((await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'neu', password: PW }) })).status, 401);
    const li = await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
    assert.equal(li.status, 200);
    const cookie = li.headers.getSetCookie()[0].split(';')[0];
    const docs = (await (await fetch(b2 + '/api/docs', { headers: { cookie } })).json()).docs;
    assert.deepEqual(docs.map(d => d.title), ['Vor der Sicherung']);
    assert.match(docs[0].content, /^Stand eins/);
    const file = await fetch(b2 + ids.file.url, { headers: { cookie } });
    assert.equal(await file.text(), 'Inhalt der Datei');
  } finally {
    p.kill();
    await new Promise(res => (p.exitCode !== null || p.signalCode ? res() : p.once('exit', res)));
    rmSync(d2, { recursive: true, force: true });
  }
});
