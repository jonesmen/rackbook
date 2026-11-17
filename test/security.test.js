// Sicherheits-Härtung: Kontosperre, Passwortwechsel-Zwang, Tokens, Freigabe-Links, MCP-Limits
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-sec-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';
process.env.SETUP_TOKEN = 'einrichtung-geheim';
process.env.SESSION_IDLE_MINUTES = '-5'; // ungültig → Standardwert

const { createApp, initDatabase } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { config } = await import('../server/config.js');
const { RateLimiter } = await import('../server/security.js');
const { md } = await import('../public/js/md.js');

let server, base;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, { cookie, csrf, body, raw } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { ...(body || raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  return { status: r.status, cookie: (r.res.headers.getSetCookie()[0] || '').split(';')[0], csrf: r.data && r.data.csrfToken };
}
const rpc = (token, body) => fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const call = async (token, name, args) => (await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()).result;

const PW = 'Ein-Langes-Passwort-1';
let admin;

test('Ersteinrichtung verlangt das Einrichtungs-Token', async () => {
  assert.equal((await api('GET', '/auth/state')).data.setupTokenRequired, true);
  assert.equal((await api('POST', '/auth/register', { body: { username: 'chef', password: PW } })).status, 403);
  assert.equal((await api('POST', '/auth/register', { body: { username: 'chef', password: PW, setupToken: 'falsch' } })).status, 403);
  const reg = await api('POST', '/auth/register', { body: { username: 'chef', password: PW, setupToken: 'einrichtung-geheim' } });
  assert.equal(reg.status, 201);
  admin = { cookie: reg.res.headers.getSetCookie()[0].split(';')[0], csrf: reg.data.csrfToken };
  assert.equal((await api('GET', '/auth/state')).data.setupTokenRequired, false);
});

test('Konfiguration: ungültige Werte fallen auf den Standard zurück', () => {
  assert.equal(config.sessionIdleMinutes, 720);
});

test('Kontosperre zählt parallele Fehlversuche einzeln', async () => {
  await api('POST', '/admin/users', { ...admin, body: { username: 'opfer', password: PW, role: 'editor', mustChangePassword: false } });
  const tries = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/auth/login', { body: { username: 'opfer', password: 'falsch-falsch-1' } })));
  assert.ok(tries.every(t => t.status === 401 || t.status === 423));
  const u = db.prepare("SELECT locked_until FROM users WHERE username = 'opfer'").get();
  assert.ok(u.locked_until > Date.now(), 'Konto ist gesperrt');
  // Auch das richtige Passwort hilft während der Sperre nicht
  assert.equal((await login('opfer', PW)).status, 423);
  db.prepare("UPDATE users SET locked_until = 0, failed_logins = 0 WHERE username = 'opfer'").run();
  assert.equal((await login('opfer', PW)).status, 200);
});

test('Anmelde-Limit: erfolgreiche Anmeldungen zählen nicht, Speicher wächst nicht unbegrenzt', () => {
  const l = new RateLimiter(3, 60000);
  for (let i = 0; i < 50; i++) l.hit('k');
  assert.ok(l.hits.get('k').length <= 4);
  const m = new RateLimiter(2, 60000);
  m.hit('a'); m.forgive('a'); m.hit('a'); m.forgive('a');
  assert.equal(m.hit('a'), true);
});

test('Fehlerhaftes Cookie und große Anmelde-Anfragen', async () => {
  const bad = await fetch(base + '/api/auth/state', { headers: { cookie: 'x=%E0%A4%A' } });
  assert.equal(bad.status, 200);
  const big = await api('POST', '/auth/login', { raw: JSON.stringify({ username: 'chef', password: 'x'.repeat(200000) }) });
  assert.equal(big.status, 413);
});

test('Passwortwechsel-Zwang: kein Token-Zugriff, Tokens werden beim Zurücksetzen widerrufen', async () => {
  await api('PUT', '/admin/mcp', { ...admin, body: { enabled: true, allowWrite: true, allowFiles: true } });
  const ed = await login('opfer', PW);
  const t = await api('POST', '/me/mcp-tokens', { ...ed, body: { name: 'Claude', scopes: ['read'] } });
  assert.equal(t.status, 201);
  assert.equal((await rpc(t.data.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  const uid = db.prepare("SELECT id FROM users WHERE username = 'opfer'").get().id;
  // Passwortwechsel steht aus → Token gesperrt, keine neuen Tokens
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(uid);
  assert.equal((await rpc(t.data.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await api('POST', '/me/mcp-tokens', { ...ed, body: { name: 'Neu', scopes: ['read'] } })).status, 403);
  assert.equal((await api('GET', '/me', ed)).status, 200);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(uid);
  assert.equal((await rpc(t.data.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  // Admin setzt das Passwort zurück → Sitzungen und Tokens weg
  assert.equal((await api('POST', `/admin/users/${uid}/password`, { ...admin, body: { password: 'Neues-Langes-Passwort-2' } })).status, 200);
  assert.equal((await rpc(t.data.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL').get(uid).n, 0);
  assert.equal((await api('GET', '/me', ed)).status, 401);
  // Das eigene Passwort / 2FA nicht über die Verwaltung zurücksetzen
  const me = db.prepare("SELECT id FROM users WHERE username = 'chef'").get().id;
  assert.equal((await api('POST', `/admin/users/${me}/password`, { ...admin, body: { password: 'Neues-Langes-Passwort-2' } })).status, 409);
  assert.equal((await api('POST', `/admin/users/${me}/reset-2fa`, { ...admin })).status, 409);
});

test('Falsches aktuelles Passwort wird nach wenigen Versuchen gebremst', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await api('POST', '/me/password', { ...admin, body: { currentPassword: 'falsch', newPassword: 'Noch-Ein-Langes-Passwort-3' } });
  assert.equal(last.status, 429);
});

test('MCP: Limit zählt Einzelaufrufe, Paketgröße begrenzt, fehlerhafte Eingaben', async () => {
  await api('PUT', '/admin/mcp', { ...admin, body: { enabled: true, allowWrite: true, allowFiles: true, rateLimitPerMinute: 30 } });
  const t = (await api('POST', '/me/mcp-tokens', { ...admin, body: { name: 'Limit', scopes: ['read', 'write'] } })).data.token;
  const ping = id => ({ jsonrpc: '2.0', id, method: 'ping' });
  assert.equal((await rpc(t, Array.from({ length: 51 }, (_, i) => ping(i + 1)))).status, 400);
  assert.equal((await rpc(t, '{kaputt')).status, 400);
  assert.equal((await (await rpc(t, '{kaputt')).json()).error.code, -32700);
  // params: null darf keinen internen Fehler auslösen
  const nul = await (await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null })).json();
  assert.equal(nul.error.code, -32602);
  // 25 + 25 Aufrufe in zwei Paketen: das zweite überschreitet das Limit von 30
  assert.equal((await rpc(t, Array.from({ length: 25 }, (_, i) => ping(i + 1)))).status, 200);
  assert.equal((await rpc(t, Array.from({ length: 25 }, (_, i) => ping(i + 1)))).status, 429);
});

test('MCP: Tags, Titel-Überschrift, Duplikate je Elternseite, keine leere Version', async () => {
  await api('PUT', '/admin/mcp', { ...admin, body: { enabled: true, allowWrite: true, allowFiles: true, rateLimitPerMinute: 600 } });
  const t = (await api('POST', '/me/mcp-tokens', { ...admin, body: { name: 'Schreiben', scopes: ['read', 'write'] } })).data.token;
  const folder = (await api('GET', '/folders', admin)).data.folders[0].id;
  const a = await call(t, 'create_document', { title: 'Projekt A', folder, content: '# Projekt A\n\nText', tags: 'docker, dns' });
  assert.equal(a.isError, false);
  assert.deepEqual(a.structuredContent.tags.filter(x => x !== 'ki'), ['docker', 'dns']);
  const b = await call(t, 'create_document', { title: 'Projekt B', folder, content: '# Einleitung\n\nText' });
  const docs = (await api('GET', '/docs', admin)).data.docs;
  assert.equal(docs.find(d => d.title === 'Projekt A').content, 'Text');
  assert.equal(docs.find(d => d.title === 'Projekt B').content, '# Einleitung\n\nText');
  // „Backup“ unter beiden Projekten ist erlaubt, doppelt unter demselben nicht
  const idA = a.structuredContent.id, idB = b.structuredContent.id;
  assert.equal((await call(t, 'create_document', { title: 'Backup', parent: idA, content: 'x' })).isError, false);
  assert.equal((await call(t, 'create_document', { title: 'Backup', parent: idB, content: 'x' })).isError, false);
  assert.equal((await call(t, 'create_document', { title: 'backup', parent: idB, content: 'x' })).isError, true);
  // Suche: mehrere Wörter, Reihenfolge egal; negative Limits schaden nicht
  const s = await call(t, 'search_documents', { query: 'Text Einleitung', limit: -3 });
  assert.equal(s.structuredContent.results.length, 1);
  // Aktualisieren ohne Änderung erzeugt keine neue Version
  const cur = docs.find(d => d.title === 'Projekt A');
  const u = await call(t, 'update_document', { id: cur.id, version: cur.version, content: 'Text' });
  assert.equal(u.structuredContent.version, cur.version);
});

test('MCP: ordnerbeschränkte Tokens sehen keine fremden Dateien, kein Inventar, keine eigenen Vorlagen', async () => {
  const folders = (await api('GET', '/folders', admin)).data.folders;
  const [f1, f2] = folders;
  const up = await fetch(base + '/api/files?name=geheim.txt', { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'text/plain' }, body: 'TOPSECRET' });
  const file = (await up.json()).file;
  const secret = await api('POST', '/docs', { ...admin, body: { title: 'Geheim', folder: f2.id, content: `::file {"src":"${file.url}","name":"geheim.txt"}`, tags: '' } });
  const open = await api('POST', '/docs', { ...admin, body: { title: 'Offen', folder: f1.id, content: 'Hallo', tags: '' } });
  await api('POST', '/assets', { ...admin, body: { kind: 'host', name: 'pve-geheim', doc: open.data.doc.id } });
  await api('POST', '/templates', { ...admin, body: { name: 'Aus Geheim', fromDoc: secret.data.doc.id } });
  const t = (await api('POST', '/me/mcp-tokens', { ...admin, body: { name: 'Eng', scopes: ['read', 'files'], folders: [f1.id] } })).data.token;
  const rf = await call(t, 'read_file', { id: file.id });
  assert.equal(rf.isError, true);
  assert.doesNotMatch(JSON.stringify(rf), /TOPSECRET/);
  const gd = await call(t, 'get_document', { id: open.data.doc.id });
  assert.doesNotMatch(JSON.stringify(gd), /pve-geheim/);
  const lt = await call(t, 'list_templates', { full: true });
  assert.doesNotMatch(JSON.stringify(lt), /Aus Geheim/);
  assert.match(JSON.stringify(lt), /builtin-dienst/);
});

test('Freigabe: Datei-Links gelten nach dem Widerruf nicht mehr', async () => {
  await api('PUT', '/admin/sharing', { ...admin, body: { enabled: true } });
  const folder = (await api('GET', '/folders', admin)).data.folders[0].id;
  const up = await fetch(base + '/api/files?name=bild.png', { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  const file = (await up.json()).file;
  const d = await api('POST', '/docs', { ...admin, body: { title: 'Geteilt', folder, content: `![x](${file.url})`, tags: '' } });
  const sh = await api('POST', '/shares', { ...admin, body: { kind: 'doc', target: d.data.doc.id } });
  assert.equal(sh.status, 201, JSON.stringify(sh.data));
  const token = sh.data.token;
  const pub = await api('POST', '/public/share', { body: { token } });
  const signed = pub.data.files[file.id];
  assert.equal((await fetch(base + signed)).status, 200);
  assert.equal((await api('DELETE', '/shares/' + sh.data.share.id, admin)).status, 200);
  assert.equal((await fetch(base + signed)).status, 403);
});

test('Markdown: fremde PDFs werden verlinkt statt eingebettet', () => {
  assert.doesNotMatch(md('::pdf {"src":"https://evil.example/x.pdf","name":"X"}').html, /<iframe/);
  assert.match(md('::pdf {"src":"/files/abcdefghijklmnopqrst","name":"X"}').html, /<iframe/);
});
