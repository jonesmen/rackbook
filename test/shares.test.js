import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-shares-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');
const { db } = await import('../server/db.js');

let server, base;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const PW = 'Ein-Langes-Passwort-1';
function client(cookie, csrf) {
  return async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
}
async function login(username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  return client(res.headers.getSetCookie()[0].split(';')[0], (await res.json()).csrfToken);
}
const pub = (body, headers = {}) => fetch(base + '/api/public/share', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, data: await r.json(), headers: r.headers }));

let admin, editor, editor2, ids = {};

test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
  admin = client(reg.headers.getSetCookie()[0].split(';')[0], (await reg.json()).csrfToken);
  for (const u of ['edi', 'eva']) await admin('POST', '/admin/users', { username: u, password: PW, role: 'editor', mustChangePassword: false });
  editor = await login('edi');
  editor2 = await login('eva');
  const f = (await editor('POST', '/folders', { name: 'Edis Projekt' })).data.folder.id;
  ids.folder = f;
  ids.main = (await editor('POST', '/docs', { title: 'Haupt', folder: f, content: 'Siehe [Fremd](/doc/FREMD) und [Kind](/doc/KIND)' })).data.doc.id;
  ids.child = (await editor('POST', '/docs', { title: 'Kind', parent: ids.main, content: 'Kind-Inhalt' })).data.doc.id;
  ids.foreignChild = (await editor2('POST', '/docs', { title: 'Von Eva', parent: ids.main, content: 'Evas Geheimnis' })).data.doc.id;
  ids.adminDoc = (await admin('POST', '/docs', { title: 'Admin-Doku', folder: 'netzwerk', content: 'intern' })).data.doc.id;
});

test('Nur eigene Inhalte teilbar (außer Admins), Laufzeit-Maximum gilt nicht für Admins', async () => {
  assert.equal((await editor('POST', '/shares', { kind: 'doc', target: ids.adminDoc })).status, 403);
  assert.equal((await editor('POST', '/shares', { kind: 'doc', target: ids.foreignChild })).status, 403);
  await admin('PUT', '/admin/shares/settings', { maxDays: 30 });
  assert.equal((await editor('POST', '/shares', { kind: 'doc', target: ids.main, expiresDays: 0 })).status, 403, 'unbegrenzt nur für Admins');
  assert.equal((await editor('POST', '/shares', { kind: 'doc', target: ids.main, expiresDays: 60 })).status, 403);
  const r = await admin('POST', '/shares', { kind: 'doc', target: ids.adminDoc, expiresDays: 0 });
  assert.equal(r.status, 201);
  assert.equal(r.data.share.expiresAt, null);
  ids.adminToken = r.data.token;
});

test('Freigabe einer Seite mit Unterseiten: fremde Unterseiten bleiben privat', async () => {
  const r = await editor('POST', '/shares', { kind: 'doc', target: ids.main, expiresDays: 7, includeChildren: true });
  assert.equal(r.status, 201);
  assert.ok(r.data.token.length >= 43);
  ids.token = r.data.token;
  ids.shareId = r.data.share.id;
  // Token wird nur gehasht gespeichert
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shares WHERE token_hash = ?').get(r.data.token).n, 0);
  const p = await pub({ token: ids.token });
  assert.equal(p.status, 200);
  assert.match(p.headers.get('x-robots-tag'), /noindex/);
  const titles = p.data.docs.map(d => d.title).sort();
  assert.deepEqual(titles, ['Haupt', 'Kind']);
  assert.ok(!JSON.stringify(p.data).includes('Evas Geheimnis'));
  assert.equal(p.data.docs.find(d => d.title === 'Haupt').parent, null);
});

test('Ungültige Tokens, Passwortschutz mit Fehlversuch-Limit', async () => {
  assert.equal((await pub({ token: 'x'.repeat(43) })).status, 404);
  assert.equal((await pub({})).status, 404);
  const r = await editor('POST', '/shares', { kind: 'folder', target: ids.folder, password: 'geheim123' });
  const t = r.data.token;
  let p = await pub({ token: t });
  assert.equal(p.status, 401);
  assert.equal(p.data.passwordRequired, true);
  assert.ok(!p.data.docs, 'ohne Passwort kein Inhalt');
  p = await pub({ token: t, password: 'geheim123' });
  assert.equal(p.status, 200);
  assert.ok(p.data.folders.length >= 1);
  for (let i = 0; i < 5; i++) await pub({ token: t, password: 'falsch' });
  p = await pub({ token: t, password: 'geheim123' });
  assert.equal(p.status, 429, 'nach 5 Fehlversuchen gesperrt');
});

test('Widerruf, Übersicht, Admin macht alles eines Benutzers privat', async () => {
  let mine = (await editor('GET', '/shares')).data.shares;
  assert.equal(mine.length, 2);
  assert.equal((await editor2('DELETE', '/shares/' + ids.shareId)).status, 404, 'fremde Freigabe nicht widerrufbar');
  assert.equal((await editor('DELETE', '/shares/' + ids.shareId)).status, 200);
  assert.equal((await pub({ token: ids.token })).status, 404);
  const t2 = (await editor('POST', '/shares', { kind: 'doc', target: ids.child })).data.token;
  const users = (await admin('GET', '/admin/users')).data.users;
  const edi = users.find(u => u.username === 'edi');
  assert.ok(edi.shares >= 2);
  const r = await admin('DELETE', `/admin/users/${edi.id}/shares`);
  assert.ok(r.data.revoked >= 2);
  assert.equal((await pub({ token: t2 })).status, 404);
  mine = (await editor('GET', '/shares')).data.shares;
  assert.equal(mine.filter(s => !s.expired).length, 0);
});

test('Berechtigung wird bei jedem Abruf neu geprüft (Deaktivierung, Ablauf, Abschalten)', async () => {
  const t = (await editor('POST', '/shares', { kind: 'doc', target: ids.main })).data.token;
  assert.equal((await pub({ token: t })).status, 200);
  const edi = (await admin('GET', '/admin/users')).data.users.find(u => u.username === 'edi');
  await admin('PATCH', '/admin/users/' + edi.id, { role: 'viewer' });
  assert.equal((await pub({ token: t })).status, 404, 'Leser dürfen nicht teilen');
  await admin('PATCH', '/admin/users/' + edi.id, { role: 'editor' });
  assert.equal((await pub({ token: t })).status, 200);
  db.prepare("UPDATE shares SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1000, edi.id);
  assert.equal((await pub({ token: t })).status, 404, 'abgelaufen');
  await admin('PUT', '/admin/shares/settings', { enabled: false });
  assert.equal((await pub({ token: ids.adminToken })).status, 404, 'Teilen global aus');
  await admin('PUT', '/admin/shares/settings', { enabled: true });
  assert.equal((await pub({ token: ids.adminToken })).status, 200);
});

test('Freigabeseite: noindex, keine Token in URLs, CSP aktiv', async () => {
  const res = await fetch(base + '/share');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
