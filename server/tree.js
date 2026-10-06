// Hierarchien: Unterordner (folders.parent_id) und Unterseiten (documents.parent_id).
import { db } from './db.js';
import { HttpError } from './security.js';

export const MAX_FOLDER_DEPTH = 5; // Ebenen inkl. oberster Ordner
export const MAX_DOC_DEPTH = 6;

// ---------- Ordner ----------
const folderRow = id => db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(String(id || ''));

export function folderAncestors(id) {
  const out = [];
  let cur = folderRow(id);
  while (cur && cur.parent_id && out.length < 50) {
    out.push(cur.parent_id);
    cur = folderRow(cur.parent_id);
  }
  return out; // nächster Elternordner zuerst
}

export function folderDescendants(id) {
  const all = db.prepare('SELECT id, parent_id FROM folders').all();
  const out = new Set([String(id)]);
  let added = true;
  while (added) {
    added = false;
    for (const f of all) if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); added = true; }
  }
  return out; // inkl. id selbst
}

function subtreeHeight(id) {
  const kids = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(id);
  return 1 + (kids.length ? Math.max(...kids.map(k => subtreeHeight(k.id))) : 0);
}

// Prüft, ob `id` (neu: null) unter `parent` gehängt werden darf.
export function checkFolderParent(id, parent) {
  if (parent === null || parent === undefined || parent === '') return null;
  const p = folderRow(parent);
  if (!p) throw new HttpError(400, 'Übergeordneter Ordner existiert nicht.');
  if (id && folderDescendants(id).has(p.id)) throw new HttpError(400, 'Ein Ordner kann nicht in sich selbst oder einen seiner Unterordner verschoben werden.');
  const depth = folderAncestors(p.id).length + 1 + (id ? subtreeHeight(id) : 1);
  if (depth > MAX_FOLDER_DEPTH) throw new HttpError(400, `Maximal ${MAX_FOLDER_DEPTH} Ordnerebenen möglich.`);
  return p.id;
}

// ---------- Dokumente ----------
const docRow = id => db.prepare('SELECT id, parent_id, folder_id, deleted_at FROM documents WHERE id = ?').get(String(id || ''));

export function docAncestors(id) {
  const out = [];
  let cur = docRow(id);
  while (cur && cur.parent_id && out.length < 50) {
    out.push(cur.parent_id);
    cur = docRow(cur.parent_id);
  }
  return out;
}

export function docDescendants(id, { includeDeleted = false } = {}) {
  const out = [];
  const queue = [String(id)];
  while (queue.length) {
    const cur = queue.shift();
    const kids = db.prepare(`SELECT id FROM documents WHERE parent_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).all(cur);
    for (const k of kids) if (!out.includes(k.id)) { out.push(k.id); queue.push(k.id); }
  }
  return out; // ohne id selbst
}

function docSubtreeHeight(id) {
  const kids = db.prepare('SELECT id FROM documents WHERE parent_id = ? AND deleted_at IS NULL').all(id);
  return 1 + (kids.length ? Math.max(...kids.map(k => docSubtreeHeight(k.id))) : 0);
}

// Prüft eine Eltern-Seite; liefert { parent, folder } – Unterseiten liegen immer im Ordner der Elternseite.
export function checkDocParent(id, parent) {
  if (parent === null || parent === undefined || parent === '') return { parent: null, folder: null };
  const p = docRow(parent);
  if (!p || p.deleted_at) throw new HttpError(400, 'Übergeordnetes Dokument existiert nicht.');
  if (id && (p.id === id || docDescendants(id).includes(p.id))) throw new HttpError(400, 'Ein Dokument kann nicht unter sich selbst oder einer eigenen Unterseite liegen.');
  const depth = docAncestors(p.id).length + 1 + (id ? docSubtreeHeight(id) : 1);
  if (depth > MAX_DOC_DEPTH) throw new HttpError(400, `Maximal ${MAX_DOC_DEPTH} Seitenebenen möglich.`);
  return { parent: p.id, folder: p.folder_id };
}

// Verschiebt alle Unterseiten in den Ordner ihrer obersten Seite.
export function moveDocSubtree(id, folder) {
  const ids = docDescendants(id, { includeDeleted: true });
  for (const d of ids) db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(folder, d);
  return ids.length;
}
