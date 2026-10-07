import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-mcp-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase } = await import('../server/app.js');

let server, base;
before(async () => {
  initDatabase();
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, { cookie, csrf, body } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}
async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  return { cookie: r.res.headers.getSetCookie()[0].split(';')[0], csrf: r.data.csrfToken };
}
async function mcpClient(token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const rpc = (token, body, headers = {}) => fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: JSON.stringify(body),
});

const PW = 'Ein-Langes-Passwort-1';
let admin, editor, viewer;

test('Setup: Benutzer anlegen, MCP ist standardmäßig aus', async () => {
  const reg = await api('POST', '/auth/register', { body: { username: 'chef', password: PW } });
  admin = { cookie: reg.res.headers.getSetCookie()[0].split(';')[0], csrf: reg.data.csrfToken };
  await api('POST', '/admin/users', { ...admin, body: { username: 'edi', password: PW, role: 'editor', mustChangePassword: false } });
  await api('POST', '/admin/users', { ...admin, body: { username: 'leo', password: PW, role: 'viewer', mustChangePassword: false } });
  editor = await login('edi', PW);
  viewer = await login('leo', PW);
  const r = await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Claude', scopes: ['read'] } });
  assert.equal(r.status, 403);
  const off = await rpc('rbm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(off.status, 403);
});

let editorToken, viewerToken;
test('Admin aktiviert MCP; Rechte werden durch Rolle und Systemeinstellungen begrenzt', async () => {
  let r = await api('PUT', '/admin/mcp', { ...admin, body: { enabled: true, allowWrite: true, allowDelete: false, guidelines: 'Hostnamen immer klein schreiben.' } });
  assert.equal(r.status, 200);
  const meta = await api('GET', '/meta', editor);
  assert.deepEqual(meta.data.mcp.grantable, ['read', 'write', 'files']);
  r = await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Claude', scopes: ['read', 'write', 'delete'] } });
  assert.equal(r.status, 403, 'delete ist global nicht erlaubt');
  r = await api('POST', '/me/mcp-tokens', { ...viewer, body: { name: 'Leser', scopes: ['read', 'write'] } });
  assert.equal(r.status, 403, 'Leser darf kein Schreibrecht vergeben');
  r = await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Claude', scopes: ['read', 'write'], expiresDays: 30 } });
  assert.equal(r.status, 201);
  editorToken = r.data.token;
  assert.match(editorToken, /^rbm_/);
  const list = await api('GET', '/me/mcp-tokens', editor);
  assert.equal(list.data.tokens.length, 1);
  assert.equal(JSON.stringify(list.data).includes(editorToken), false, 'Token wird nur einmal angezeigt');
  viewerToken = (await api('POST', '/me/mcp-tokens', { ...viewer, body: { name: 'Leser', scopes: ['read'] } })).data.token;
});

test('Offizieller MCP-Client: initialize, Anleitung, Werkzeuge, Prompts, Ressourcen', async () => {
  const c = await mcpClient(editorToken);
  const instructions = c.getInstructions();
  assert.match(instructions, /Erst suchen, dann schreiben/);
  assert.match(instructions, /Hostnamen immer klein schreiben/);
  assert.match(instructions, /`netzwerk`/);
  const { tools } = await c.listTools();
  const names = tools.map(t => t.name);
  assert.ok(names.includes('create_document') && names.includes('replace_in_document'));
  assert.ok(!names.includes('delete_document'), 'nicht erlaubte Werkzeuge werden nicht angeboten');
  const prompts = await c.listPrompts();
  assert.ok(prompts.prompts.some(p => p.name === 'dienst_dokumentieren'));
  const p = await c.getPrompt({ name: 'dienst_dokumentieren', arguments: { dienst: 'Nextcloud' } });
  assert.match(p.messages[0].content.text, /Nextcloud/);
  const guide = await c.readResource({ uri: 'rackbook://guide' });
  assert.match(guide.contents[0].text, /Unterstütztes Markdown/);
  await c.close();
});

let docId;
test('KI legt Dokument an, ergänzt, ersetzt und aktualisiert es', async () => {
  const c = await mcpClient(editorToken);
  let r = await c.callTool({ name: 'create_document', arguments: { title: 'Nextcloud', folder: 'dienste', tags: ['Docker', 'cloud'], content: '# Nextcloud\n\nLäuft auf `docker-01`.\n\n## Offene Punkte\n\n- [ ] Backup einrichten' } });
  assert.equal(r.isError, false, r.content[0].text);
  docId = r.structuredContent.id;
  assert.deepEqual(r.structuredContent.tags, ['docker', 'cloud', 'ki']);
  r = await c.callTool({ name: 'create_document', arguments: { title: 'nextcloud', folder: 'dienste', content: 'x' } });
  assert.equal(r.isError, true, 'Duplikat wird erkannt');
  r = await c.callTool({ name: 'create_document', arguments: { title: 'X', folder: 'gibtsnicht', content: 'x' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Verfügbare Ordner/);
  r = await c.callTool({ name: 'append_to_document', arguments: { id: docId, section: 'Offene Punkte', content: '- [ ] Redis-Cache prüfen' } });
  assert.equal(r.isError, false);
  r = await c.callTool({ name: 'append_to_document', arguments: { id: docId, section: 'Zugriff', content: 'URL: `https://cloud.example.de`' } });
  r = await c.callTool({ name: 'replace_in_document', arguments: { id: docId, old_text: '- [ ] Backup einrichten', new_text: '- [x] Backup einrichten' } });
  assert.equal(r.isError, false);
  r = await c.callTool({ name: 'get_document', arguments: { id: docId } });
  const content = r.structuredContent.content;
  assert.ok(!content.startsWith('# '), 'H1 wird entfernt');
  assert.match(content, /- \[x\] Backup einrichten\n- \[ \] Redis-Cache prüfen/);
  assert.match(content, /## Zugriff\n\nURL/);
  assert.equal(r.structuredContent.version, 4);
  // Versionskonflikt
  r = await c.callTool({ name: 'update_document', arguments: { id: docId, version: 1, content: 'alt' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Versionskonflikt/);
  r = await c.callTool({ name: 'update_document', arguments: { id: docId, version: 4, title: 'Nextcloud AIO' } });
  assert.equal(r.isError, false);
  r = await c.callTool({ name: 'search_documents', arguments: { query: 'cloud.example.de' } });
  assert.equal(r.structuredContent.results[0].id, docId);
  await c.close();
  // Änderungen sind in der Weboberfläche als KI-Änderung sichtbar und versioniert
  const web = await api('GET', '/docs/' + docId, editor);
  assert.equal(web.data.doc.updatedVia, 'mcp');
  const revs = await api('GET', `/docs/${docId}/revisions`, editor);
  assert.equal(revs.data.revisions.length, 4);
  const audit = await api('GET', '/admin/audit', admin);
  assert.ok(audit.data.entries.some(e => e.action === 'doc.updated' && e.details.via === 'mcp' && e.details.token === 'Claude'));
});

test('Leser-Token darf nur lesen', async () => {
  const c = await mcpClient(viewerToken);
  const { tools } = await c.listTools();
  assert.ok(tools.every(t => t.annotations.readOnlyHint));
  const r = await c.callTool({ name: 'create_document', arguments: { title: 'Hack', folder: 'dienste', content: 'x' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Keine Berechtigung/);
  await c.close();
});

test('Ordner-Beschränkung eines Tokens', async () => {
  const t = (await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Nur Netzwerk', scopes: ['read', 'write'], folders: ['netzwerk'] } })).data.token;
  const c = await mcpClient(t);
  let r = await c.callTool({ name: 'get_document', arguments: { id: docId } });
  assert.equal(r.isError, true, 'Dokument aus anderem Ordner unsichtbar');
  r = await c.callTool({ name: 'create_document', arguments: { title: 'VLANs', folder: 'dienste', content: 'x' } });
  assert.equal(r.isError, true);
  r = await c.callTool({ name: 'create_document', arguments: { title: 'VLANs', folder: 'netzwerk', content: 'x' } });
  assert.equal(r.isError, false);
  await c.close();
});

test('Rechteänderungen wirken sofort auf bestehende Tokens', async () => {
  await api('PUT', '/admin/mcp', { ...admin, body: { allowWrite: false } });
  const c = await mcpClient(editorToken);
  const { tools } = await c.listTools();
  assert.ok(!tools.some(t => t.name === 'create_document'));
  await c.close();
  await api('PUT', '/admin/mcp', { ...admin, body: { allowWrite: true } });
  // Herabstufung des Benutzers entzieht Schreibrechte
  const users = (await api('GET', '/admin/users', admin)).data.users;
  const edi = users.find(u => u.username === 'edi');
  await api('PATCH', '/admin/users/' + edi.id, { ...admin, body: { role: 'viewer' } });
  const c2 = await mcpClient(editorToken);
  const r = await c2.callTool({ name: 'append_to_document', arguments: { id: docId, content: 'x' } });
  assert.equal(r.isError, true);
  await c2.close();
  await api('PATCH', '/admin/users/' + edi.id, { ...admin, body: { role: 'editor' } });
});

test('Dateien: hochladen, ins Dokument einfügen, auflisten und lesen', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAAASUVORK5CYII=';
  editor = await login('edi', PW); // Rollenwechsel im vorigen Test hat die Sitzungen beendet
  const tr = await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Dateien', scopes: ['read', 'write', 'files'] } });
  assert.equal(tr.status, 201, JSON.stringify(tr.data));
  const ft = tr.data.token;
  const c = await mcpClient(ft);
  const names = (await c.listTools()).tools.map(t => t.name);
  assert.ok(['list_files', 'read_file', 'upload_file'].every(n => names.includes(n)));
  // Bild hochladen und direkt in einen Abschnitt einfügen
  let r = await c.callTool({ name: 'upload_file', arguments: { name: 'netzplan.png', data: PNG, document: docId, section: 'Bilder', caption: 'Netzplan' } });
  assert.equal(r.isError, false, r.content[0].text);
  const img = r.structuredContent.file;
  assert.equal(img.mime, 'image/png');
  assert.equal(r.structuredContent.markdown, `![Netzplan](/files/${img.id})`);
  const doc = (await c.callTool({ name: 'get_document', arguments: { id: docId } })).content[0].text;
  assert.match(doc, new RegExp(`## Bilder\\n\\n!\\[Netzplan\\]\\(/files/${img.id}\\)`));
  // Textdatei ohne Dokument
  r = await c.callTool({ name: 'upload_file', arguments: { name: 'docker-compose.yml', text: 'services:\n  app:\n    image: nginx\n' } });
  const yml = r.structuredContent.file;
  assert.match(r.content[0].text, /::file \{"src":"\/files\//);
  // Auflisten (alle und je Dokument)
  r = await c.callTool({ name: 'list_files', arguments: { document: docId } });
  assert.deepEqual(r.structuredContent.files.map(f => f.id), [img.id]);
  r = await c.callTool({ name: 'list_files', arguments: { query: 'compose' } });
  assert.deepEqual(r.structuredContent.files.map(f => f.id), [yml.id]);
  // Lesen: Bild als Bild, Text als Text, PDF als Ressource
  r = await c.callTool({ name: 'read_file', arguments: { id: img.id } });
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/png');
  r = await c.callTool({ name: 'read_file', arguments: { id: `/files/${yml.id}` } });
  assert.match(r.content[0].text, /image: nginx/);
  const pdf = (await c.callTool({ name: 'upload_file', arguments: { name: 'handbuch.pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') } })).structuredContent.file;
  r = await c.callTool({ name: 'read_file', arguments: { id: pdf.id } });
  assert.equal(r.content[1].type, 'resource');
  assert.equal(r.content[1].resource.mimeType, 'application/pdf');
  // Ungültige Eingaben
  assert.equal((await c.callTool({ name: 'upload_file', arguments: { name: 'x.bin', data: '###' } })).isError, true);
  assert.equal((await c.callTool({ name: 'read_file', arguments: { id: 'gibtEsNichtgibtEsNic' } })).isError, true);
  await c.close();

  // Ohne „files“-Recht kein Upload; Lesen bleibt erlaubt
  const ro = (await api('POST', '/me/mcp-tokens', { ...editor, body: { name: 'Nur lesen', scopes: ['read'] } })).data.token;
  const c2 = await mcpClient(ro);
  assert.ok(!(await c2.listTools()).tools.some(t => t.name === 'upload_file'));
  assert.equal((await c2.callTool({ name: 'upload_file', arguments: { name: 'a.txt', text: 'x' } })).isError, true);
  assert.equal((await c2.callTool({ name: 'read_file', arguments: { id: img.id } })).isError, false);
  await c2.close();

  // Ordner-beschränktes Token sieht nur Dateien aus freigegebenen Dokumenten
  const nt = (await api('POST', '/me/mcp-tokens', { ...viewer, body: { name: 'Netz', scopes: ['read'], folders: ['netzwerk'] } })).data.token;
  const c3 = await mcpClient(nt);
  assert.equal((await c3.callTool({ name: 'read_file', arguments: { id: img.id } })).isError, true, 'Bild liegt in einem nicht freigegebenen Dokument');
  assert.deepEqual((await c3.callTool({ name: 'list_files', arguments: {} })).structuredContent.files, []);
  await c3.close();

  // Uploads global abschaltbar; Admin kann das Datei-Recht für MCP entziehen
  await api('PUT', '/admin/editor', { ...admin, body: { uploads: false } });
  const c4 = await mcpClient(ft);
  assert.match((await c4.callTool({ name: 'upload_file', arguments: { name: 'a.txt', text: 'x' } })).content[0].text, /deaktiviert/);
  await api('PUT', '/admin/editor', { ...admin, body: { uploads: true } });
  await api('PUT', '/admin/mcp', { ...admin, body: { allowFiles: false } });
  assert.ok(!(await c4.listTools()).tools.some(t => t.name === 'upload_file'));
  await api('PUT', '/admin/mcp', { ...admin, body: { allowFiles: true } });
  await c4.close();
});

test('Sicherheit: große Anfragen nur mit gültigem Token', async () => {
  const big = { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(5 * 1048576) } };
  const r = await rpc('rbm_ungueltigungueltigungueltigungueltig', big);
  assert.equal(r.status, 413, 'ohne gültiges Token wird kein großer Körper gelesen');
});

test('Sicherheit: ungültige Tokens, fremde Origin, Widerruf, keine Cookie-Authentifizierung', async () => {
  let r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /Bearer/);
  r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' }, { cookie: admin.cookie });
  assert.equal(r.status, 401, 'Sitzungs-Cookie gilt nicht für MCP');
  r = await rpc(editorToken, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await fetch(base + '/mcp', { headers: { authorization: `Bearer ${editorToken}` } });
  assert.equal(r.status, 405);
  const list = await api('GET', '/admin/mcp', admin);
  const tok = list.data.tokens.find(t => t.name === 'Claude');
  await api('DELETE', '/admin/mcp-tokens/' + tok.id, admin);
  r = await rpc(editorToken, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(r.status, 401);
});
