import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-tree-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');

let server, base, admin;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: 'Ein-Langes-Passwort-1' }) });
  admin = { cookie: res.headers.getSetCookie()[0].split(';')[0], csrf: (await res.json()).csrfToken };
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('Unterordner: anlegen, Zyklen und Tiefe werden verhindert, Löschen nur wenn leer', async () => {
  let r = await api('POST', '/folders', { name: 'Projekte', icon: 'folder_special' });
  assert.equal(r.status, 201);
  const projekte = r.data.folder.id;
  r = await api('POST', '/folders', { name: 'Rackbook', parent: projekte });
  assert.equal(r.data.folder.parent, projekte);
  const rb = r.data.folder.id;
  r = await api('PATCH', '/folders/' + projekte, { parent: rb });
  assert.equal(r.status, 400, 'Zyklus');
  let parent = rb;
  for (let i = 0; i < 3; i++) parent = (await api('POST', '/folders', { name: 'Ebene ' + i, parent })).data.folder.id;
  r = await api('POST', '/folders', { name: 'Zu tief', parent });
  assert.equal(r.status, 400, 'max. 5 Ebenen');
  r = await api('DELETE', '/folders/' + projekte);
  assert.equal(r.status, 409, 'enthält Unterordner');
});

test('Unterseiten: Ordner der Elternseite, Mitverschieben, Zyklen, Löschen & Wiederherstellen des Teilbaums', async () => {
  const folders = (await api('GET', '/folders')).data.folders;
  const rb = folders.find(f => f.name === 'Rackbook').id;
  const main = (await api('POST', '/docs', { title: 'Rackbook', folder: rb, content: 'Übersicht' })).data.doc;
  const sso = (await api('POST', '/docs', { title: 'SSO', folder: 'netzwerk', parent: main.id, content: 'x' })).data.doc;
  assert.equal(sso.parent, main.id);
  assert.equal(sso.folder, rb, 'Unterseite liegt im Ordner der Elternseite');
  const deep = (await api('POST', '/docs', { title: 'Authentik-Gruppen', parent: sso.id, content: 'y' })).data.doc;
  let r = await api('PUT', '/docs/' + main.id, { parent: deep.id, version: main.version });
  assert.equal(r.status, 400, 'Zyklus');
  // Hauptdokument in anderen Ordner verschieben → Unterseiten wandern mit
  r = await api('PUT', '/docs/' + main.id, { folder: 'dienste', version: main.version });
  assert.equal(r.data.doc.folder, 'dienste');
  let docs = (await api('GET', '/docs')).data.docs;
  assert.equal(docs.find(d => d.id === deep.id).folder, 'dienste');
  // Unterseite nur im Ordner verschieben → löst sich von der Elternseite
  const ssoNow = docs.find(d => d.id === sso.id);
  r = await api('PUT', '/docs/' + sso.id, { folder: 'backup', version: ssoNow.version });
  assert.equal(r.data.doc.parent, null);
  // wieder einhängen
  r = await api('PUT', '/docs/' + sso.id, { parent: main.id, version: r.data.doc.version });
  assert.equal(r.data.doc.folder, 'dienste');
  // Löschen nimmt Unterseiten mit, Wiederherstellen bringt sie zurück
  r = await api('DELETE', '/docs/' + main.id);
  assert.equal(r.data.deleted.length, 3);
  docs = (await api('GET', '/docs')).data.docs;
  assert.ok(!docs.some(d => [main.id, sso.id, deep.id].includes(d.id)));
  r = await api('POST', `/docs/${main.id}/restore`, {});
  assert.equal(r.data.docs.length, 3);
  docs = (await api('GET', '/docs')).data.docs;
  assert.equal(docs.find(d => d.id === deep.id).parent, sso.id);
});

test('Backup enthält die Hierarchie und stellt sie wieder her', async () => {
  const b = await fetch(base + '/api/admin/backup', { headers: { cookie: admin.cookie } }).then(r => r.json());
  assert.ok(b.folders.some(f => f.parent));
  assert.ok(b.documents.some(d => d.parent));
  const sub = b.documents.find(d => d.title === 'SSO');
  await api('PUT', '/docs/' + sub.id, { parent: '', version: (await api('GET', '/docs/' + sub.id)).data.doc.version });
  const r = await api('POST', '/admin/restore', b);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/docs/' + sub.id)).data.doc.parent, sub.parent);
});

test('MCP: Projektstruktur mit Unterordnern und Unterseiten, Pfade in den Antworten', async () => {
  await api('PUT', '/admin/mcp', { enabled: true, allowFolders: true });
  const token = (await api('POST', '/me/mcp-tokens', { name: 'KI', scopes: ['read', 'write', 'folders'] })).data.token;
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  assert.match(c.getInstructions(), /Hauptdokument/);
  let r = await c.callTool({ name: 'create_folder', arguments: { name: 'Homelab', parent: 'projekte' } });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /Projekte \/ Homelab/);
  const ov = await c.callTool({ name: 'rackbook_overview', arguments: {} });
  assert.match(ov.content[0].text, /\n {2}- `homelab`/, 'Unterordner eingerückt');
  r = await c.callTool({ name: 'create_document', arguments: { title: 'Homelab', folder: 'homelab', content: 'Übersicht' } });
  const mainId = r.structuredContent.id;
  assert.ok(r.structuredContent.updatedBy, 'updatedBy ist gesetzt');
  r = await c.callTool({ name: 'create_document', arguments: { title: 'Netzplan', parent: mainId, content: 'VLANs' } });
  assert.equal(r.isError, false, r.content[0].text);
  assert.equal(r.structuredContent.parent, mainId);
  assert.equal(r.structuredContent.folder, 'homelab');
  r = await c.callTool({ name: 'get_document', arguments: { id: mainId } });
  assert.match(r.content[0].text, /Unterseiten: Netzplan/);
  r = await c.callTool({ name: 'list_documents', arguments: { folder: 'projekte' } });
  assert.ok(r.structuredContent.documents.some(d => d.title === 'Netzplan'), 'Ordnerfilter inkl. Unterordner');
  await c.close();
});
