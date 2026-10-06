import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockIdp } from './mock-idp.js';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-oidc-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');

let server, base, idp;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  idp = await startMockIdp();
});
after(() => { server.close(); idp.close(); rmSync(dir, { recursive: true, force: true }); });

const cookieOf = res => (res.headers.getSetCookie() || []).map(c => c.split(';')[0]).filter(c => !c.endsWith('='));

async function api(method, path, { cookie, csrf, body } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}

// Kompletter Browser-Ablauf: Rackbook -> IdP -> Callback -> Sitzung
async function ssoLogin() {
  const start = await fetch(base + '/api/auth/oidc/login', { redirect: 'manual' });
  if (start.status !== 303 || !start.headers.get('location').startsWith(idp.issuer)) return { error: start.headers.get('location') };
  const flow = cookieOf(start).find(c => c.startsWith('rb_oidc='));
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(auth.headers.get('location'), { redirect: 'manual', headers: { cookie: flow } });
  const loc = cb.headers.get('location');
  const session = cookieOf(cb).find(c => c.startsWith('rb_session='));
  if (!session) return { error: decodeURIComponent(loc.split('sso_error=')[1] || loc) };
  const st = await api('GET', '/auth/state', { cookie: session });
  return { cookie: session, user: st.data.user, csrf: st.data.csrfToken };
}

let admin;
const PW = 'Ein-Langes-Passwort-1';

test('Admin konfiguriert SSO; Secret wird nie zurückgegeben', async () => {
  const reg = await api('POST', '/auth/register', { body: { username: 'root', password: PW } });
  admin = { cookie: cookieOf(reg.res)[0], csrf: reg.data.csrfToken };
  let r = await api('PUT', '/admin/oidc', { ...admin, body: { enabled: true, issuer: idp.issuer, clientId: 'rackbook', clientSecret: 'geheim' } });
  assert.equal(r.status, 400, 'HTTP-Issuer ohne Freigabe wird abgelehnt');
  r = await api('PUT', '/admin/oidc', {
    ...admin,
    body: { enabled: true, issuer: idp.issuer, clientId: 'rackbook', clientSecret: 'geheim', allowInsecure: true, editorGroups: 'rackbook-editors', adminGroups: ['rackbook-admins'], allowedGroups: 'rackbook-editors, rackbook-admins, rackbook-users' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.oidc.clientSecret, '');
  assert.equal(r.data.oidc.hasClientSecret, true);
  assert.match(r.data.oidc.redirectUri, /\/api\/auth\/oidc\/callback$/);
  r = await api('POST', '/admin/oidc/test', { ...admin, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.pkce, true);
  const st = await api('GET', '/auth/state');
  assert.equal(st.data.sso.enabled, true);
});

test('SSO-Anmeldung legt Benutzer an und vergibt Rolle aus Gruppen', async () => {
  idp.state.user = { sub: 'u-1', preferred_username: 'alice', name: 'Alice', email: 'alice@example.org', groups: ['rackbook-editors'] };
  const s = await ssoLogin();
  assert.equal(s.error, undefined);
  assert.equal(s.user.username, 'alice');
  assert.equal(s.user.role, 'editor');
  assert.equal(s.user.sso, true);
  assert.equal(s.user.hasPassword, false);
  const r = await api('POST', '/docs', { cookie: s.cookie, csrf: s.csrf, body: { title: 'per SSO' } });
  assert.equal(r.status, 201);
});

test('Rollen werden bei erneuter Anmeldung synchronisiert, gleiches Konto wird wiederverwendet', async () => {
  idp.state.user = { ...idp.state.user, groups: ['rackbook-admins'], name: 'Alice Neu' };
  const s = await ssoLogin();
  assert.equal(s.user.username, 'alice');
  assert.equal(s.user.role, 'admin');
  assert.equal(s.user.displayName, 'Alice Neu');
  const users = await api('GET', '/admin/users', admin);
  assert.equal(users.data.users.filter(u => u.username.startsWith('alice')).length, 1);
});

test('Benutzer ohne erlaubte Gruppe wird abgewiesen', async () => {
  idp.state.user = { sub: 'u-2', preferred_username: 'mallory', groups: ['andere'] };
  const s = await ssoLogin();
  assert.match(s.error, /nicht freigegeben/);
});

test('Gleichnamiges lokales Konto wird ohne Freigabe nicht übernommen', async () => {
  idp.state.user = { sub: 'u-3', preferred_username: 'root', groups: ['rackbook-users'] };
  const s = await ssoLogin();
  assert.notEqual(s.user.username, 'root');
  assert.equal(s.user.role, 'viewer');
});

test('Manipulierter oder fehlender Flow-Cookie wird abgelehnt', async () => {
  const start = await fetch(base + '/api/auth/oidc/login', { redirect: 'manual' });
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(auth.headers.get('location'), { redirect: 'manual', headers: { cookie: 'rb_oidc=kaputt' } });
  assert.match(decodeURIComponent(cb.headers.get('location')), /abgelaufen/);
  assert.ok(!cookieOf(cb).some(c => c.startsWith('rb_session=')));
});

test('Passwort-Anmeldung deaktivierbar – Administratoren behalten Notfallzugang', async () => {
  await api('POST', '/admin/users', { ...admin, body: { username: 'lokal', password: PW, role: 'editor', mustChangePassword: false } });
  await api('PUT', '/admin/oidc', { ...admin, body: { disablePasswordLogin: true } });
  assert.equal((await api('POST', '/auth/login', { body: { username: 'lokal', password: PW } })).status, 403);
  assert.equal((await api('POST', '/auth/login', { body: { username: 'root', password: PW } })).status, 200);
  await api('PUT', '/admin/oidc', { ...admin, body: { disablePasswordLogin: false } });
});

test('Deaktiviertes SSO lässt keine Anmeldung zu', async () => {
  await api('PUT', '/admin/oidc', { ...admin, body: { enabled: false } });
  const s = await ssoLogin();
  assert.ok(s.error);
});
