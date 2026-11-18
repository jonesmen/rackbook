// Paket 6: ZIP-Export, Mehrfachaktionen, Tag-Verwaltung
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-feat-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';
const { createApp, initDatabase } = await import('../server/app.js');
const { safeName } = await import('../server/export.js');

let server, base, cookie, csrf;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
const api = async (method, path, body) => {
  const res = await fetch(base + '/api' + path, { method, headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const ids = {};
test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: 'Ein-Langes-Passwort-1' }) });
  cookie = reg.headers.getSetCookie()[0].split(';')[0]; csrf = (await reg.json()).csrfToken;
  const folders = (await api('GET', '/folders')).data.folders;
  ids.f1 = folders[0].id; ids.f2 = folders[1].id; ids.f1name = folders[0].name;
  const up = await fetch(base + '/api/files?name=plan.txt', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'text/plain' }, body: 'Dateiinhalt' });
  ids.file = (await up.json()).file;
  ids.a = (await api('POST', '/docs', { title: 'Projekt: Alpha', folder: ids.f1, content: `Anhang: [Plan](${ids.file.url})`, tags: 'alt, docker' })).data.doc.id;
  ids.b = (await api('POST', '/docs', { title: 'Backup', folder: ids.f1, parent: ids.a, content: `Zurück zu [Alpha](/doc/${ids.a})`, tags: 'alt' })).data.doc.id;
  ids.c = (await api('POST', '/docs', { title: 'Einzeln', folder: ids.f2, content: 'x', tags: 'neu' })).data.doc.id;
});

test('ZIP-Export: Struktur, Anhänge, umgeschriebene Verweise', async () => {
  assert.equal(safeName('a/b:c*?"<>|'), 'a-b-c------');
  assert.equal((await fetch(base + '/api/export/zip')).status, 401);
  const res = await fetch(base + '/api/export/zip', { headers: { cookie } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');
  const zip = join(dir, 'x.zip');
  writeFileSync(zip, buf);
  // Mit dem System-Werkzeug prüfen, falls vorhanden (gültiges Archiv, Inhalt lesbar)
  let list;
  try { list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  assert.ok(list.includes(`${ids.f1name}/Projekt- Alpha.md`), list.join(' | '));
  assert.ok(list.includes(`${ids.f1name}/Projekt- Alpha/Backup.md`));
  assert.ok(list.includes('_dateien/plan.txt'));
  execFileSync('unzip', ['-tq', zip]);
  const alpha = execFileSync('unzip', ['-p', zip, `${ids.f1name}/Projekt- Alpha.md`], { encoding: 'utf8' });
  assert.match(alpha, /^---\ntitle: "Projekt: Alpha"\ntags: \[alt, docker\]/);
  assert.match(alpha, /\[Plan\]\(\.\.\/_dateien\/plan\.txt\)/);
  const backup = execFileSync('unzip', ['-p', zip, `${ids.f1name}/Projekt- Alpha/Backup.md`], { encoding: 'utf8' });
  assert.match(backup, /\[Alpha\]\(\.\.\/\.\.\/[^)]*\/Projekt-%20Alpha\.md\)/);
  assert.equal(execFileSync('unzip', ['-p', zip, '_dateien/plan.txt'], { encoding: 'utf8' }), 'Dateiinhalt');
  // Nur ein Ordner
  const one = await fetch(base + '/api/export/zip?folder=' + ids.f2, { headers: { cookie } });
  writeFileSync(zip, Buffer.from(await one.arrayBuffer()));
  assert.deepEqual(execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n'), ['Einzeln.md']);
});

test('Mehrfachaktionen: Tag, Verschieben, Löschen', async () => {
  let r = await api('POST', '/docs/bulk', { ids: [ids.a, ids.c], action: 'tag', tag: 'Geprüft' });
  assert.equal(r.status, 200);
  assert.ok(r.data.docs.find(d => d.id === ids.a).tags.includes('geprüft'));
  r = await api('POST', '/docs/bulk', { ids: [ids.a], action: 'untag', tag: 'docker' });
  assert.deepEqual(r.data.docs.find(d => d.id === ids.a).tags, ['alt', 'geprüft']);
  // Elternseite verschieben nimmt die Unterseite mit; Unterseite allein wird zur obersten Seite
  r = await api('POST', '/docs/bulk', { ids: [ids.a], action: 'move', folder: ids.f2 });
  assert.deepEqual([r.data.docs.find(d => d.id === ids.a).folder, r.data.docs.find(d => d.id === ids.b).folder, r.data.docs.find(d => d.id === ids.b).parent], [ids.f2, ids.f2, ids.a]);
  r = await api('POST', '/docs/bulk', { ids: [ids.b], action: 'move', folder: ids.f1 });
  assert.deepEqual([r.data.docs.find(d => d.id === ids.b).folder, r.data.docs.find(d => d.id === ids.b).parent], [ids.f1, null]);
  assert.equal((await api('POST', '/docs/bulk', { ids: [ids.a], action: 'move', folder: 'gibt-es-nicht' })).status, 400);
  assert.equal((await api('POST', '/docs/bulk', { ids: [], action: 'trash' })).status, 400);
  r = await api('POST', '/docs/bulk', { ids: [ids.c], action: 'trash' });
  assert.ok(!r.data.docs.some(d => d.id === ids.c));
});

test('Tags umbenennen, zusammenführen, entfernen', async () => {
  let r = await api('POST', '/tags/rename', { from: 'alt', to: 'Archiv' });
  assert.equal(r.data.documents, 2);
  let docs = (await api('GET', '/docs')).data.docs;
  assert.ok(docs.every(d => !d.tags.includes('alt')));
  assert.ok(docs.find(d => d.id === ids.a).tags.includes('archiv'));
  // Zusammenführen: kein doppelter Tag
  r = await api('POST', '/tags/rename', { from: 'geprüft', to: 'archiv' });
  docs = (await api('GET', '/docs')).data.docs;
  assert.deepEqual(docs.find(d => d.id === ids.a).tags, ['archiv']);
  r = await api('POST', '/tags/rename', { from: 'archiv', to: '' });
  assert.equal(r.data.documents, 2);
  assert.deepEqual((await api('GET', '/docs')).data.docs.find(d => d.id === ids.a).tags, []);
});
