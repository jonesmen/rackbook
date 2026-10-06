import { Router } from 'express';
import { db, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, randomToken } from '../security.js';
import { audit, requireRole } from '../auth.js';
import { checkFolderParent, checkDocParent, moveDocSubtree, docDescendants } from '../tree.js';

const r = Router();
const editor = requireRole('editor');
const admin = requireRole('admin');

// ---------- Hilfsfunktionen ----------
export const ctrlStrip = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export function normTitle(t) {
  const s = ctrlStrip(t).replace(/\s+/g, ' ').trim().slice(0, 200);
  return s || 'Unbenanntes Dokument';
}
export function normTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const out = [];
  for (const t of list) {
    const n = String(t).trim().replace(/^#+/, '').toLowerCase().replace(/[^a-z0-9äöüß._+-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}
export function normContent(c) {
  const s = ctrlStrip(c).replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(s) > config.maxDocBytes) throw new HttpError(413, `Dokument zu groß (max. ${Math.round(config.maxDocBytes / 1024)} KB).`);
  return s;
}
export function folderExists(id) {
  return !!db.prepare('SELECT 1 FROM folders WHERE id = ?').get(String(id || ''));
}
const firstFolder = () => db.prepare('SELECT id FROM folders ORDER BY sort, name LIMIT 1').get()?.id;

// Ordner/Eltern-Seite bei Änderungen bestimmen. Unterseiten liegen immer im Ordner ihrer Elternseite;
// wird nur der Ordner gewechselt, löst sich das Dokument von seiner Elternseite.
export function resolvePlacement(d, b, folder) {
  if (b.parent !== undefined) {
    const p = checkDocParent(d.id, b.parent);
    return p.parent ? { parent: p.parent, folder: p.folder } : { parent: null, folder };
  }
  if (d.parent_id && folder !== d.folder_id) return { parent: null, folder };
  return { parent: d.parent_id ?? null, folder };
}

const DOC_SELECT = `SELECT d.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
  EXISTS(SELECT 1 FROM bookmarks b WHERE b.doc_id = d.id AND b.user_id = ?) AS bookmarked
  FROM documents d LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by`;

export function toDto(d) {
  return {
    id: d.id, title: d.title, folder: d.folder_id, parent: d.parent_id ?? null, tags: JSON.parse(d.tags || '[]'), content: d.content,
    pinned: !!d.pinned, bookmarked: !!d.bookmarked, version: d.version,
    created: d.created_at, createdBy: d.created_by_name ?? null,
    updated: d.updated_at, updatedBy: d.updated_by_name ?? null, updatedVia: d.updated_via || 'web',
    reviewed: d.reviewed_at ?? null, deleted: d.deleted_at ?? null,
  };
}

function loadDoc(req, id, { includeDeleted = false } = {}) {
  const d = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(req.user.id, String(id));
  if (!d || (d.deleted_at && !includeDeleted)) throw new HttpError(404, 'Dokument nicht gefunden.');
  return d;
}

export function saveRevision(d, userId) {
  db.prepare(`INSERT INTO revisions (doc_id, version, title, folder_id, tags, content, created_at, created_by, via)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.id, d.version, d.title, d.folder_id, d.tags, d.content, d.updated_at, d.updated_by ?? userId, d.updated_via ?? null);
  db.prepare(`DELETE FROM revisions WHERE doc_id = ? AND id NOT IN
              (SELECT id FROM revisions WHERE doc_id = ? ORDER BY version DESC LIMIT ?)`).run(d.id, d.id, config.revisionLimit);
}

export function insertDoc({ id, title, folder, parent = null, tags, content, pinned = false, created, updated }, userId, via = 'web') {
  const now = Date.now();
  const docId = id || randomToken(9);
  db.prepare(`INSERT INTO documents (id, title, folder_id, parent_id, content, tags, pinned, created_at, created_by, updated_at, updated_by, updated_via)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(docId, normTitle(title), folder, parent, normContent(content), JSON.stringify(normTags(tags)), pinned ? 1 : 0,
      created || updated || now, userId, updated || now, userId, via);
  return docId;
}

// ---------- Ordner ----------
r.get('/folders', (req, res) => {
  res.json({ folders: db.prepare('SELECT id, name, icon, hue, sort, parent_id AS parent FROM folders ORDER BY sort, name').all() });
});

function folderInput(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = ctrlStrip(body.name).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!out.name) throw new HttpError(400, 'Bitte einen Ordnernamen angeben.');
  }
  if (!partial || body.icon !== undefined) {
    out.icon = String(body.icon || 'folder');
    if (!/^[a-z0-9_]{1,40}$/.test(out.icon)) throw new HttpError(400, 'Ungültiges Icon.');
  }
  if (!partial || body.hue !== undefined) {
    out.hue = Math.round(Number(body.hue ?? 250));
    if (!(out.hue >= 0 && out.hue <= 360)) throw new HttpError(400, 'Farbton muss zwischen 0 und 360 liegen.');
  }
  if (body.parent !== undefined) out.parent_id = body.parent || null;
  return out;
}

r.post('/folders', editor, (req, res) => {
  const f = folderInput(req.body || {}, false);
  const base = f.name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ordner';
  let id = base, i = 2;
  while (folderExists(id)) id = `${base}-${i++}`;
  const parent = checkFolderParent(null, f.parent_id);
  const sort = (db.prepare('SELECT MAX(sort) AS m FROM folders').get().m ?? 0) + 1;
  db.prepare('INSERT INTO folders (id, name, icon, hue, sort, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, f.name, f.icon, f.hue, sort, parent, Date.now());
  audit(req, 'folder.created', id, { name: f.name, parent });
  res.status(201).json({ folder: db.prepare('SELECT id, name, icon, hue, sort, parent_id AS parent FROM folders WHERE id = ?').get(id) });
});

r.patch('/folders/:id', editor, (req, res) => {
  if (!folderExists(req.params.id)) throw new HttpError(404, 'Ordner nicht gefunden.');
  const f = folderInput(req.body || {}, true);
  if (f.parent_id !== undefined) f.parent_id = checkFolderParent(req.params.id, f.parent_id);
  const sets = Object.keys(f);
  if (sets.length) db.prepare(`UPDATE folders SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(k => f[k]), req.params.id);
  audit(req, 'folder.updated', req.params.id, f);
  res.json({ folder: db.prepare('SELECT id, name, icon, hue, sort, parent_id AS parent FROM folders WHERE id = ?').get(req.params.id) });
});

r.post('/folders/order', editor, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  tx(() => ids.forEach((id, i) => db.prepare('UPDATE folders SET sort = ? WHERE id = ?').run(i, id)));
  res.json({ folders: db.prepare('SELECT id, name, icon, hue, sort, parent_id AS parent FROM folders ORDER BY sort, name').all() });
});

r.delete('/folders/:id', admin, (req, res) => {
  const id = String(req.params.id);
  if (!folderExists(id)) throw new HttpError(404, 'Ordner nicht gefunden.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE folder_id = ? AND deleted_at IS NULL').get(id).n;
  if (n) throw new HttpError(409, `Der Ordner enthält noch ${n} Dokument(e). Bitte zuerst verschieben oder löschen.`);
  const subs = db.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?').get(id).n;
  if (subs) throw new HttpError(409, `Der Ordner enthält noch ${subs} Unterordner. Bitte zuerst verschieben oder löschen.`);
  if (db.prepare('SELECT COUNT(*) AS n FROM folders').get().n <= 1) throw new HttpError(409, 'Der letzte Ordner kann nicht gelöscht werden.');
  tx(() => {
    const other = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id).parent_id
      || db.prepare('SELECT id FROM folders WHERE id <> ? ORDER BY sort LIMIT 1').get(id).id;
    db.prepare('UPDATE documents SET folder_id = ? WHERE folder_id = ?').run(other, id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  });
  audit(req, 'folder.deleted', id);
  res.json({ ok: true });
});

// ---------- Dokumente ----------
r.get('/docs', (req, res) => {
  const rows = db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC`).all(req.user.id);
  res.json({ docs: rows.map(toDto) });
});

r.get('/docs/trash', editor, (req, res) => {
  const rows = db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`).all(req.user.id);
  res.json({ docs: rows.map(d => ({ ...toDto(d), content: undefined })), retentionDays: config.trashRetentionDays });
});

r.get('/docs/:id', (req, res) => res.json({ doc: toDto(loadDoc(req, req.params.id)) }));

r.post('/docs', editor, (req, res) => {
  const b = req.body || {};
  const p = checkDocParent(null, b.parent);
  const folder = p.folder || (folderExists(b.folder) ? b.folder : firstFolder());
  const id = insertDoc({ title: b.title, folder, parent: p.parent, tags: b.tags, content: b.content ?? '' }, req.user.id);
  audit(req, 'doc.created', id, { title: normTitle(b.title) });
  res.status(201).json({ doc: toDto(loadDoc(req, id)) });
});

r.put('/docs/:id', editor, (req, res) => {
  const b = req.body || {};
  const doc = tx(() => {
    const d = loadDoc(req, req.params.id);
    if (b.version !== undefined && Number(b.version) !== d.version) {
      throw new HttpError(409, 'Das Dokument wurde inzwischen von jemand anderem geändert.', { doc: toDto(d) });
    }
    if (b.folder !== undefined && !folderExists(b.folder)) throw new HttpError(400, 'Ordner existiert nicht.');
    const next = {
      title: b.title !== undefined ? normTitle(b.title) : d.title,
      folder: b.folder !== undefined ? b.folder : d.folder_id,
      parent: d.parent_id ?? null,
      tags: b.tags !== undefined ? JSON.stringify(normTags(b.tags)) : d.tags,
      content: b.content !== undefined ? normContent(b.content) : d.content,
    };
    Object.assign(next, resolvePlacement(d, b, next.folder));
    if (next.title === d.title && next.folder === d.folder_id && next.parent === (d.parent_id ?? null) && next.tags === d.tags && next.content === d.content) return d;
    saveRevision(d, req.user.id);
    db.prepare(`UPDATE documents SET title = ?, folder_id = ?, parent_id = ?, tags = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = 'web'
                WHERE id = ?`).run(next.title, next.folder, next.parent, next.tags, next.content, Date.now(), req.user.id, d.id);
    if (next.folder !== d.folder_id) moveDocSubtree(d.id, next.folder);
    return loadDoc(req, d.id);
  });
  audit(req, 'doc.updated', doc.id, { title: doc.title, version: doc.version });
  res.json({ doc: toDto(doc) });
});

r.post('/docs/:id/pin', editor, (req, res) => {
  const d = loadDoc(req, req.params.id);
  db.prepare('UPDATE documents SET pinned = ? WHERE id = ?').run(req.body?.pinned ? 1 : 0, d.id);
  res.json({ doc: toDto(loadDoc(req, d.id)) });
});

r.post('/docs/:id/bookmark', (req, res) => {
  const d = loadDoc(req, req.params.id);
  if (req.body?.bookmarked) db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, doc_id, created_at) VALUES (?, ?, ?)').run(req.user.id, d.id, Date.now());
  else db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND doc_id = ?').run(req.user.id, d.id);
  res.json({ doc: toDto(loadDoc(req, d.id)) });
});

r.post('/docs/:id/review', editor, (req, res) => {
  const d = loadDoc(req, req.params.id);
  db.prepare('UPDATE documents SET reviewed_at = ? WHERE id = ?').run(Date.now(), d.id);
  audit(req, 'doc.reviewed', d.id, { title: d.title });
  res.json({ doc: toDto(loadDoc(req, d.id)) });
});

// Checkbox einer Aufgabenliste umschalten. Die Zeile wird gegen den erwarteten Text geprüft.
r.post('/docs/:id/todo', editor, (req, res) => {
  const { line, text, checked } = req.body || {};
  const doc = tx(() => {
    const d = loadDoc(req, req.params.id);
    const lines = d.content.split('\n');
    const l = lines[Number(line)];
    const m = typeof l === 'string' && l.match(/^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/);
    if (!m || (text !== undefined && m[4] !== text)) throw new HttpError(409, 'Die Aufgabe wurde inzwischen geändert. Bitte neu laden.');
    lines[Number(line)] = m[1] + (checked ? 'x' : ' ') + m[3] + m[4];
    saveRevision(d, req.user.id);
    db.prepare("UPDATE documents SET content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = 'web' WHERE id = ?")
      .run(lines.join('\n'), Date.now(), req.user.id, d.id);
    return loadDoc(req, d.id);
  });
  res.json({ doc: toDto(doc) });
});

r.delete('/docs/:id', editor, (req, res) => {
  const d = loadDoc(req, req.params.id);
  const now = Date.now();
  const ids = [d.id, ...docDescendants(d.id)];
  tx(() => ids.forEach(id => db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now, req.user.id, id)));
  audit(req, 'doc.deleted', d.id, { title: d.title, subpages: ids.length - 1 });
  res.json({ ok: true, deleted: ids });
});

r.post('/docs/:id/restore', editor, (req, res) => {
  const d = loadDoc(req, req.params.id, { includeDeleted: true });
  if (!d.deleted_at) return res.json({ doc: toDto(d), docs: [toDto(d)] });
  const ids = [d.id, ...docDescendants(d.id, { includeDeleted: true }).filter(id => db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(id).deleted_at === d.deleted_at)];
  tx(() => {
    ids.forEach(id => db.prepare('UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(id));
    // Liegt die Elternseite noch im Papierkorb, wird das Dokument zur obersten Seite.
    const parent = d.parent_id && db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(d.parent_id);
    if (d.parent_id && (!parent || parent.deleted_at)) db.prepare('UPDATE documents SET parent_id = NULL WHERE id = ?').run(d.id);
  });
  audit(req, 'doc.restored', d.id, { title: d.title, subpages: ids.length - 1 });
  res.json({ doc: toDto(loadDoc(req, d.id)), docs: ids.map(id => toDto(loadDoc(req, id))) });
});

r.delete('/docs/:id/purge', admin, (req, res) => {
  const d = loadDoc(req, req.params.id, { includeDeleted: true });
  if (!d.deleted_at) throw new HttpError(409, 'Nur Dokumente im Papierkorb können endgültig gelöscht werden.');
  const ids = docDescendants(d.id, { includeDeleted: true }).filter(id => db.prepare('SELECT deleted_at FROM documents WHERE id = ?').get(id).deleted_at);
  tx(() => {
    // Nicht gelöschte Unterseiten (z. B. später wiederhergestellt) werden zu obersten Seiten.
    db.prepare('UPDATE documents SET parent_id = NULL WHERE parent_id = ? AND deleted_at IS NULL').run(d.id);
    [...ids.reverse(), d.id].forEach(id => db.prepare('DELETE FROM documents WHERE id = ?').run(id));
  });
  audit(req, 'doc.purged', d.id, { title: d.title });
  res.json({ ok: true });
});

// ---------- Versionen ----------
r.get('/docs/:id/revisions', (req, res) => {
  const d = loadDoc(req, req.params.id);
  const rows = db.prepare(`SELECT r.id, r.version, r.title, r.folder_id, r.tags, r.content, r.created_at, r.via, u.display_name AS author
                           FROM revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.doc_id = ? ORDER BY r.version DESC`).all(d.id);
  res.json({
    revisions: rows.map(x => ({
      id: x.id, version: x.version, title: x.title, folder: x.folder_id, tags: JSON.parse(x.tags), content: x.content, created: x.created_at, author: x.author, via: x.via || 'web',
    })),
  });
});

r.post('/docs/:id/revisions/:rev/restore', editor, (req, res) => {
  const doc = tx(() => {
    const d = loadDoc(req, req.params.id);
    const rev = db.prepare('SELECT * FROM revisions WHERE id = ? AND doc_id = ?').get(Number(req.params.rev), d.id);
    if (!rev) throw new HttpError(404, 'Version nicht gefunden.');
    saveRevision(d, req.user.id);
    const folder = !d.parent_id && folderExists(rev.folder_id) ? rev.folder_id : d.folder_id;
    db.prepare(`UPDATE documents SET title = ?, folder_id = ?, tags = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = 'web' WHERE id = ?`)
      .run(rev.title, folder, rev.tags, rev.content, Date.now(), req.user.id, d.id);
    if (folder !== d.folder_id) moveDocSubtree(d.id, folder);
    return loadDoc(req, d.id);
  });
  audit(req, 'doc.revision_restored', doc.id, { title: doc.title, revision: Number(req.params.rev) });
  res.json({ doc: toDto(doc) });
});

// ---------- Markdown-Import ----------
r.post('/import', editor, (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 100) : [];
  if (!files.length) throw new HttpError(400, 'Keine Dateien übergeben.');
  const folder = folderExists(req.body?.folder) ? req.body.folder : firstFolder();
  const ids = tx(() => files.map(f => {
    const txt = normContent(String(f.text || ''));
    const m = txt.match(/^#\s+(.+)\n?/);
    const title = m ? m[1].trim() : String(f.name || 'Import').replace(/\.(md|markdown|txt)$/i, '');
    return insertDoc({ title, folder, tags: ['import'], content: (m ? txt.replace(m[0], '') : txt).trim() }, req.user.id);
  }));
  audit(req, 'doc.imported', null, { count: ids.length });
  res.status(201).json({ docs: ids.map(id => toDto(loadDoc(req, id))) });
});

export default r;
