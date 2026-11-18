// Export als ZIP: Markdown-Dateien in der Ordner- und Seitenstruktur, Anhänge unter „_dateien/“.
// Das Archiv wird gestreamt geschrieben (ohne Kompression – Markdown ist klein, Bilder sind schon komprimiert).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { once } from 'node:events';
import { Router } from 'express';
import { db } from './db.js';
import { HttpError } from './security.js';
import { audit } from './auth.js';
import { folderDescendants } from './tree.js';
import { filesDir, fileRefs } from './files.js';

const dosTime = d => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
// Dateinamen: keine Pfadzeichen, nichts, was Windows ablehnt
export const safeName = s => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'Unbenannt');

class ZipWriter {
  constructor(out) { this.out = out; this.entries = []; this.offset = 0; this.names = new Set(); }
  async write(buf) { this.offset += buf.length; if (!this.out.write(buf)) await once(this.out, 'drain'); }
  unique(name) {
    let n = name, i = 2;
    const dot = name.lastIndexOf('.') > name.lastIndexOf('/') ? name.lastIndexOf('.') : name.length;
    while (this.names.has(n.toLowerCase())) n = `${name.slice(0, dot)} (${i++})${name.slice(dot)}`;
    this.names.add(n.toLowerCase());
    return n;
  }
  // source: Buffer oder Pfad einer Datei. Größe/Prüfsumme stehen im Datenbeschreiber hinter den Daten.
  async add(name, source, mtime = new Date()) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0808, 6); // Datenbeschreiber + UTF-8
    head.writeUInt16LE(0, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
    head.writeUInt16LE(nameBuf.length, 26);
    const start = this.offset;
    await this.write(head); await this.write(nameBuf);
    let crc = 0, size = 0;
    if (Buffer.isBuffer(source)) { crc = crc32(source); size = source.length; await this.write(source); }
    else for await (const chunk of createReadStream(source)) { crc = crc32(chunk, crc); size += chunk.length; await this.write(chunk); }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4); desc.writeUInt32LE(size, 8); desc.writeUInt32LE(size, 12);
    await this.write(desc);
    this.entries.push({ nameBuf, crc: crc >>> 0, size, start, time, date });
  }
  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(0, 10); c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.start, 42);
      await this.write(c); await this.write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    await this.write(end);
  }
}

export const exportApi = Router();

// GET /api/export/zip[?folder=<id>] – alle Dokumente oder ein Ordner samt Unterordnern
exportApi.get('/zip', async (req, res) => {
  const folders = db.prepare('SELECT id, name, parent_id FROM folders').all();
  const byId = new Map(folders.map(f => [f.id, f]));
  let scope = null, rootName = 'rackbook';
  if (req.query.folder) {
    const f = byId.get(String(req.query.folder));
    if (!f) throw new HttpError(404, 'Ordner nicht gefunden.');
    scope = folderDescendants(f.id);
    rootName = safeName(f.name);
  }
  const docs = db.prepare('SELECT id, title, folder_id, parent_id, tags, content, updated_at FROM documents WHERE deleted_at IS NULL ORDER BY title').all().filter(d => !scope || scope.has(d.folder_id));
  if (!docs.length) throw new HttpError(404, 'Hier gibt es keine Dokumente zum Exportieren.');
  const docById = new Map(docs.map(d => [d.id, d]));
  // Ordnerpfad (relativ zum exportierten Ordner)
  const folderPath = id => {
    const parts = [];
    for (let f = byId.get(id), g = 0; f && g < 20; f = byId.get(f.parent_id), g++) { if (scope && f.id === String(req.query.folder)) break; parts.unshift(safeName(f.name)); }
    return parts;
  };
  // Seitenpfad: Unterseiten liegen in einem Ordner mit dem Namen der Elternseite
  const paths = new Map();
  const dirOf = d => {
    const chain = [];
    for (let p = d.parent_id && docById.get(d.parent_id), g = 0; p && g < 20; p = p.parent_id && docById.get(p.parent_id), g++) chain.unshift(safeName(p.title));
    return [...folderPath(d.folder_id), ...chain];
  };
  const size = docs.reduce((n, d) => n + d.content.length, 0);
  audit(req, 'doc.exported_zip', req.query.folder ? String(req.query.folder) : null, { documents: docs.length });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${rootName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}-${new Date().toISOString().slice(0, 10)}.zip"; filename*=UTF-8''${encodeURIComponent(rootName)}-${new Date().toISOString().slice(0, 10)}.zip`);
  res.setHeader('X-Export-Size', String(size));
  const zip = new ZipWriter(res);
  for (const d of docs) paths.set(d.id, zip.unique([...dirOf(d), safeName(d.title) + '.md'].join('/')));
  // Anhänge, die in den exportierten Dokumenten vorkommen
  const files = new Map();
  for (const d of docs) for (const id of fileRefs(d.content)) {
    if (files.has(id)) continue;
    const f = db.prepare('SELECT id, name FROM files WHERE id = ?').get(id);
    const p = f && join(filesDir, id.slice(0, 2), id);
    if (f && existsSync(p)) files.set(id, { path: p, name: zip.unique('_dateien/' + safeName(f.name)) });
  }
  const rel = (from, to) => { const up = from.split('/').length - 1; return '../'.repeat(up) + to.split('/').map(encodeURIComponent).join('/'); };
  try {
    for (const d of docs) {
      const me = paths.get(d.id);
      // Verweise auf Dateien und andere Seiten so umschreiben, dass sie im entpackten Ordner funktionieren
      let body = d.content.replace(/\/files\/([A-Za-z0-9_-]{20})(?![A-Za-z0-9_-])(\?[^)\s"]*)?/g, (m, id) => (files.has(id) ? rel(me, files.get(id).name) : m));
      body = body.replace(/\]\(\/doc\/([A-Za-z0-9_-]+)\)/g, (m, id) => (paths.has(id) ? `](${rel(me, paths.get(id))})` : m));
      const tags = JSON.parse(d.tags || '[]');
      const front = `---\ntitle: ${JSON.stringify(d.title)}\n${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}updated: ${new Date(d.updated_at).toISOString()}\n---\n\n`;
      await zip.add(me, Buffer.from(front + `# ${d.title}\n\n` + body + '\n', 'utf8'), new Date(d.updated_at));
    }
    for (const f of files.values()) await zip.add(f.name, f.path, statSync(f.path).mtime);
    await zip.finish();
    res.end();
  } catch (e) {
    console.error('ZIP-Export:', e);
    res.destroy(e);
  }
});
