import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-inv-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');
const { parseCidr } = await import('../server/assets.js');

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
      headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
async function login(username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  return client(res.headers.getSetCookie()[0].split(';')[0], (await res.json()).csrfToken);
}

let admin, viewer, editor;
const ids = {};

test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
  admin = client(reg.headers.getSetCookie()[0].split(';')[0], (await reg.json()).csrfToken);
  await admin('POST', '/admin/users', { username: 'leser', password: PW, role: 'viewer', mustChangePassword: false });
  await admin('POST', '/admin/users', { username: 'edi', password: PW, role: 'editor', mustChangePassword: false });
  viewer = await login('leser');
  editor = await login('edi');
});

test('Vorlagen: mitgelieferte, eigene, aus Dokument, Rechte', async () => {
  let r = await viewer('GET', '/templates');
  assert.ok(r.data.templates.some(t => t.id === 'builtin-runbook' && t.builtin));
  assert.equal((await viewer('POST', '/templates', { name: 'X', content: 'x' })).status, 403);
  r = await editor('POST', '/templates', { name: 'Mein Dienst', icon: 'cloud', tags: ['Docker'], content: '## Zugriff\n\n{{heute}}' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.template.tags, ['docker']);
  ids.tpl = r.data.template.id;
  // nur Ersteller oder Admin ändern/löschen; mitgelieferte nie
  const other = await login('edi');
  assert.equal((await admin('PUT', '/templates/' + ids.tpl, { name: 'Umbenannt' })).status, 200);
  assert.equal((await other('PUT', '/templates/builtin-host', { name: 'x' })).status, 400);
  const doc = (await admin('POST', '/docs', { title: 'Vorbild', folder: 'netzwerk', tags: ['vlan'], content: 'Inhalt' })).data.doc;
  r = await editor('POST', '/templates', { fromDoc: doc.id, name: 'Aus Dokument' });
  assert.equal(r.data.template.content, 'Inhalt');
  assert.deepEqual(r.data.template.tags, ['vlan']);
  assert.equal((await admin('DELETE', '/templates/' + r.data.template.id)).status, 200);
  assert.equal((await admin('DELETE', '/templates/builtin-host')).status, 400);
});

test('CIDR-Berechnung', () => {
  assert.deepEqual(parseCidr('10.0.20.17/24'), { start: 167777280, end: 167777535, prefix: 24, size: 256, text: '10.0.20.0/24' });
  assert.equal(parseCidr('10.0.0.0/33'), null);
  assert.equal(parseCidr('300.0.0.0/24'), null);
});

test('Inventar: anlegen, Hierarchie, Validierung, IP-Übersicht mit Konflikten', async () => {
  assert.equal((await viewer('POST', '/assets', { kind: 'host', name: 'x' })).status, 403);
  let r = await editor('POST', '/assets', { kind: 'network', name: 'Server-LAN', data: { cidr: '10.0.20.5/24', vlan: '20', gateway: '10.0.20.1', dhcp: '10.0.20.100-10.0.20.199' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.asset.data.cidr, '10.0.20.0/24', 'Netz wird normalisiert');
  ids.net = r.data.asset.id;
  r = await editor('POST', '/assets', { kind: 'host', name: 'pve-01', ips: [{ address: '10.0.20.10', mac: 'AA-BB-CC-DD-EE-FF' }], data: { hardware: 'NUC, 64 GB', os: 'Proxmox VE 9' } });
  ids.host = r.data.asset.id;
  assert.equal(r.data.asset.ips[0].mac, 'aa:bb:cc:dd:ee:ff');
  r = await editor('POST', '/assets', { kind: 'vm', name: 'docker-01', parent: ids.host, ips: ['10.0.20.11'] });
  ids.vm = r.data.asset.id;
  r = await editor('POST', '/assets', { kind: 'container', name: 'nextcloud', parent: ids.vm, ips: ['10.0.20.10'] });
  ids.ct = r.data.asset.id;
  // Ungültige Eingaben
  assert.equal((await editor('POST', '/assets', { kind: 'toaster', name: 'x' })).status, 400);
  assert.equal((await editor('POST', '/assets', { kind: 'host', name: 'x', ips: ['999.1.1.1'] })).status, 400);
  assert.equal((await editor('POST', '/assets', { kind: 'network', name: 'x', data: { cidr: 'kaputt' } })).status, 400);
  assert.equal((await editor('POST', '/assets', { kind: 'host', name: 'x', data: { url: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await editor('PUT', '/assets/' + ids.host, { parent: ids.ct })).status, 400, 'kein Zyklus');
  // IP-Übersicht
  const o = (await viewer('GET', '/assets/ip-overview')).data;
  const n = o.networks.find(x => x.id === ids.net);
  assert.equal(n.used, 2);
  assert.equal(n.usable, 254);
  assert.deepEqual(n.nextFree.slice(0, 3), ['10.0.20.2', '10.0.20.3', '10.0.20.4'], 'Gateway (.1) ist nicht frei');
  assert.ok(!n.nextFree.includes('10.0.20.10'));
  assert.deepEqual(o.conflicts.map(c => c.address), ['10.0.20.10']);
  // Außer Betrieb genommene Einträge zählen nicht
  await editor('PUT', '/assets/' + ids.ct, { status: 'retired' });
  assert.equal((await viewer('GET', '/assets/ip-overview')).data.conflicts.length, 0);
  // Löschen: Untereinträge rücken nach oben
  await editor('DELETE', '/assets/' + ids.vm);
  assert.equal((await viewer('GET', '/assets/' + ids.ct)).data.asset.parent, ids.host);
});

test('Dokumentkarten in Freigaben ohne Notizen; Backup enthält Inventar und Vorlagen', async () => {
  await admin('PUT', '/assets/' + ids.host, { data: { notes: 'intern geheim' } });
  const d = (await admin('POST', '/docs', { title: 'pve-01', folder: 'server', content: `Hauptserver\n\n::asset {"id":"${ids.host}"}` })).data.doc;
  await admin('PUT', '/assets/' + ids.host, { doc: d.id });
  const sh = await admin('POST', '/shares', { kind: 'doc', target: d.id, expiresDays: 1 });
  const p = await fetch(base + '/api/public/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sh.data.token }) }).then(r => r.json());
  assert.equal(p.assets[ids.host].name, 'pve-01');
  assert.equal(p.assets[ids.host].data.notes, undefined, 'Notizen werden nicht geteilt');
  const b = await admin('GET', '/admin/backup');
  assert.ok(b.data.assets.some(a => a.id === ids.host && a.doc === d.id));
  assert.ok(b.data.templates.some(t => t.id === ids.tpl));
  await admin('DELETE', '/assets/' + ids.host);
  await admin('DELETE', '/templates/' + ids.tpl);
  const r = await admin('POST', '/admin/restore', b.data);
  assert.equal(r.status, 200);
  const host = (await admin('GET', '/assets/' + ids.host)).data.asset;
  assert.equal(host.name, 'pve-01');
  assert.equal(host.doc, d.id);
  assert.ok((await admin('GET', '/templates')).data.templates.some(t => t.id === ids.tpl));
});

test('MCP: Vorlagen, Inventar, IP-Übersicht, Rückverweise', async () => {
  await admin('PUT', '/admin/mcp', { enabled: true, allowWrite: true });
  const tok = (await editor('POST', '/me/mcp-tokens', { name: 'KI', scopes: ['read', 'write'] })).data.token;
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  assert.match(c.getInstructions(), /ip_overview/);
  let r = await c.callTool({ name: 'list_templates', arguments: {} });
  assert.match(r.content[0].text, /builtin-runbook/);
  r = await c.callTool({ name: 'create_document', arguments: { title: 'Störung DNS', folder: 'netzwerk', template: 'builtin-stoerung' } });
  assert.equal(r.isError, false, r.content[0].text);
  const doc = r.structuredContent;
  assert.ok(doc.tags.includes('stoerung'));
  const content = (await c.callTool({ name: 'get_document', arguments: { id: doc.id } })).content[0].text;
  assert.match(content, /\{\{date:\d{4}-\d{2}-\d{2}\}\}/, 'Platzhalter {{heute}} ersetzt');
  // Inventar über MCP
  r = await c.callTool({ name: 'save_asset', arguments: { kind: 'vm', name: 'dns-01', parent: ids.host, ips: [{ address: '10.0.20.53' }], data: { os: 'Debian 13' }, doc: doc.id } });
  assert.equal(r.isError, false, r.content[0].text);
  const vm = r.structuredContent;
  assert.match(r.content[0].text, /::asset \{"id":"as_/);
  r = await c.callTool({ name: 'save_asset', arguments: { kind: 'vm', name: 'DNS-01' } });
  assert.equal(r.isError, true, 'Duplikat');
  r = await c.callTool({ name: 'save_asset', arguments: { id: vm.id, ips: [{ address: '10.0.20.10' }] } });
  assert.match(r.content[0].text, /doppelt vergebene IP: 10\.0\.20\.10/);
  r = await c.callTool({ name: 'list_assets', arguments: { query: '10.0.20.10' } });
  assert.deepEqual(r.structuredContent.assets.map(a => a.name).sort(), ['Server-LAN', 'dns-01', 'nextcloud', 'pve-01'], 'Treffer: genaue IP und das Netz, das sie enthält');
  r = await c.callTool({ name: 'get_asset', arguments: { id: ids.host } });
  assert.match(r.content[0].text, /Läuft darauf:[\s\S]*dns-01/);
  r = await c.callTool({ name: 'ip_overview', arguments: { network: '10.0.20.0/24' } });
  assert.match(r.content[0].text, /Nächste freie Adressen: 10\.0\.20\.2/);
  // Rückverweise und verknüpftes Inventar in get_document
  await admin('POST', '/docs', { title: 'Übersicht', folder: 'netzwerk', content: `Siehe [Störung](/doc/${doc.id})` });
  r = await c.callTool({ name: 'get_document', arguments: { id: doc.id } });
  assert.match(r.content[0].text, /Verlinkt von: Übersicht/);
  assert.match(r.content[0].text, /Inventar: dns-01/);
  await c.close();
  // Ordner-beschränkte Tokens sehen kein Inventar
  const lim = (await editor('POST', '/me/mcp-tokens', { name: 'Netz', scopes: ['read'], folders: ['netzwerk'] })).data.token;
  const c2 = new Client({ name: 't', version: '1' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${lim}` } } }));
  assert.equal((await c2.callTool({ name: 'list_assets', arguments: {} })).isError, true);
  await c2.close();
});
