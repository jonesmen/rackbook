import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rackbook-editor-'));
process.env.DATA_DIR = dir;
process.env.COOKIE_SECURE = 'false';
process.env.RATE_LIMIT_AUTH = '1000';

const { createApp, initDatabase, housekeeping } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { sniff } = await import('../server/files.js');
const { parse, serialize, md, inline, embedInfo } = await import('../public/js/md.js');

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
  const fn = async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  fn.upload = async (name, buf, type = 'application/octet-stream', doc) => {
    const qs = new URLSearchParams({ name, ...(doc ? { doc } : {}) });
    const res = await fetch(`${base}/api/files?${qs}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': type }, body: buf });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  fn.raw = (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return fn;
}
async function login(username) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
  return client(res.headers.getSetCookie()[0].split(';')[0], (await res.json()).csrfToken);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let admin, viewer;
const ids = {};

test('Setup', async () => {
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'chef', password: PW }) });
  admin = client(reg.headers.getSetCookie()[0].split(';')[0], (await reg.json()).csrfToken);
  await admin('POST', '/admin/users', { username: 'leser', password: PW, role: 'viewer', mustChangePassword: false });
  viewer = await login('leser');
  ids.doc = (await admin('POST', '/docs', { title: 'Medien', folder: 'netzwerk', content: 'Start' })).data.doc.id;
});

test('Markdown: alle Blocktypen überstehen Parsen und Speichern unverändert', () => {
  const src = [
    '## Abschnitt', 'Text mit **fett**, *kursiv*, `code`, $x^2$, {{date:2026-01-31}}, {{time:08:15}}, {{status:Offen|red}} und Fußnote[^1].\\\nneue Zeile',
    '> [!WARNING]\n> Vorsicht', '> Zitat', '- a\n- b', '1. eins\n2. zwei', '- [ ] offen\n- [x] fertig',
    '```bash\necho hi\n```', '```math\n\\int x\n```', '```mermaid\ngraph LR\n  A --> B\n```',
    '```kanban\n{"columns":[{"id":"c","title":"Offen","color":"gray","cards":[{"id":"k","title":"Karte","note":""}]}]}\n```',
    '```base\n{"title":"T","columns":[{"id":"n","name":"Name","type":"text","options":[]}],"rows":[{"id":"r","cells":{"n":"x"}}]}\n```',
    '---', '::pagebreak', '::subpages', '![Bild](/files/abcdefghijklmnopqrst "Unterschrift")', '::pdf {"src":"/files/abcdefghijklmnopqrst","name":"a.pdf"}',
    '::embed {"url":"https://youtu.be/dQw4w9WgXcQ"}', '::drawio {"src":"/files/abcdefghijklmnopqrst"}', '::synced {"id":"sb_abcdefghij"}',
    ':::toggle Mehr\n- [ ] innen\n:::', ':::columns\n:::column\nLinks\n:::\n:::column\nRechts\n:::\n:::', '| A | B |\n|---|---|\n| 1 | 2 |', '[^1]: Erklärung',
  ].join('\n\n');
  const out = serialize(parse(src));
  assert.equal(out, src);
  const types = parse(src).map(b => b.type);
  for (const t of ['h', 'p', 'callout', 'quote', 'bullet', 'number', 'todo', 'code', 'math', 'mermaid', 'kanban', 'base', 'hr', 'pagebreak', 'subpages', 'image', 'pdf', 'embed', 'drawio', 'synced', 'toggle', 'columns', 'table', 'footnote']) {
    assert.ok(types.includes(t), `Blocktyp ${t} fehlt`);
  }
  // Aufgaben in verschachtelten Blöcken behalten ihre Zeilennummer (Abhaken im Lesemodus)
  const r = md(src, { interactive: true });
  const lines = src.split('\n');
  for (const m of r.html.matchAll(/data-task-line="(\d+)"/g)) assert.match(lines[Number(m[1])], /^- \[[ x]\]/);
});

test('Markdown-Renderer ist gegen Skript-Einschleusung abgesichert', () => {
  const evil = [
    '[x](javascript:alert(1))', '<img src=x onerror=alert(1)>', '![a](javascript:alert(1))', '![a](data:image/svg+xml;base64,AAAA)',
    '::embed {"url":"javascript:alert(1)"}', '::embed {"url":"http://unsicher.example"}', '::image {"src":"\\" onerror=\\"alert(1)"}',
    '```kanban\n{"columns":[{"title":"<script>alert(1)</script>","cards":[{"title":"<img src=x onerror=alert(1)>"}]}]}\n```',
    '{{status:<b>x</b>|red" onclick="x}}', '$<svg onload=alert(1)>$', ':::toggle <script>x</script>\nInhalt\n:::',
  ].join('\n\n');
  const h = md(evil, { embeds: true }).html;
  // Alles Gefährliche erscheint nur als escapter Text, nie als Tag oder Attribut
  assert.doesNotMatch(h, /<(script|svg|b)\b|<img src=x/i);
  for (const tag of h.match(/<[a-z][^>]*>/gi)) {
    const attrs = [...tag.matchAll(/\s([\w-]+)="([^"]*)"/g)];
    for (const [, name, value] of attrs) {
      assert.doesNotMatch(name, /^on/i, tag);
      if (/^(href|src)$/.test(name)) assert.doesNotMatch(value, /^\s*(javascript|data|vbscript):/i, tag);
    }
    // außer Attributen in Anführungszeichen darf nichts im Tag stehen
    assert.match(tag.replace(/\s[\w-]+="[^"]*"/g, ''), /^<[a-z0-9]+(\s[\w-]+)*\s*>$/i, tag);
  }
  assert.equal(inline('[a](vbscript:x)'), 'a');
  // Externe Bilder/Einbettungen nur wenn erlaubt
  assert.doesNotMatch(md('![a](https://example.com/a.png)', { embeds: false }).html, /<img/);
  assert.match(md('![a](https://example.com/a.png)', { embeds: true }).html, /<img/);
  assert.doesNotMatch(md('::embed {"url":"https://youtu.be/dQw4w9WgXcQ"}', { embeds: false }).html, /<iframe/);
});

test('Einbettungen: Anbieter werden erkannt und auf Einbett-URLs umgeschrieben', () => {
  assert.equal(embedInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ').src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedInfo('https://vimeo.com/123456').src, 'https://player.vimeo.com/video/123456');
  assert.equal(embedInfo('https://www.loom.com/share/abc123').src, 'https://www.loom.com/embed/abc123');
  assert.equal(embedInfo('https://miro.com/app/board/uXjV=/').provider, 'miro');
  assert.equal(embedInfo('https://docs.google.com/spreadsheets/d/1abc/edit').src, 'https://docs.google.com/spreadsheets/d/1abc/preview');
  assert.equal(embedInfo('https://drive.google.com/file/d/XYZ/view').src, 'https://drive.google.com/file/d/XYZ/preview');
  assert.match(embedInfo('https://www.figma.com/design/abc/Name').src, /^https:\/\/www\.figma\.com\/embed\?/);
  assert.equal(embedInfo('http://example.com'), null);
  assert.equal(embedInfo('javascript:alert(1)'), null);
});

test('Datei-Typ wird anhand des Inhalts erkannt, nicht anhand des Namens', () => {
  assert.equal(sniff(PNG, 'x.pdf'), 'image/png');
  assert.equal(sniff(Buffer.from('%PDF-1.7 ...'), 'x.png'), 'application/pdf');
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>'), 'x.png'), 'application/octet-stream');
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.svg'), 'image/svg+xml');
  assert.equal(sniff(Buffer.from('ID3....'), 'a.mp3'), 'audio/mpeg');
});

test('Upload: nur Bearbeiter, sichere Auslieferung, Größenlimit', async () => {
  assert.equal((await viewer.upload('a.png', PNG, 'image/png')).status, 403);
  const up = await admin.upload('Netzplan.png', PNG, 'image/png', ids.doc);
  assert.equal(up.status, 201);
  assert.equal(up.data.file.mime, 'image/png');
  assert.match(up.data.file.url, /^\/files\/[A-Za-z0-9_-]{20}$/);
  ids.png = up.data.file;

  const r = await admin.raw(ids.png.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.match(r.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  // Ohne Anmeldung kein Zugriff
  assert.equal((await fetch(base + ids.png.url)).status, 401);
  // HTML getarnt als Bild → Download, niemals als HTML ausgeliefert
  const h = await admin.upload('x.png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
  assert.equal(h.data.file.mime, 'application/octet-stream');
  const hr = await admin.raw(h.data.file.url);
  assert.equal(hr.headers.get('content-type'), 'application/octet-stream');
  assert.match(hr.headers.get('content-disposition'), /^attachment/);
  // SVG nur mit Sandbox (kein Skript, eigener Ursprung)
  const svg = await admin.upload('d.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
  const sr = await admin.raw(svg.data.file.url);
  assert.equal(sr.headers.get('content-type'), 'image/svg+xml');
  assert.match(sr.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  // Leere Datei / JSON abgelehnt
  assert.equal((await admin.upload('leer.bin', Buffer.alloc(0))).status, 400);
  // Größenlimit
  await admin('PUT', '/admin/editor', { uploadMaxMb: 1 });
  assert.equal((await admin.upload('gross.bin', Buffer.alloc(1048576 + 10))).status, 413);
  // Uploads abschaltbar
  await admin('PUT', '/admin/editor', { uploads: false });
  assert.equal((await admin.upload('a.png', PNG, 'image/png')).status, 403);
  await admin('PUT', '/admin/editor', { uploads: true, uploadMaxMb: 25 });
  assert.equal((await admin('PUT', '/admin/editor', { drawioUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await viewer('PUT', '/admin/editor', { uploads: false })).status, 403);
});

test('Freigaben enthalten signierte Datei-Links – nur für eingebundene Dateien', async () => {
  await admin('PUT', '/docs/' + ids.doc, { content: `![Plan](${ids.png.url})\n\n::synced {"id":"sb_platzhalter"}` });
  const sh = await admin('POST', '/shares', { kind: 'doc', target: ids.doc, expiresDays: 1 });
  const p = await fetch(base + '/api/public/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sh.data.token }) }).then(r => r.json());
  const signed = p.files[ids.png.id];
  assert.match(signed, /^\/files\/[A-Za-z0-9_-]{20}\?e=\d+&s=[\w-]+$/);
  assert.equal(Object.keys(p.files).length, 1, 'nur referenzierte Dateien');
  const ok = await fetch(base + signed);
  assert.equal(ok.status, 200);
  // Manipulierte Signatur, fremde Datei oder abgelaufener Link
  assert.equal((await fetch(base + signed.replace(/s=[\w-]+/, 's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).status, 403);
  const other = (await admin.upload('b.png', PNG, 'image/png')).data.file;
  assert.equal((await fetch(base + other.url + signed.slice(signed.indexOf('?')))).status, 403);
  assert.equal((await fetch(base + signed.replace(/e=\d+/, 'e=1000'))).status, 403);
});

test('Synchronisierte Blöcke: anlegen, ändern, nicht verschachtelbar, in Freigaben enthalten', async () => {
  assert.equal((await viewer('POST', '/synced', { content: 'x' })).status, 403);
  const c = await admin('POST', '/synced', { content: 'Gemeinsam **wichtig**' });
  assert.equal(c.status, 201);
  const id = c.data.block.id;
  assert.equal((await admin('POST', '/synced', { content: `::synced {"id":"${id}"}` })).status, 400);
  const u = await admin('PUT', '/synced/' + id, { content: 'Neu', version: c.data.block.version });
  assert.equal(u.data.block.content, 'Neu');
  assert.equal((await admin('PUT', '/synced/' + id, { content: 'Alt', version: c.data.block.version })).status, 409);
  assert.ok((await viewer('GET', '/synced')).data.blocks.some(b => b.id === id));
  await admin('PUT', '/docs/' + ids.doc, { content: `Vorher\n\n::synced {"id":"${id}"}` });
  const sh = await admin('POST', '/shares', { kind: 'doc', target: ids.doc, expiresDays: 1 });
  const p = await fetch(base + '/api/public/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: sh.data.token }) }).then(r => r.json());
  assert.deepEqual(p.synced, { [id]: 'Neu' });
  ids.synced = id;
});

test('Automatisches Speichern legt nicht für jede Änderung eine Version an', async () => {
  const d = (await admin('POST', '/docs', { title: 'Auto', folder: 'netzwerk', content: 'v0' })).data.doc;
  let v = d.version;
  for (let i = 1; i <= 5; i++) v = (await admin('PUT', '/docs/' + d.id, { content: 'v' + i, version: v, autosave: true })).data.doc.version;
  const revs = (await admin('GET', `/docs/${d.id}/revisions`)).data.revisions;
  assert.equal(revs.length, 1, 'eine Version pro Bearbeitungssitzung');
  assert.equal(revs[0].content, 'v0');
  // Normales Speichern legt weiterhin jedes Mal eine Version an
  await admin('PUT', '/docs/' + d.id, { content: 'manuell', version: v });
  assert.equal((await admin('GET', `/docs/${d.id}/revisions`)).data.revisions.length, 2);
});

test('CSP: Einbettungen nur, wenn erlaubt', async () => {
  let csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /frame-src 'self' https:/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.match(csp, /script-src 'self'(;|$)/);
  await admin('PUT', '/admin/editor', { embeds: false, drawioUrl: 'https://draw.example.org' });
  csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /frame-src 'self' https:\/\/draw\.example\.org(;|$)/);
  assert.match(csp, /img-src 'self' data: blob:(;|$)/);
  assert.equal((await admin('GET', '/meta')).data.editor.embeds, false);
  await admin('PUT', '/admin/editor', { embeds: true, drawioUrl: 'https://embed.diagrams.net' });
  // Excalidraw-/Mermaid-Seiten dürfen nur von Rackbook selbst eingebettet werden
  for (const p of ['/excalidraw.html', '/mermaid-frame.html']) {
    const h = (await fetch(base + p)).headers;
    assert.match(h.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  }
});

test('Komplett-Backup enthält Dateien und synchronisierte Blöcke und lässt sich einspielen', async () => {
  const b = await admin('GET', '/admin/backup?files');
  assert.equal(b.data.format, 3);
  assert.ok(b.data.files.some(f => f.id === ids.png.id && f.data));
  assert.ok(b.data.synced.some(s => s.id === ids.synced));
  // Datei löschen und aus dem Backup wiederherstellen
  db.prepare('DELETE FROM files WHERE id = ?').run(ids.png.id);
  assert.equal((await admin.raw(ids.png.url)).status, 404);
  const r = await admin('POST', '/admin/restore', b.data);
  assert.equal(r.status, 200);
  assert.ok(r.data.files >= 1);
  assert.equal((await admin.raw(ids.png.url)).status, 200);
});

test('Aufräumen: unbenutzte Dateien verschwinden, benutzte bleiben', async () => {
  const orphan = (await admin.upload('weg.png', PNG, 'image/png')).data.file;
  db.prepare('UPDATE files SET created_at = ?').run(Date.now() - 2 * 86400000);
  housekeeping();
  assert.equal((await admin.raw(orphan.url)).status, 404);
  assert.equal((await admin.raw(ids.png.url)).status, 200, 'in einer Version referenziert → bleibt');
});
