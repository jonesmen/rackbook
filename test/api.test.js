import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-test-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');
const { totpAt } = await import('../server/security.js');
const { md } = await import('../public/js/md.js');

let server, base;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

// Minimaler Client mit Cookie-Jar und CSRF-Token.
function client() {
  let cookie = '', csrf = null;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    if (data && data.csrfToken) csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get cookie() { return cookie; }, setCsrf: t => { csrf = t; } };
}

const PW = 'Ein-Langes-Passwort-1';
const admin = client();

test('erster Benutzer wird Administrator, danach ist Registrierung gesperrt', async () => {
  let r = await admin.call('GET', '/auth/state');
  assert.equal(r.data.setupRequired, true);
  r = await admin.call('POST', '/auth/register', { username: 'chef', password: PW, displayName: 'Chef' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  const other = client();
  r = await other.call('POST', '/auth/register', { username: 'zweiter', password: PW });
  assert.equal(r.status, 403);
});

test('Sitzungs-Cookie ist HttpOnly und SameSite=Strict', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
});

test('schwache Passwörter werden abgelehnt', async () => {
  const r = await admin.call('POST', '/admin/users', { username: 'schwach', password: 'kurz', role: 'viewer' });
  assert.equal(r.status, 400);
});

test('CSRF: schreibende Anfragen ohne Token oder mit fremder Origin werden abgelehnt', async () => {
  const res = await fetch(base + '/api/docs', { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: '{"title":"x"}' });
  assert.equal(res.status, 403);
  const r = await admin.call('POST', '/docs', { title: 'x' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('Dokument anlegen, ändern, Versionskonflikt erkennen, Version wiederherstellen', async () => {
  let r = await admin.call('POST', '/docs', { title: 'Router', folder: 'netzwerk', tags: '#Netz, WLAN', content: '- [ ] Firmware' });
  assert.equal(r.status, 201);
  const d = r.data.doc;
  assert.deepEqual(d.tags, ['netz', 'wlan']);
  r = await admin.call('PUT', '/docs/' + d.id, { content: 'neu', version: d.version });
  assert.equal(r.status, 200);
  assert.equal(r.data.doc.version, 2);
  r = await admin.call('PUT', '/docs/' + d.id, { content: 'veraltet', version: 1 });
  assert.equal(r.status, 409);
  r = await admin.call('GET', `/docs/${d.id}/revisions`);
  assert.equal(r.data.revisions.length, 1);
  r = await admin.call('POST', `/docs/${d.id}/revisions/${r.data.revisions[0].id}/restore`, {});
  assert.equal(r.data.doc.content, '- [ ] Firmware');
  r = await admin.call('POST', `/docs/${d.id}/todo`, { line: 0, text: 'Firmware', checked: true });
  assert.equal(r.data.doc.content, '- [x] Firmware');
  r = await admin.call('DELETE', '/docs/' + d.id);
  assert.equal(r.status, 200);
  r = await admin.call('GET', '/docs/' + d.id);
  assert.equal(r.status, 404);
  r = await admin.call('POST', `/docs/${d.id}/restore`, {});
  assert.equal(r.data.doc.id, d.id);
});

test('Rollen: Leser darf lesen, aber nicht schreiben oder verwalten', async () => {
  let r = await admin.call('POST', '/admin/users', { username: 'leser', password: PW, role: 'viewer', mustChangePassword: false });
  assert.equal(r.status, 201);
  const v = client();
  r = await v.call('POST', '/auth/login', { username: 'leser', password: PW });
  assert.equal(r.status, 200);
  assert.equal((await v.call('GET', '/docs')).status, 200);
  assert.equal((await v.call('POST', '/docs', { title: 'nope' })).status, 403);
  assert.equal((await v.call('GET', '/admin/users')).status, 403);
});

test('Vorläufiges Passwort erzwingt Passwortänderung', async () => {
  await admin.call('POST', '/admin/users', { username: 'neuling', password: PW, role: 'editor' });
  const c = client();
  await c.call('POST', '/auth/login', { username: 'neuling', password: PW });
  assert.equal((await c.call('GET', '/docs')).status, 403);
  const r = await c.call('POST', '/me/password', { currentPassword: PW, newPassword: 'Ganz-Neues-Passwort-2' });
  assert.equal(r.status, 200);
  assert.equal((await c.call('GET', '/docs')).status, 200);
});

test('Kontosperre nach zu vielen Fehlversuchen', async () => {
  await admin.call('POST', '/admin/users', { username: 'opfer', password: PW, role: 'viewer', mustChangePassword: false });
  const c = client();
  for (let i = 0; i < 3; i++) assert.equal((await c.call('POST', '/auth/login', { username: 'opfer', password: 'falsch-falsch' })).status, 401);
  assert.equal((await c.call('POST', '/auth/login', { username: 'opfer', password: PW })).status, 423);
  // Unbekannte Benutzer liefern dieselbe Meldung wie falsche Passwörter
  const u = await c.call('POST', '/auth/login', { username: 'gibtsnicht', password: 'falsch-falsch' });
  assert.equal(u.status, 401);
});

test('Zwei-Faktor-Authentifizierung (TOTP) inkl. Replay-Schutz', async () => {
  await admin.call('POST', '/admin/users', { username: 'totp', password: PW, role: 'viewer', mustChangePassword: false });
  const c = client();
  await c.call('POST', '/auth/login', { username: 'totp', password: PW });
  const setup = await c.call('POST', '/me/totp/setup', {});
  const code = totpAt(setup.data.secret, Math.floor(Date.now() / 30000));
  assert.equal((await c.call('POST', '/me/totp/enable', { code })).status, 200);
  const c2 = client();
  let r = await c2.call('POST', '/auth/login', { username: 'totp', password: PW });
  assert.equal(r.data.mfaRequired, true);
  // Gleicher Code darf nicht erneut verwendet werden
  assert.equal((await c2.call('POST', '/auth/login/mfa', { ticket: r.data.ticket, code })).status, 401);
  const next = totpAt(setup.data.secret, Math.floor(Date.now() / 30000) + 1);
  r = await c2.call('POST', '/auth/login/mfa', { ticket: r.data.ticket, code: next });
  assert.equal(r.status, 200);
});

test('letzter Administrator kann nicht herabgestuft werden', async () => {
  const r = await admin.call('PATCH', '/admin/users/1', { role: 'viewer' });
  assert.equal(r.status, 409);
});

test('Sicherheitsheader werden gesetzt', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('Markdown-Renderer escaped HTML und blockiert gefährliche Links', () => {
  const { html } = md('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.example) **<b>x</b>**');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('href="https://ok.example"'));
  assert.ok(html.includes('&lt;b&gt;'));
});
