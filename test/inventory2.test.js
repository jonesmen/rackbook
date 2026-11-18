// Inventar: IPv6, Prüfungen, Zählung, eigene Felder, CSV; neue KI-Werkzeuge (Papierkorb, Versionen, Ordner, Vorlagen)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-inv2-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase, housekeeping } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { normIp, parseCidr, inCidr, parseCsv } = await import('../server/assets.js');
const { md } = await import('../public/js/md.js');

let server, base, cookie, csrf, token;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const api = async (method, path, body) => {
  const res = await fetch(base + '/api' + path, { method, headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), res };
};
const call = async (name, args) => (await (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;

test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: 'Ein-Langes-Passwort-1' }) });
  cookie = reg.headers.getSetCookie()[0].split(';')[0]; csrf = (await reg.json()).csrfToken;
  await api('PUT', '/admin/mcp', { enabled: true, allowWrite: true, allowDelete: true, allowFolders: true, rateLimitPerMinute: 600 });
  token = (await api('POST', '/me/mcp-tokens', { name: 'T', scopes: ['read', 'write', 'delete', 'folders'] })).data.token;
});

test('Adressen: einheitliche Schreibweise, IPv6-Netze', () => {
  assert.equal(normIp('FE80:0::1'), 'fe80::1');
  assert.equal(normIp(':::'), null);
  assert.equal(normIp('10.0.0.05'), null);
  assert.equal(parseCidr('fd00:20::5/64').text, 'fd00:20::/64');
  assert.equal(parseCidr('10.0.20.7/24').text, '10.0.20.0/24');
  assert.equal(inCidr(parseCidr('fd00:20::/64'), 'FD00:20::A'), true);
  assert.equal(inCidr(parseCidr('fd00:20::/64'), 'fd00:21::a'), false);
  assert.equal(inCidr(parseCidr('10.0.0.0/24'), 'fd00::1'), false);
});

const ids = {};
test('Prüfungen beim Speichern', async () => {
  const net = await api('POST', '/assets', { kind: 'network', name: 'LAN', data: { cidr: '10.0.0.0/24', gateway: '10.0.0.150', dhcp: '10.0.0.100-10.0.0.200' } });
  assert.equal(net.status, 201); ids.net = net.data.asset.id;
  assert.equal((await api('POST', '/assets', { kind: 'network', name: 'X', data: { cidr: '10.0.1.0/24', gateway: '10.0.2.1' } })).status, 400, 'Gateway außerhalb');
  assert.equal((await api('POST', '/assets', { kind: 'network', name: 'X', data: { cidr: '10.0.1.0/24', dhcp: '10.0.9.1-10.0.9.9' } })).status, 400, 'DHCP außerhalb');
  const v6 = await api('POST', '/assets', { kind: 'network', name: 'V6', data: { cidr: 'FD00:20::7/64', gateway: 'fd00:20::1' } });
  assert.equal(v6.data.asset.data.cidr, 'fd00:20::/64');
  const h = await api('POST', '/assets', { kind: 'host', name: 'pve', ips: [{ address: '10.0.0.160', mac: 'AA-BB-CC-DD-EE-FF' }, '10.0.0.5', 'FD00:20::A'], data: { os: 'Debian', ram: '64 GB', custom: [{ label: 'CPU', value: '8 Kerne' }] } });
  assert.equal(h.status, 201); ids.host = h.data.asset.id;
  assert.deepEqual(h.data.asset.ips.map(i => i.address), ['10.0.0.160', '10.0.0.5', 'fd00:20::a']);
  // Unbekannte Schlüssel gehen nicht verloren, sondern werden eigene Felder
  assert.deepEqual(h.data.asset.data.custom, [{ label: 'CPU', value: '8 Kerne' }, { label: 'ram', value: '64 GB' }]);
  // Nichts läuft „auf“ einem Netzwerk, und ein Netzwerk läuft auf nichts
  assert.equal((await api('POST', '/assets', { kind: 'vm', name: 'vm1', parent: ids.net })).status, 400);
  assert.equal((await api('PUT', '/assets/' + ids.net, { parent: ids.host })).status, 400);
  assert.equal((await api('POST', '/assets', { kind: 'host', name: 'viele', ips: Array.from({ length: 51 }, (_, i) => `10.9.0.${i + 1}`) })).status, 400);
});

test('IP-Belegung: Zählung, MAC-Dubletten, überschneidende Netze, IPv6', async () => {
  await api('POST', '/assets', { kind: 'host', name: 'nas', ips: [{ address: '10.0.0.6', mac: 'aa:bb:cc:dd:ee:ff' }] });
  await api('POST', '/assets', { kind: 'network', name: 'Teilnetz', data: { cidr: '10.0.0.128/25' } });
  const o = (await api('GET', '/assets/ip-overview')).data;
  const lan = o.networks.find(n => n.name === 'LAN');
  // 254 nutzbar − 101 DHCP (Gateway liegt darin) − 2 belegte außerhalb des DHCP-Bereichs
  assert.deepEqual([lan.usable, lan.used, lan.reserved, lan.available], [254, 3, 101, 151]);
  assert.equal(o.macConflicts.length, 1);
  assert.equal(o.macConflicts[0].mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(o.overlaps.length, 1);
  const v6 = o.networks.find(n => n.name === 'V6');
  assert.equal(v6.usable, null);
  assert.equal(v6.used, 1);
  assert.equal(v6.nextFree[0], 'fd00:20::2');
  assert.equal(o.unassigned.length, 0);
});

test('Verknüpftes Dokument im Papierkorb blockiert das Speichern nicht', async () => {
  const folder = (await api('GET', '/folders')).data.folders[0].id;
  const d = await api('POST', '/docs', { title: 'pve-Doku', folder, content: 'x', tags: '' });
  ids.doc = d.data.doc.id;
  assert.equal((await api('PUT', '/assets/' + ids.host, { doc: ids.doc })).status, 200);
  await api('DELETE', '/docs/' + ids.doc);
  assert.equal((await api('PUT', '/assets/' + ids.host, { doc: ids.doc, name: 'pve-01' })).status, 200);
  assert.equal((await api('PUT', '/assets/' + ids.net, { doc: ids.doc })).status, 400, 'neu verknüpfen geht nicht');
  // Endgültig gelöscht → Verknüpfung wird beim Aufräumen gelöst
  await api('DELETE', `/docs/${ids.doc}/purge`);
  housekeeping();
  assert.equal((await api('GET', '/assets/' + ids.host)).data.asset.doc, null);
});

test('CSV: Export und Import (anlegen, aktualisieren, Fehler je Zeile)', async () => {
  const csv = await (await fetch(base + '/api/assets/export.csv', { headers: { cookie } })).text();
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0].slice(0, 6), ['typ', 'name', 'status', 'laeuft_auf', 'ips', 'tags']);
  assert.ok(rows[0].includes('feld:CPU'));
  assert.ok(rows.some(r => r[1] === 'pve-01' && /10\.0\.0\.160 \[aa:bb:cc:dd:ee:ff\]/.test(r[4])));
  const imp = await api('POST', '/assets/import', { csv: 'Typ;Name;Status;laeuft_auf;ips;os;feld:Garantie\nVM;docker-01;aktiv;pve-01;10.0.0.20 (Hauptadresse);Debian 13;2028\nServer;pve-01;Wartung;;10.0.0.160, 10.0.0.5;;2027\nVM;kaputt;;;999.1.1.1;;\nGerät;"Switch; Keller";;;10.0.0.2;;' });
  assert.equal(imp.status, 200);
  assert.deepEqual([imp.data.created, imp.data.updated, imp.data.errors.length], [2, 1, 1]);
  assert.equal(imp.data.errors[0].line, 4);
  const all = (await api('GET', '/assets')).data.assets;
  const vm = all.find(a => a.name === 'docker-01');
  assert.equal(vm.parent, ids.host);
  assert.deepEqual(vm.ips, [{ address: '10.0.0.20', note: 'Hauptadresse' }]);
  assert.deepEqual(vm.data.custom, [{ label: 'Garantie', value: '2028' }]);
  assert.equal(all.find(a => a.name === 'pve-01').status, 'maintenance');
  assert.ok(all.find(a => a.name === 'Switch; Keller'));
  // Eigene Felder erscheinen auf der Karte im Dokument
  assert.match(md(`::asset {"id":"${vm.id}"}`, { assets: { [vm.id]: vm } }).html, /<dt>Garantie<\/dt><dd>2028<\/dd>/);
});

test('KI: Papierkorb, Versionen, Ordner, Vorlagen, Inventar löschen', async () => {
  const folder = (await api('GET', '/folders')).data.folders[0].id;
  const c = await call('create_document', { title: 'KI-Seite', folder, content: 'Stand 1' });
  const id = c.structuredContent.id;
  await call('update_document', { id, version: 1, content: 'Stand 2' });
  const revs = await call('list_revisions', { id });
  assert.equal(revs.structuredContent.revisions.length, 1);
  const rev = revs.structuredContent.revisions[0].revision;
  assert.match((await call('list_revisions', { id, revision: rev })).content[0].text, /Stand 1/);
  const back = await call('restore_revision', { id, revision: rev });
  assert.equal(back.isError, false);
  assert.equal((await api('GET', '/docs')).data.docs.find(d => d.id === id).content, 'Stand 1');
  // Papierkorb
  await call('delete_document', { id });
  assert.ok((await call('list_trash', {})).structuredContent.documents.some(d => d.id === id));
  assert.equal((await call('restore_document', { id })).isError, false);
  assert.ok((await api('GET', '/docs')).data.docs.some(d => d.id === id));
  // Ordner
  const f = await call('create_folder', { name: 'Zwischenablage' });
  const fid = f.structuredContent.id;
  assert.equal((await call('update_folder', { id: fid, name: 'Archiv', parent: folder })).isError, false);
  const fl = (await api('GET', '/folders')).data.folders.find(x => x.id === fid);
  assert.deepEqual([fl.name, fl.parent], ['Archiv', folder]);
  assert.equal((await call('update_folder', { id: folder, parent: fid })).isError, true, 'kein Kreis');
  assert.equal((await call('delete_folder', { id: folder })).isError, true, 'nicht leer');
  assert.equal((await call('delete_folder', { id: fid })).isError, false);
  // Vorlage
  const t = await call('save_template', { name: 'Aus KI', from_document: id });
  assert.equal(t.isError, false);
  assert.equal((await call('create_document', { title: 'Aus Vorlage', folder, template: t.structuredContent.id })).isError, false);
  // Inventar löschen
  const a = await call('save_asset', { kind: 'device', name: 'alt-switch' });
  assert.equal((await call('delete_asset', { id: a.structuredContent.id })).isError, false);
  assert.equal((await call('get_asset', { id: a.structuredContent.id })).isError, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('doc.restored','doc.revision_restored','folder.deleted','asset.deleted','template.created')").get().n >= 5, true);
});
