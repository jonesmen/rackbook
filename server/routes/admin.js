import { Router } from 'express';
import { db, tx, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { HttpError, hashPassword, validatePassword } from '../security.js';
import { audit, publicUser, requireRole, revokeUserSessions } from '../auth.js';
import { USERNAME_RE, cleanName } from './auth.js';
import { folderExists, insertDoc, normContent, normTags, normTitle } from './docs.js';
import { DEFAULT_FOLDERS, sampleDocs } from '../seed.js';
import { checkFolderParent, checkDocParent } from '../tree.js';
import { adminView as oidcAdminView, saveOidcSettings, testConnection } from '../oidc.js';
import { getMcpSettings, saveMcpSettings, listTokens, revokeToken, mcpEndpoint } from '../mcp.js';
import { getShareSettings, saveShareSettings, listShares, revokeShare, revokeAllOfUser, activeShareCounts } from '../shares.js';

const r = Router();
r.use(requireRole('admin'));

const ROLES = ['admin', 'editor', 'viewer'];
const STATUSES = ['active', 'pending', 'disabled'];
const load = id => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;

function adminView(u) {
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(u.id, Date.now()).n;
  const shares = db.prepare('SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(u.id, Date.now()).n;
  return { ...publicUser(u), settings: undefined, locked: u.locked_until > Date.now(), sessions, shares };
}

// ---------- Benutzerverwaltung ----------
r.get('/users', (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(adminView) });
});

r.post('/users', async (req, res) => {
  const { username, password, role = 'viewer' } = req.body || {};
  if (!USERNAME_RE.test(String(username || ''))) throw new HttpError(400, 'Benutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Ungültige Rolle.');
  const err = validatePassword(password, username);
  if (err) throw new HttpError(400, err);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Dieser Benutzername ist bereits vergeben.');
  const now = Date.now();
  const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, status, must_change_password, created_at, updated_at, password_changed_at)
                           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(username, cleanName(req.body.displayName) || username, await hashPassword(password), role, req.body.mustChangePassword === false ? 0 : 1, now, now, now);
  audit(req, 'admin.user_created', username, { role });
  res.status(201).json({ user: adminView(load(info.lastInsertRowid)) });
});

r.patch('/users/:id', (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  const b = req.body || {};
  const role = b.role ?? u.role, status = b.status ?? u.status;
  if (!ROLES.includes(role) || !STATUSES.includes(status)) throw new HttpError(400, 'Ungültige Rolle oder Status.');
  const displayName = b.displayName !== undefined ? cleanName(b.displayName) : u.display_name;
  if (!displayName) throw new HttpError(400, 'Der Anzeigename darf nicht leer sein.');
  const losesAdmin = u.role === 'admin' && u.status === 'active' && (role !== 'admin' || status !== 'active');
  if (losesAdmin && activeAdmins() <= 1) throw new HttpError(409, 'Es muss mindestens ein aktiver Administrator bestehen bleiben.');
  if (u.id === req.user.id && status !== 'active') throw new HttpError(409, 'Du kannst dein eigenes Konto nicht deaktivieren.');
  db.prepare('UPDATE users SET role = ?, status = ?, display_name = ?, locked_until = ?, failed_logins = ?, updated_at = ? WHERE id = ?')
    .run(role, status, displayName, b.unlock ? 0 : u.locked_until, b.unlock ? 0 : u.failed_logins, Date.now(), u.id);
  if (status !== 'active' || role !== u.role) revokeUserSessions(u.id, u.id === req.user.id ? req.sessionId : null);
  audit(req, 'admin.user_updated', u.username, { role, status, unlock: !!b.unlock });
  res.json({ user: adminView(load(u.id)) });
});

r.post('/users/:id/password', async (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  const err = validatePassword(req.body?.password, u.username);
  if (err) throw new HttpError(400, err);
  db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = ?, failed_logins = 0, locked_until = 0, updated_at = ? WHERE id = ?')
    .run(await hashPassword(req.body.password), Date.now(), u.id === req.user.id ? 0 : 1, Date.now(), u.id);
  revokeUserSessions(u.id, u.id === req.user.id ? req.sessionId : null);
  audit(req, 'admin.password_reset', u.username);
  res.json({ user: adminView(load(u.id)) });
});

r.post('/users/:id/reset-2fa', (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?').run(Date.now(), u.id);
  revokeUserSessions(u.id, u.id === req.user.id ? req.sessionId : null);
  audit(req, 'admin.2fa_reset', u.username);
  res.json({ user: adminView(load(u.id)) });
});

r.delete('/users/:id/sessions', (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  revokeUserSessions(u.id, u.id === req.user.id ? req.sessionId : null);
  audit(req, 'admin.sessions_revoked', u.username);
  res.json({ user: adminView(load(u.id)) });
});

r.delete('/users/:id', (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  if (u.id === req.user.id) throw new HttpError(409, 'Du kannst dein eigenes Konto nicht löschen.');
  if (u.role === 'admin' && u.status === 'active' && activeAdmins() <= 1) throw new HttpError(409, 'Der letzte Administrator kann nicht gelöscht werden.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req, 'admin.user_deleted', u.username);
  res.json({ ok: true });
});

// ---------- Systemeinstellungen ----------
const appSettings = () => ({
  registrationEnabled: !!getSetting('registration_enabled', config.allowRegistrationDefault),
  registrationRequiresApproval: !!getSetting('registration_requires_approval', config.requireApprovalDefault),
  defaultRole: getSetting('default_role', config.defaultRole),
  staleDays: getSetting('stale_days', config.staleDaysDefault),
});
r.get('/settings', (req, res) => res.json({ settings: appSettings() }));
r.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.registrationEnabled !== undefined) setSetting('registration_enabled', !!b.registrationEnabled);
  if (b.registrationRequiresApproval !== undefined) setSetting('registration_requires_approval', !!b.registrationRequiresApproval);
  if (b.defaultRole !== undefined) {
    if (!['viewer', 'editor'].includes(b.defaultRole)) throw new HttpError(400, 'Standardrolle muss viewer oder editor sein.');
    setSetting('default_role', b.defaultRole);
  }
  if (b.staleDays !== undefined) {
    const n = Math.round(Number(b.staleDays));
    if (!(n >= 1 && n <= 3650)) throw new HttpError(400, 'Zeitraum muss zwischen 1 und 3650 Tagen liegen.');
    setSetting('stale_days', n);
  }
  audit(req, 'admin.settings_updated', null, appSettings());
  res.json({ settings: appSettings() });
});

// ---------- Single Sign-On (OIDC) ----------
r.get('/oidc', (req, res) => res.json({ oidc: oidcAdminView(req) }));
r.put('/oidc', (req, res) => {
  saveOidcSettings(req.body);
  const v = oidcAdminView(req);
  audit(req, 'admin.sso_updated', null, { enabled: v.enabled, issuer: v.issuer, clientId: v.clientId });
  res.json({ oidc: v });
});
r.post('/oidc/test', async (req, res) => res.json({ result: await testConnection() }));

// ---------- KI-Zugriff (MCP) ----------
r.get('/mcp', (req, res) => res.json({ settings: getMcpSettings(), endpoint: mcpEndpoint(req), tokens: listTokens() }));
r.put('/mcp', (req, res) => {
  const settings = saveMcpSettings(req.body);
  audit(req, 'admin.mcp_updated', null, { ...settings, guidelines: undefined });
  res.json({ settings, endpoint: mcpEndpoint(req), tokens: listTokens() });
});
r.delete('/mcp-tokens/:id', (req, res) => {
  revokeToken(Number(req.params.id));
  audit(req, 'admin.mcp_token_revoked', String(req.params.id));
  res.json({ tokens: listTokens() });
});

// ---------- Freigaben ----------
r.get('/shares', (req, res) => res.json({ settings: getShareSettings(), shares: listShares({}), counts: activeShareCounts() }));
r.put('/shares/settings', (req, res) => {
  const settings = saveShareSettings(req.body);
  audit(req, 'admin.sharing_updated', null, settings);
  res.json({ settings });
});
r.delete('/shares/:id', (req, res) => {
  const sh = revokeShare(req.params.id, req.user, { onlyOwn: false });
  audit(req, 'share.revoked', `${sh.kind}:${sh.target_id}`, { id: sh.id, byAdmin: true });
  res.json({ shares: listShares({}) });
});
// Alle öffentlichen Freigaben eines Benutzers wieder privat machen
r.delete('/users/:id/shares', (req, res) => {
  const u = load(req.params.id);
  if (!u) throw new HttpError(404, 'Benutzer nicht gefunden.');
  const n = revokeAllOfUser(u.id, req.user);
  audit(req, 'admin.shares_revoked', u.username, { count: n });
  res.json({ revoked: n, user: adminView(load(u.id)) });
});

// ---------- Audit-Log ----------
r.get('/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);
  res.json({ entries: rows.map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null })) });
});

// ---------- Backup / Wiederherstellung ----------
r.get('/backup', (req, res) => {
  const folders = db.prepare('SELECT id, name, icon, hue, sort, parent_id AS parent FROM folders ORDER BY sort').all();
  const documents = db.prepare('SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC').all().map(d => ({
    id: d.id, title: d.title, folder: d.folder_id, parent: d.parent_id ?? null, tags: JSON.parse(d.tags), content: d.content, pinned: !!d.pinned,
    created: d.created_at, updated: d.updated_at, reviewed: d.reviewed_at,
  }));
  audit(req, 'admin.backup_exported', null, { documents: documents.length });
  res.setHeader('Content-Disposition', `attachment; filename="rackbook-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: 'rackbook', format: 2, exportedAt: Date.now(), folders, documents });
});

r.post('/restore', (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.documents)) throw new HttpError(400, 'Ungültige Backup-Datei.');
  const result = tx(() => {
    let folders = 0, created = 0, updated = 0;
    const fid = v => String(v || '').toLowerCase().replace(/[^a-z0-9äöüß-]/g, '-').slice(0, 40);
    const inFolders = Array.isArray(b.folders) ? b.folders : [];
    for (const f of inFolders) {
      const id = fid(f.id);
      if (!id) continue;
      const name = cleanName(f.name) || id, icon = /^[a-z0-9_]{1,40}$/.test(f.icon) ? f.icon : 'folder';
      const hue = Math.min(360, Math.max(0, Math.round(Number(f.hue) || 250)));
      db.prepare(`INSERT INTO folders (id, name, icon, hue, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, hue = excluded.hue`)
        .run(id, name, icon, hue, Number(f.sort) || 0, Date.now());
      folders++;
    }
    // Hierarchie erst nach dem Anlegen aller Ordner setzen (ungültige Verweise werden ignoriert).
    for (const f of inFolders) {
      if (!f.parent) continue;
      try { db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(checkFolderParent(fid(f.id), fid(f.parent)), fid(f.id)); } catch { /* ignorieren */ }
    }
    const fallback = db.prepare('SELECT id FROM folders ORDER BY sort LIMIT 1').get()?.id;
    for (const d of b.documents) {
      const folder = folderExists(d.folder) ? d.folder : fallback;
      const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(d.id || '')) ? String(d.id) : undefined;
      const exists = id && db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id);
      const ts = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : Date.now());
      if (exists) {
        db.prepare(`UPDATE documents SET title = ?, folder_id = ?, tags = ?, content = ?, pinned = ?, version = version + 1,
                    updated_at = ?, updated_by = ?, updated_via = 'web', deleted_at = NULL WHERE id = ?`)
          .run(normTitle(d.title), folder, JSON.stringify(normTags(d.tags)), normContent(d.content), d.pinned ? 1 : 0, ts(d.updated), req.user.id, id);
        updated++;
      } else {
        insertDoc({ id, title: d.title, folder, tags: d.tags, content: d.content, pinned: d.pinned, created: ts(d.created), updated: ts(d.updated) }, req.user.id);
        created++;
      }
    }
    for (let pass = 0; pass < 2; pass++) for (const d of b.documents) { // 2 Durchläufe: Ordner von Unterseiten folgen der Elternseite
      const id = String(d.id || '');
      if (!d.parent || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
      try {
        const p = checkDocParent(id, String(d.parent));
        db.prepare('UPDATE documents SET parent_id = ?, folder_id = ? WHERE id = ?').run(p.parent, p.folder, id);
      } catch { /* ignorieren */ }
    }
    return { folders, created, updated };
  });
  audit(req, 'admin.backup_restored', null, result);
  res.json(result);
});

r.post('/sample-data', (req, res) => {
  const n = tx(() => {
    for (const [i, f] of DEFAULT_FOLDERS.entries()) {
      db.prepare('INSERT OR IGNORE INTO folders (id, name, icon, hue, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, f.name, f.icon, f.hue, i, Date.now());
    }
    let count = 0;
    for (const d of sampleDocs()) {
      const id = 'sample-' + d.id;
      db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      insertDoc({ ...d, id, folder: d.folder, created: d.updated }, req.user.id);
      if (d.bookmarked) db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, doc_id, created_at) VALUES (?, ?, ?)').run(req.user.id, id, Date.now());
      count++;
    }
    return count;
  });
  audit(req, 'admin.sample_data', null, { count: n });
  res.json({ count: n });
});

export default r;
