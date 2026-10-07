// Öffentliche Freigaben per Link (ohne Konto, nur lesend).
//
// Sicherheitsmodell:
// - Token: 32 Byte Zufall (256 Bit), in der DB nur als SHA-256-Hash. Der Link nutzt das URL-Fragment
//   (/share#<token>), damit das Token nicht in Server-, Proxy- oder Referrer-Logs auftaucht.
// - Optionales Passwort (scrypt), Fehlversuche pro Freigabe und IP begrenzt.
// - Bei JEDEM Aufruf wird neu geprüft: Freigaben aktiviert, nicht widerrufen/abgelaufen, Ersteller aktiv
//   und (noch) berechtigt. Nicht-Admins geben nur eigene Inhalte frei – auch innerhalb eines Ordners.
import { getSynced, syncedRefs } from './synced.js';
import { getAsset } from './assets.js';
import { fileRefs, signedFileUrl, getEditorSettings } from './files.js';
import { db, getSetting, setSetting } from './db.js';
import { HttpError, randomToken, sha256, hashPassword, verifyPassword, dummyVerify, RateLimiter } from './security.js';
import { folderDescendants, docDescendants, folderAncestors, docAncestors } from './tree.js';

export const SHARE_DEFAULTS = {
  enabled: true,
  maxDays: 30,          // 0 = unbegrenzt
  defaultDays: 7,
  requirePassword: false,
  allowEditors: true,   // Bearbeiter dürfen eigene Inhalte teilen
};
export const getShareSettings = () => ({ ...SHARE_DEFAULTS, ...getSetting('sharing', {}) });

export function saveShareSettings(b = {}) {
  const s = getShareSettings();
  for (const k of ['enabled', 'requirePassword', 'allowEditors']) if (b[k] !== undefined) s[k] = !!b[k];
  for (const k of ['maxDays', 'defaultDays']) {
    if (b[k] === undefined) continue;
    const n = Math.round(Number(b[k]));
    if (!(n >= 0 && n <= 3650)) throw new HttpError(400, 'Zeitraum: 0 (unbegrenzt) bis 3650 Tage.');
    s[k] = n;
  }
  if (s.maxDays > 0 && (s.defaultDays === 0 || s.defaultDays > s.maxDays)) s.defaultDays = s.maxDays;
  setSetting('sharing', s);
  return s;
}

const loadTarget = (kind, id) => (kind === 'doc'
  ? db.prepare('SELECT id, title, folder_id, created_by, deleted_at FROM documents WHERE id = ?').get(String(id || ''))
  : db.prepare('SELECT id, name AS title, created_by FROM folders WHERE id = ?').get(String(id || '')));

// Darf `user` dieses Element (noch) teilen?
export function mayShare(user, kind, target, s = getShareSettings()) {
  if (!s.enabled || !user || user.status !== 'active') return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'editor' || !s.allowEditors) return false;
  return !!target && target.created_by === user.id;
}

function titleOf(sh) {
  const t = loadTarget(sh.kind, sh.target_id);
  if (!t) return '(gelöscht)';
  if (sh.kind === 'folder') return [...folderAncestors(t.id).reverse().map(id => db.prepare('SELECT name FROM folders WHERE id = ?').get(id)?.name), t.title].filter(Boolean).join(' / ');
  return t.title;
}

export function shareDto(sh) {
  const now = Date.now();
  return {
    id: sh.id, kind: sh.kind, target: sh.target_id, title: titleOf(sh), includeChildren: !!sh.include_children,
    hasPassword: !!sh.password_hash, label: sh.label || '', createdAt: sh.created_at, expiresAt: sh.expires_at,
    expired: !!(sh.expires_at && sh.expires_at < now), revoked: !!sh.revoked_at, viewCount: sh.view_count, lastViewedAt: sh.last_viewed_at,
    ...(sh.username ? { username: sh.username, displayName: sh.display_name, userId: sh.user_id } : {}),
  };
}

export function listShares({ userId, kind, target, includeInactive = false } = {}) {
  const where = [], args = [];
  if (userId) { where.push('s.user_id = ?'); args.push(userId); }
  if (kind) { where.push('s.kind = ? AND s.target_id = ?'); args.push(kind, String(target)); }
  if (!includeInactive) { where.push('s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)'); args.push(Date.now()); }
  return db.prepare(`SELECT s.*, u.username, u.display_name FROM shares s JOIN users u ON u.id = s.user_id
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.created_at DESC`).all(...args).map(shareDto);
}

export async function createShare(user, b = {}) {
  const s = getShareSettings();
  if (!s.enabled) throw new HttpError(403, 'Das Teilen per Link ist deaktiviert.');
  const kind = b.kind === 'folder' ? 'folder' : b.kind === 'doc' ? 'doc' : null;
  if (!kind) throw new HttpError(400, 'Ungültiger Typ.');
  const target = loadTarget(kind, b.target);
  if (!target || target.deleted_at) throw new HttpError(404, kind === 'doc' ? 'Dokument nicht gefunden.' : 'Ordner nicht gefunden.');
  if (!mayShare(user, kind, target, s)) throw new HttpError(403, 'Du kannst nur selbst erstellte Inhalte teilen.');

  // Laufzeit: Standard aus den Einstellungen; Maximum gilt für alle außer Administratoren.
  let days = b.expiresDays === undefined || b.expiresDays === null || b.expiresDays === '' ? s.defaultDays : Math.round(Number(b.expiresDays));
  if (!(days >= 0 && days <= 3650)) throw new HttpError(400, 'Ungültige Laufzeit.');
  if (user.role !== 'admin' && s.maxDays > 0 && (days === 0 || days > s.maxDays)) {
    throw new HttpError(403, `Freigaben dürfen höchstens ${s.maxDays} Tage gültig sein.`);
  }
  const password = typeof b.password === 'string' ? b.password : '';
  if (s.requirePassword && !password) throw new HttpError(400, 'Für Freigaben ist ein Passwort vorgeschrieben.');
  if (password && (password.length < 6 || password.length > 200)) throw new HttpError(400, 'Das Passwort muss 6–200 Zeichen lang sein.');
  const label = String(b.label || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
  if (db.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(user.id, Date.now()).n >= 200) {
    throw new HttpError(409, 'Zu viele aktive Freigaben. Bitte alte widerrufen.');
  }
  const token = randomToken(32);
  const now = Date.now();
  const info = db.prepare(`INSERT INTO shares (token_hash, user_id, kind, target_id, include_children, password_hash, label, created_at, expires_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), user.id, kind, target.id, b.includeChildren === false ? 0 : 1, password ? await hashPassword(password) : null, label || null, now, days > 0 ? now + days * 86400000 : null);
  return { token, share: shareDto(db.prepare('SELECT * FROM shares WHERE id = ?').get(info.lastInsertRowid)) };
}

export function revokeShare(id, actor, { onlyOwn = true } = {}) {
  const sh = db.prepare('SELECT * FROM shares WHERE id = ?').get(Number(id));
  if (!sh || (onlyOwn && sh.user_id !== actor.id && actor.role !== 'admin')) throw new HttpError(404, 'Freigabe nicht gefunden.');
  if (!sh.revoked_at) db.prepare('UPDATE shares SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(Date.now(), actor.id, sh.id);
  return sh;
}

export function revokeAllOfUser(userId, actor) {
  return db.prepare('UPDATE shares SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), actor.id, userId).changes;
}

export function activeShareCounts() {
  const rows = db.prepare('SELECT user_id, COUNT(*) AS n FROM shares WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) GROUP BY user_id').all(Date.now());
  return Object.fromEntries(rows.map(r => [r.user_id, r.n]));
}

// ---------- Öffentlicher Abruf ----------
const pwLimiter = new RateLimiter(5, 15 * 60000);
const GONE = () => new HttpError(404, 'Dieser Link ist ungültig, abgelaufen oder wurde widerrufen.');

export async function resolvePublic(token, password, ip) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw GONE();
  const s = getShareSettings();
  const sh = db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(sha256(token));
  if (!s.enabled || !sh || sh.revoked_at || (sh.expires_at && sh.expires_at < Date.now())) { if (password) await dummyVerify(password); throw GONE(); }
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(sh.user_id);
  const target = loadTarget(sh.kind, sh.target_id);
  if (!owner || !target || target.deleted_at || !mayShare(owner, sh.kind, target, s)) throw GONE();

  if (sh.password_hash) {
    const key = `${sh.id}:${ip}`;
    if (!password) throw new HttpError(401, 'Passwort erforderlich.', { passwordRequired: true });
    if (!pwLimiter.hit(key)) throw new HttpError(429, 'Zu viele Fehlversuche. Bitte später erneut versuchen.', { passwordRequired: true });
    if (!(await verifyPassword(String(password), sh.password_hash))) throw new HttpError(401, 'Das Passwort ist falsch.', { passwordRequired: true, wrongPassword: true });
    pwLimiter.reset(key);
  }

  // Sichtbare Inhalte bestimmen. Nicht-Admins geben nur eigene Dokumente frei.
  const ownOnly = owner.role !== 'admin';
  const visible = d => !d.deleted_at && (!ownOnly || d.created_by === owner.id);
  const pick = 'id, title, folder_id, parent_id, content, tags, updated_at, created_by, deleted_at';
  let docs = [], folders = [];
  if (sh.kind === 'doc') {
    const ids = [target.id, ...(sh.include_children ? docDescendants(target.id) : [])];
    docs = ids.map(id => db.prepare(`SELECT ${pick} FROM documents WHERE id = ?`).get(id)).filter(d => d && visible(d));
  } else {
    const set = sh.include_children ? folderDescendants(target.id) : new Set([target.id]);
    folders = db.prepare('SELECT id, name, icon, hue, parent_id FROM folders ORDER BY sort, name').all().filter(f => set.has(f.id));
    docs = db.prepare(`SELECT ${pick} FROM documents WHERE deleted_at IS NULL`).all().filter(d => set.has(d.folder_id) && visible(d));
  }
  if (!docs.length && sh.kind === 'doc') throw GONE();
  docs = docs.slice(0, 1000);
  const ids = new Set(docs.map(d => d.id));
  db.prepare('UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?').run(Date.now(), sh.id);
  // Eingebundene synchronisierte Blöcke und Dateien: nur was in den freigegebenen Dokumenten vorkommt.
  const synced = getSynced(new Set(docs.flatMap(d => [...syncedRefs(d.content)])));
  const fileIds = new Set([...docs.map(d => d.content), ...Object.values(synced)].flatMap(c => [...fileRefs(c)]));
  const files = {};
  for (const id of fileIds) if (db.prepare('SELECT 1 FROM files WHERE id = ?').get(id)) files[id] = signedFileUrl(id);
  const ed = getEditorSettings();
  // Inventar-Karten (::asset) in freigegebenen Dokumenten – ohne interne Notizen und Verknüpfungen
  const assets = {};
  for (const c of [...docs.map(d => d.content), ...Object.values(synced)]) {
    for (const m of String(c).matchAll(/^::asset\s+\{\s*"id"\s*:\s*"([A-Za-z0-9_-]{4,40})"/gm)) {
      const a = getAsset(m[1]);
      if (a) { const { notes, ...data } = a.data; assets[a.id] = { id: a.id, kind: a.kind, name: a.name, status: a.status, ips: a.ips, tags: a.tags, data }; }
    }
  }
  return {
    synced, files, assets, embeds: ed.embeds,
    kind: sh.kind, root: target.id, title: target.title, expiresAt: sh.expires_at,
    folders: folders.map(f => ({ id: f.id, name: f.name, icon: f.icon, hue: f.hue, parent: f.id === target.id ? null : f.parent_id })),
    // Elternverweise außerhalb der Freigabe werden gekappt, damit nichts Fremdes durchscheint.
    docs: docs.map(d => ({
      id: d.id, title: d.title, folder: d.folder_id, parent: d.parent_id && ids.has(d.parent_id) && d.id !== target.id ? d.parent_id : null,
      content: d.content, tags: JSON.parse(d.tags || '[]'), updated: d.updated_at,
    })),
  };
}

// Für die Dokumentansicht: Ist das Element (über eine Elternfreigabe) öffentlich?
export function shareStatus(kind, id) {
  const now = Date.now();
  const active = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)';
  const direct = db.prepare(`SELECT COUNT(*) AS n FROM shares WHERE kind = ? AND target_id = ? AND ${active}`).get(kind, id, now).n;
  let inherited = 0;
  if (kind === 'doc') {
    const d = db.prepare('SELECT folder_id FROM documents WHERE id = ?').get(id);
    for (const a of docAncestors(id)) inherited += db.prepare(`SELECT COUNT(*) AS n FROM shares WHERE kind = 'doc' AND target_id = ? AND include_children = 1 AND ${active}`).get(a, now).n;
    if (d) {
      inherited += db.prepare(`SELECT COUNT(*) AS n FROM shares WHERE kind = 'folder' AND target_id = ? AND ${active}`).get(d.folder_id, now).n;
      for (const f of folderAncestors(d.folder_id)) inherited += db.prepare(`SELECT COUNT(*) AS n FROM shares WHERE kind = 'folder' AND target_id = ? AND include_children = 1 AND ${active}`).get(f, now).n;
    }
  }
  return { direct, inherited };
}
