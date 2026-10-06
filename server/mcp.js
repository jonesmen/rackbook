// Leichtgewichtiger MCP-Server (Model Context Protocol, Streamable HTTP, zustandslos).
// KI-Assistenten (Claude, ChatGPT, Cursor …) können darüber Dokumentation lesen und pflegen.
import { db, tx, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { HttpError, randomToken, sha256, RateLimiter } from './security.js';
import { audit, clientIp, publicUser } from './auth.js';
import {
  normTitle, normTags, normContent, folderExists, insertDoc, saveRevision, ctrlStrip,
} from './routes/docs.js';
import { excerpt } from '../public/js/md.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SCOPES = ['read', 'write', 'delete', 'folders'];
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

// ---------- Globale Einstellungen (Verwaltung → KI / MCP) ----------
export const MCP_DEFAULTS = {
  enabled: false,
  allowViewerTokens: true,
  allowWrite: true,
  allowDelete: false,
  allowFolders: false,
  maxTokenDays: 365,
  aiTag: 'ki',
  guidelines: '',
  rateLimitPerMinute: 120,
};
export const getMcpSettings = () => ({ ...MCP_DEFAULTS, ...getSetting('mcp', {}) });

export function saveMcpSettings(b = {}) {
  const s = getMcpSettings();
  for (const k of ['enabled', 'allowViewerTokens', 'allowWrite', 'allowDelete', 'allowFolders']) if (b[k] !== undefined) s[k] = !!b[k];
  if (b.maxTokenDays !== undefined) {
    const n = Math.round(Number(b.maxTokenDays));
    if (!(n >= 0 && n <= 3650)) throw new HttpError(400, 'Maximale Laufzeit: 0 (unbegrenzt) bis 3650 Tage.');
    s.maxTokenDays = n;
  }
  if (b.aiTag !== undefined) s.aiTag = normTags([b.aiTag])[0] || '';
  if (b.guidelines !== undefined) s.guidelines = ctrlStrip(b.guidelines).slice(0, 8000);
  if (b.rateLimitPerMinute !== undefined) {
    const n = Math.round(Number(b.rateLimitPerMinute));
    if (!(n >= 10 && n <= 2000)) throw new HttpError(400, 'Rate-Limit: 10 bis 2000 Aufrufe pro Minute.');
    s.rateLimitPerMinute = n;
  }
  setSetting('mcp', s);
  return s;
}

export function mcpEndpoint(req) {
  return (config.publicUrl || `${req.protocol}://${req.get('host')}`) + '/mcp';
}

// Welche Rechte darf ein Benutzer mit seiner Rolle überhaupt vergeben?
export function grantableScopes(role, s = getMcpSettings()) {
  const out = [];
  const editor = (ROLE_RANK[role] || 0) >= 2;
  if (editor || s.allowViewerTokens) out.push('read');
  if (editor && s.allowWrite) out.push('write');
  if (editor && s.allowDelete) out.push('delete');
  if (editor && s.allowFolders) out.push('folders');
  return out;
}

// ---------- Tokens ----------
const tokenDto = t => ({
  id: t.id, name: t.name, prefix: t.prefix, scopes: JSON.parse(t.scopes), folders: JSON.parse(t.folders),
  createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, lastUsedIp: t.last_used_ip,
  revoked: !!t.revoked_at, expired: !!(t.expires_at && t.expires_at < Date.now()),
  ...(t.username ? { username: t.username, displayName: t.display_name } : {}),
});

export function listTokens(userId) {
  const rows = userId
    ? db.prepare('SELECT * FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(userId)
    : db.prepare(`SELECT t.*, u.username, u.display_name FROM mcp_tokens t JOIN users u ON u.id = t.user_id
                  WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`).all();
  return rows.map(tokenDto);
}

export function createToken(user, { name, scopes, folders, expiresDays }) {
  const s = getMcpSettings();
  if (!s.enabled) throw new HttpError(403, 'Der MCP-Zugriff ist deaktiviert.');
  const allowed = grantableScopes(user.role, s);
  const wanted = Array.isArray(scopes) ? [...new Set(scopes.map(String))] : ['read'];
  if (!wanted.length) throw new HttpError(400, 'Mindestens ein Recht auswählen.');
  const bad = wanted.find(x => !allowed.includes(x));
  if (bad) throw new HttpError(403, `Das Recht „${bad}“ darfst du nicht vergeben.`);
  if (!wanted.includes('read')) wanted.unshift('read');
  const fl = Array.isArray(folders) ? [...new Set(folders.map(String))] : [];
  for (const f of fl) if (!folderExists(f)) throw new HttpError(400, `Ordner „${f}“ existiert nicht.`);
  let days = expiresDays === undefined || expiresDays === null || expiresDays === '' ? s.maxTokenDays : Math.round(Number(expiresDays));
  if (!(days >= 0)) throw new HttpError(400, 'Ungültige Laufzeit.');
  if (s.maxTokenDays > 0 && (days === 0 || days > s.maxTokenDays)) days = s.maxTokenDays;
  const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  if (!clean) throw new HttpError(400, 'Bitte einen Namen angeben, z. B. „Claude Desktop“.');
  if (db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL').get(user.id).n >= 20) {
    throw new HttpError(409, 'Maximal 20 aktive Tokens pro Benutzer.');
  }
  const token = 'rbm_' + randomToken(32);
  const now = Date.now();
  const info = db.prepare(`INSERT INTO mcp_tokens (user_id, name, token_hash, prefix, scopes, folders, created_at, expires_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, clean, sha256(token), token.slice(0, 12), JSON.stringify(wanted), JSON.stringify(fl), now, days > 0 ? now + days * 86400000 : null);
  return { token, info: tokenDto(db.prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(info.lastInsertRowid)) };
}

export function revokeToken(id, userId) {
  const n = userId
    ? db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, userId).changes
    : db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes;
  if (!n) throw new HttpError(404, 'Token nicht gefunden.');
}

// ---------- Authentifizierung einer MCP-Anfrage ----------
function authenticate(req) {
  const h = String(req.get('authorization') || '');
  const m = h.match(/^Bearer\s+(rbm_[A-Za-z0-9_-]{20,80})$/);
  if (!m) return null;
  const row = db.prepare(`SELECT t.*, u.id AS uid FROM mcp_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`).get(sha256(m[1]));
  if (!row || row.revoked_at || (row.expires_at && row.expires_at < Date.now())) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.uid);
  if (!user || user.status !== 'active') return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60000) {
    db.prepare('UPDATE mcp_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(now, clientIp(req), row.id);
  }
  const s = getMcpSettings();
  const granted = JSON.parse(row.scopes);
  const allowed = grantableScopes(user.role, s);
  return {
    user: publicUser(user),
    token: { id: row.id, name: row.name },
    // Effektive Rechte: Token ∩ aktuelle Rolle ∩ aktuelle Systemeinstellungen
    scopes: new Set(granted.filter(x => allowed.includes(x))),
    folders: JSON.parse(row.folders),
    settings: s,
  };
}

// ---------- Hilfen ----------
class ToolError extends Error {}
const need = (ctx, scope) => {
  if (!ctx.scopes.has(scope)) throw new ToolError(`Keine Berechtigung: Dieses Token hat das Recht „${scope}“ nicht.`);
};
const folderOk = (ctx, f) => !ctx.folders.length || ctx.folders.includes(f);
const folderList = ctx => db.prepare('SELECT id, name, icon FROM folders ORDER BY sort, name').all().filter(f => folderOk(ctx, f.id));
const folderName = id => db.prepare('SELECT name FROM folders WHERE id = ?').get(id)?.name || id;
const iso = ts => (ts ? new Date(ts).toISOString() : null);

function loadDoc(ctx, id) {
  const d = db.prepare(`SELECT d.*, u.display_name AS updated_by_name FROM documents d LEFT JOIN users u ON u.id = d.updated_by
                        WHERE d.id = ? AND d.deleted_at IS NULL`).get(String(id || ''));
  if (!d || !folderOk(ctx, d.folder_id)) throw new ToolError(`Dokument „${id}“ nicht gefunden (oder nicht freigegeben).`);
  return d;
}
const meta = d => ({
  id: d.id, title: d.title, folder: d.folder_id, folderName: folderName(d.folder_id), tags: JSON.parse(d.tags),
  version: d.version, updatedAt: iso(d.updated_at), updatedBy: d.updated_by_name ?? null, pinned: !!d.pinned,
});
const withAiTag = (ctx, tags) => {
  const t = normTags(tags);
  if (ctx.settings.aiTag && !t.includes(ctx.settings.aiTag)) t.push(ctx.settings.aiTag);
  return t;
};
function checkFolder(ctx, folder) {
  if (!folderExists(folder)) throw new ToolError(`Ordner „${folder}“ existiert nicht. Verfügbare Ordner: ${folderList(ctx).map(f => f.id).join(', ')}`);
  if (!folderOk(ctx, folder)) throw new ToolError(`Ordner „${folder}“ ist für dieses Token nicht freigegeben.`);
}
function updateDoc(ctx, d, next) {
  saveRevision(d, ctx.user.id);
  db.prepare(`UPDATE documents SET title = ?, folder_id = ?, tags = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = 'mcp'
              WHERE id = ?`).run(next.title ?? d.title, next.folder ?? d.folder_id, next.tags ?? d.tags, next.content ?? d.content, Date.now(), ctx.user.id, d.id);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(d.id);
}
const logWrite = (ctx, req, action, target, details) => {
  req.user = ctx.user;
  audit(req, action, target, { ...details, via: 'mcp', token: ctx.token.name });
};

// ---------- Anleitung für die KI ----------
export function guide(ctx) {
  const s = ctx.settings;
  const folders = folderList(ctx).map(f => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE folder_id = ? AND deleted_at IS NULL').get(f.id).n;
    return `- \`${f.id}\` – ${f.name} (${n} Dokumente)`;
  }).join('\n');
  const perms = [...ctx.scopes].map(x => ({ read: 'lesen & suchen', write: 'Dokumente anlegen & bearbeiten', delete: 'Dokumente in den Papierkorb verschieben', folders: 'Ordner anlegen' }[x])).join(', ');
  return `# Rackbook – Anleitung für KI-Assistenten

Rackbook ist die Markdown-Dokumentation einer IT-/Homelab-Umgebung (Server, Netzwerk, Dienste, Backups, Runbooks).
Du arbeitest im Namen von **${ctx.user.displayName}** (Rolle: ${ctx.user.role}). Deine Rechte: ${perms}.
${ctx.folders.length ? `Du hast nur Zugriff auf diese Ordner: ${ctx.folders.join(', ')}.\n` : ''}
## Ordner (\`folder\`-ID verwenden)
${folders || '- (keine Ordner freigegeben)'}

## Arbeitsweise
1. **Erst suchen, dann schreiben.** Prüfe mit \`search_documents\`, ob es schon ein Dokument zum Thema gibt. Bestehende Dokumente ergänzen statt Duplikate anlegen.
2. **Vor dem Ändern lesen.** \`get_document\` liefert Inhalt und \`version\`. Für kleine Änderungen \`replace_in_document\` oder \`append_to_document\` nutzen, für Umbauten \`update_document\` mit der gelesenen \`version\`.
3. **Ein Dokument pro Thema** (ein Host, ein Dienst, ein Ablauf). Titel kurz und eindeutig, z. B. „Traefik Reverse Proxy“, „pve-01“, „Wiederherstellung nach Stromausfall“.
4. **Passenden Ordner wählen** (siehe Liste). Gibt es keinen passenden, frage den Benutzer${ctx.scopes.has('folders') ? ' oder lege mit `create_folder` einen an' : ''}.
5. **Tags**: 2–5 kurze, kleingeschriebene Schlagwörter (z. B. \`docker\`, \`proxmox\`, \`dns\`) – vorhandene Tags wiederverwenden (\`rackbook_overview\`).${s.aiTag ? ` Das Tag \`${s.aiTag}\` wird bei deinen Änderungen automatisch ergänzt.` : ''}
6. **Keine Geheimnisse speichern**: keine Passwörter, API-Keys, Tokens oder privaten Schlüssel. Stattdessen auf den Ablageort verweisen (z. B. „Passwort in Vaultwarden unter *Dienst / Admin*“).
7. Jede Änderung wird versioniert und ist für Menschen nachvollziehbar. Erfinde keine Fakten – nur dokumentieren, was der Benutzer gesagt hat oder was du verifiziert hast. Unklares als offene Aufgabe (\`- [ ]\`) festhalten.

## Unterstütztes Markdown
- Überschriften \`##\` bis \`####\` (kein \`#\` im Inhalt – der Titel ist separat). \`##\`/\`###\` bilden das Inhaltsverzeichnis.
- **fett**, *kursiv*, ~~durchgestrichen~~, \`Inline-Code\` für IPs, Hostnamen, Pfade, Ports
- Code-Blöcke mit Sprache: \`\`\`bash, \`\`\`yaml, \`\`\`ini …
- Listen (\`-\`, \`1.\`), Tabellen (\`| a | b |\` mit Trennzeile \`|---|---|\`)
- Hinweis-Box: Zeile mit \`>\` beginnen
- Aufgaben: \`- [ ] offen\` / \`- [x] erledigt\` – offene Aufgaben erscheinen auf dem Dashboard
- Links: \`[Text](https://…)\`, Verweis auf andere Dokumente: \`[Titel](/doc/<id>)\`
- Keine Bilder, kein HTML.

## Empfohlene Struktur
**Dienst/Anwendung:** Kurzbeschreibung (1–2 Sätze) → \`## Zugriff\` (URL, Host, Port) → \`## Installation\` / \`## Konfiguration\` (Code-Blöcke) → \`## Abhängigkeiten\` → \`## Wartung & Updates\` → \`## Offene Punkte\` (Aufgaben).
**Host/Hardware:** Kurzbeschreibung → Tabelle mit Hardware, OS, IP, Standort → \`## Dienste\` → \`## Netzwerk\` → \`## Wartung\`.
**Runbook:** Anlass/Ziel → nummerierte Schritte mit Befehlen → \`## Prüfung\` → \`## Rückfallebene\`.
${s.guidelines ? `\n## Hausregeln dieser Installation\n${s.guidelines}\n` : ''}`;
}

// ---------- Werkzeuge ----------
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  {
    name: 'rackbook_overview', scope: 'read', title: 'Überblick & Anleitung',
    description: 'Liefert die Anleitung, wie und wo in Rackbook dokumentiert wird, sowie Ordner, vorhandene Tags und zuletzt geänderte Dokumente. Zu Beginn jeder Dokumentationsaufgabe aufrufen.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run(ctx) {
      const docs = accessibleDocs(ctx);
      const tags = {};
      docs.forEach(d => JSON.parse(d.tags).forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
      const recent = docs.slice(0, 10).map(d => `- ${d.title} (\`${d.id}\`, ${folderName(d.folder_id)}, ${iso(d.updated_at).slice(0, 10)})`).join('\n');
      const tagList = Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join(', ');
      return { text: `${guide(ctx)}\n## Vorhandene Tags\n${tagList || '(noch keine)'}\n\n## Zuletzt geändert\n${recent || '(noch keine Dokumente)'}` };
    },
  },
  {
    name: 'search_documents', scope: 'read', title: 'Dokumente durchsuchen',
    description: 'Volltextsuche über Titel, Inhalt und Tags (z. B. Hostname, IP-Adresse, Dienstname, Befehl). Liefert IDs, Ordner und Textausschnitte. Vor dem Anlegen neuer Dokumente verwenden, um Duplikate zu vermeiden.',
    inputSchema: { type: 'object', properties: { query: str('Suchbegriff'), folder: str('Optional: Ordner-ID'), tag: str('Optional: Tag'), limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }, required: ['query'] },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const q = String(a.query || '').trim().toLowerCase();
      if (!q) throw new ToolError('Bitte einen Suchbegriff angeben.');
      const hits = [];
      for (const d of accessibleDocs(ctx)) {
        if (a.folder && d.folder_id !== a.folder) continue;
        const tags = JSON.parse(d.tags);
        if (a.tag && !tags.includes(String(a.tag).toLowerCase())) continue;
        const inTitle = d.title.toLowerCase().includes(q), inTag = tags.some(t => t.includes(q));
        const idx = d.content.toLowerCase().indexOf(q);
        if (!inTitle && !inTag && idx < 0) continue;
        const snippet = idx >= 0 ? d.content.slice(Math.max(0, idx - 80), idx + q.length + 120).replace(/\s+/g, ' ') : excerpt(d.content);
        hits.push({ score: (inTitle ? 3 : 0) + (inTag ? 2 : 0) + (idx >= 0 ? 1 : 0), d, snippet });
      }
      hits.sort((x, y) => y.score - x.score || y.d.updated_at - x.d.updated_at);
      const top = hits.slice(0, Math.min(50, Number(a.limit) || 10));
      return {
        text: top.length ? top.map(h => `- **${h.d.title}** (\`${h.d.id}\`, ${folderName(h.d.folder_id)}) – …${h.snippet}…`).join('\n') : `Keine Treffer für „${a.query}“.`,
        structured: { results: top.map(h => ({ ...meta(h.d), snippet: h.snippet })) },
      };
    },
  },
  {
    name: 'list_documents', scope: 'read', title: 'Dokumente auflisten',
    description: 'Listet Dokumente (neueste zuerst), optional gefiltert nach Ordner oder Tag.',
    inputSchema: { type: 'object', properties: { folder: str('Optional: Ordner-ID'), tag: str('Optional: Tag'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const all = accessibleDocs(ctx).filter(d => (!a.folder || d.folder_id === a.folder) && (!a.tag || JSON.parse(d.tags).includes(String(a.tag).toLowerCase())));
      const off = Math.max(0, Number(a.offset) || 0), lim = Math.min(200, Number(a.limit) || 50);
      const page = all.slice(off, off + lim);
      return {
        text: `${all.length} Dokumente${all.length > page.length ? ` (zeige ${off + 1}–${off + page.length})` : ''}:\n` + page.map(d => `- ${d.title} (\`${d.id}\`, ${folderName(d.folder_id)}, Tags: ${JSON.parse(d.tags).join(', ') || '–'})`).join('\n'),
        structured: { total: all.length, documents: page.map(meta) },
      };
    },
  },
  {
    name: 'get_document', scope: 'read', title: 'Dokument lesen',
    description: 'Liefert den vollständigen Markdown-Inhalt eines Dokuments samt Metadaten und aktueller `version` (für update_document benötigt).',
    inputSchema: { type: 'object', properties: { id: str('Dokument-ID') }, required: ['id'] },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const d = loadDoc(ctx, a.id);
      const m = meta(d);
      return { text: `# ${d.title}\nID: ${d.id} · Ordner: ${m.folderName} (\`${d.folder_id}\`) · Tags: ${m.tags.join(', ') || '–'} · Version: ${d.version} · Geändert: ${m.updatedAt}${m.updatedBy ? ' von ' + m.updatedBy : ''}\n\n${d.content}`, structured: { ...m, content: d.content } };
    },
  },
  {
    name: 'list_open_todos', scope: 'read', title: 'Offene Aufgaben',
    description: 'Listet alle offenen Aufgaben (`- [ ]`) aus allen Dokumenten.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run(ctx) {
      const out = [];
      for (const d of accessibleDocs(ctx)) d.content.split('\n').forEach(l => { const m = l.match(/^\s*[-*+]\s+\[ \]\s+(.*)$/); if (m) out.push({ doc: d, text: m[1] }); });
      return { text: out.length ? out.map(t => `- ${t.text} — ${t.doc.title} (\`${t.doc.id}\`)`).join('\n') : 'Keine offenen Aufgaben.' };
    },
  },
  {
    name: 'create_document', scope: 'write', title: 'Dokument anlegen',
    description: 'Legt ein neues Dokument an. Vorher mit search_documents prüfen, ob es das Thema schon gibt. Der Titel wird separat übergeben – den Inhalt nicht mit einer #-Überschrift beginnen.',
    inputSchema: { type: 'object', properties: {
      title: str('Kurzer, eindeutiger Titel'), folder: str('Ordner-ID (siehe rackbook_overview)'),
      tags: { type: 'array', items: { type: 'string' }, description: '2–5 kleingeschriebene Tags' }, content: str('Inhalt in Markdown'),
    }, required: ['title', 'folder', 'content'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run(ctx, a, req) {
      checkFolder(ctx, a.folder);
      const dup = db.prepare('SELECT id, folder_id FROM documents WHERE lower(title) = lower(?) AND deleted_at IS NULL').all(normTitle(a.title)).find(x => folderOk(ctx, x.folder_id));
      if (dup) throw new ToolError(`Es gibt bereits ein Dokument mit diesem Titel (\`${dup.id}\`). Bitte dieses ergänzen (get_document / append_to_document) oder einen anderen Titel wählen.`);
      const id = insertDoc({ title: a.title, folder: a.folder, tags: withAiTag(ctx, a.tags || []), content: String(a.content || '').replace(/^#\s+.*\n+/, '') }, ctx.user.id, 'mcp');
      const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      logWrite(ctx, req, 'doc.created', id, { title: d.title });
      return { text: `Dokument „${d.title}“ angelegt (ID \`${id}\`, Version 1). Link: /doc/${id}`, structured: meta(d) };
    },
  },
  {
    name: 'update_document', scope: 'write', title: 'Dokument überarbeiten',
    description: 'Ersetzt Titel, Ordner, Tags und/oder den gesamten Inhalt. `version` aus get_document ist Pflicht – hat ein Mensch das Dokument inzwischen geändert, schlägt die Änderung fehl und du musst neu lesen. Für kleine Änderungen besser replace_in_document oder append_to_document nutzen.',
    inputSchema: { type: 'object', properties: {
      id: str('Dokument-ID'), version: { type: 'integer', description: 'Version aus get_document' }, title: str('Neuer Titel'), folder: str('Neue Ordner-ID'),
      tags: { type: 'array', items: { type: 'string' } }, content: str('Neuer vollständiger Markdown-Inhalt'),
    }, required: ['id', 'version'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run(ctx, a, req) {
      return tx(() => {
        const d = loadDoc(ctx, a.id);
        if (Number(a.version) !== d.version) throw new ToolError(`Versionskonflikt: aktuell ist Version ${d.version}, übergeben wurde ${a.version}. Bitte get_document erneut aufrufen und die Änderung auf den aktuellen Stand anwenden.`);
        if (a.folder !== undefined) checkFolder(ctx, a.folder);
        const next = {
          title: a.title !== undefined ? normTitle(a.title) : undefined,
          folder: a.folder,
          tags: JSON.stringify(withAiTag(ctx, a.tags !== undefined ? a.tags : JSON.parse(d.tags))),
          content: a.content !== undefined ? normContent(String(a.content).replace(/^#\s+.*\n+/, '')) : undefined,
        };
        const u = updateDoc(ctx, d, next);
        logWrite(ctx, req, 'doc.updated', d.id, { title: u.title, version: u.version });
        return { text: `„${u.title}“ aktualisiert (jetzt Version ${u.version}).`, structured: meta(u) };
      });
    },
  },
  {
    name: 'append_to_document', scope: 'write', title: 'Abschnitt ergänzen',
    description: 'Hängt Markdown an ein Dokument an – optional am Ende eines bestimmten Abschnitts (Überschrift ohne #). Existiert der Abschnitt nicht, wird er am Ende als ## Überschrift angelegt. Keine Version nötig.',
    inputSchema: { type: 'object', properties: { id: str('Dokument-ID'), content: str('Anzuhängender Markdown-Text'), section: str('Optional: Abschnittsüberschrift, z. B. „Offene Punkte“') }, required: ['id', 'content'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run(ctx, a, req) {
      return tx(() => {
        const d = loadDoc(ctx, a.id);
        const add = String(a.content || '').trim();
        if (!add) throw new ToolError('Kein Inhalt übergeben.');
        const lines = d.content.replace(/\s+$/, '').split('\n');
        let content;
        if (a.section) {
          const name = String(a.section).replace(/^#+\s*/, '').trim().toLowerCase();
          const start = lines.findIndex(l => { const m = l.match(/^(#{2,4})\s+(.*)$/); return m && m[2].trim().toLowerCase() === name; });
          if (start >= 0) {
            const level = lines[start].match(/^#+/)[0].length;
            let end = lines.length;
            for (let i = start + 1; i < lines.length; i++) { const m = lines[i].match(/^(#{1,4})\s/); if (m && m[1].length <= level) { end = i; break; } }
            while (end > start + 1 && !lines[end - 1].trim()) end--;
            lines.splice(end, 0, ...(end === start + 1 ? ['', add] : [add]));
            content = lines.join('\n');
          } else {
            content = `${lines.join('\n')}\n\n## ${String(a.section).replace(/^#+\s*/, '').trim()}\n\n${add}`;
          }
        } else content = `${lines.join('\n')}\n\n${add}`;
        const u = updateDoc(ctx, d, { content: normContent(content.trim() + '\n'), tags: JSON.stringify(withAiTag(ctx, JSON.parse(d.tags))) });
        logWrite(ctx, req, 'doc.updated', d.id, { title: u.title, version: u.version });
        return { text: `Ergänzt in „${u.title}“${a.section ? ` (Abschnitt „${a.section}“)` : ''} – jetzt Version ${u.version}.`, structured: meta(u) };
      });
    },
  },
  {
    name: 'replace_in_document', scope: 'write', title: 'Textstelle ersetzen',
    description: 'Ersetzt eine eindeutige Textstelle im Inhalt (exakter Vergleich, inkl. Leerzeichen/Zeilenumbrüche). Ideal für gezielte Korrekturen wie geänderte IPs, Versionen oder das Abhaken von Aufgaben (`- [ ]` → `- [x]`).',
    inputSchema: { type: 'object', properties: { id: str('Dokument-ID'), old_text: str('Exakter bisheriger Text (muss genau einmal vorkommen)'), new_text: str('Neuer Text') }, required: ['id', 'old_text', 'new_text'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run(ctx, a, req) {
      return tx(() => {
        const d = loadDoc(ctx, a.id);
        const old = String(a.old_text ?? '');
        if (!old) throw new ToolError('old_text darf nicht leer sein.');
        const n = d.content.split(old).length - 1;
        if (n === 0) throw new ToolError('old_text kommt im Dokument nicht vor. Bitte get_document aufrufen und den exakten Text verwenden.');
        if (n > 1) throw new ToolError(`old_text kommt ${n}-mal vor. Bitte mehr umgebenden Text angeben, damit die Stelle eindeutig ist.`);
        const u = updateDoc(ctx, d, { content: normContent(d.content.replace(old, () => String(a.new_text ?? ''))), tags: JSON.stringify(withAiTag(ctx, JSON.parse(d.tags))) });
        logWrite(ctx, req, 'doc.updated', d.id, { title: u.title, version: u.version });
        return { text: `Textstelle in „${u.title}“ ersetzt – jetzt Version ${u.version}.`, structured: meta(u) };
      });
    },
  },
  {
    name: 'delete_document', scope: 'delete', title: 'Dokument löschen',
    description: 'Verschiebt ein Dokument in den Papierkorb (dort für eine begrenzte Zeit wiederherstellbar). Nur auf ausdrücklichen Wunsch des Benutzers verwenden.',
    inputSchema: { type: 'object', properties: { id: str('Dokument-ID') }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run(ctx, a, req) {
      const d = loadDoc(ctx, a.id);
      db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), ctx.user.id, d.id);
      logWrite(ctx, req, 'doc.deleted', d.id, { title: d.title });
      return { text: `„${d.title}“ wurde in den Papierkorb verschoben.` };
    },
  },
  {
    name: 'create_folder', scope: 'folders', title: 'Ordner anlegen',
    description: 'Legt einen neuen Ordner an. Nur wenn kein vorhandener Ordner passt. icon ist ein Material-Symbols-Name (z. B. dns, lan, router, storage, security, cloud, terminal).',
    inputSchema: { type: 'object', properties: { name: str('Ordnername'), icon: str('Material-Symbols-Name', { default: 'folder' }), hue: { type: 'integer', minimum: 0, maximum: 360, description: 'Farbton 0–360' } }, required: ['name'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(ctx, a, req) {
      if (ctx.folders.length) throw new ToolError('Dieses Token ist auf bestimmte Ordner beschränkt und darf keine neuen Ordner anlegen.');
      const name = ctrlStrip(a.name).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) throw new ToolError('Bitte einen Namen angeben.');
      const exists = db.prepare('SELECT id FROM folders WHERE lower(name) = lower(?)').get(name);
      if (exists) throw new ToolError(`Ordner existiert bereits: \`${exists.id}\`.`);
      const icon = /^[a-z0-9_]{1,40}$/.test(a.icon || '') ? a.icon : 'folder';
      const hue = Math.min(360, Math.max(0, Math.round(Number(a.hue ?? 200)) || 0));
      const base = name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ordner';
      let id = base, i = 2;
      while (folderExists(id)) id = `${base}-${i++}`;
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM folders').get().m ?? 0) + 1;
      db.prepare('INSERT INTO folders (id, name, icon, hue, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, icon, hue, sort, Date.now());
      logWrite(ctx, req, 'folder.created', id, { name });
      return { text: `Ordner „${name}“ angelegt (ID \`${id}\`).` };
    },
  },
];

function accessibleDocs(ctx) {
  return db.prepare('SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC').all().filter(d => folderOk(ctx, d.folder_id));
}

// ---------- Prompts (Vorlagen, die der Benutzer in seinem KI-Client auswählen kann) ----------
const PROMPTS = [
  { name: 'dienst_dokumentieren', title: 'Dienst dokumentieren', description: 'Einen Dienst/eine Anwendung vollständig dokumentieren', arguments: [{ name: 'dienst', description: 'Name des Dienstes, z. B. Nextcloud', required: true }, { name: 'details', description: 'Bekannte Details (Host, Compose-Datei, URL …)' }],
    text: a => `Dokumentiere den Dienst „${a.dienst}“ in Rackbook.\n${a.details ? `Bekannte Details:\n${a.details}\n` : ''}\nVorgehen: 1) rackbook_overview aufrufen. 2) Mit search_documents prüfen, ob es schon ein Dokument gibt – wenn ja, ergänzen statt neu anlegen. 3) Fehlende wichtige Angaben (Host, URL/Port, Installationsart, Datenpfade, Backups, Abhängigkeiten) beim Benutzer erfragen. 4) Nach der empfohlenen Dienst-Struktur schreiben, passenden Ordner und Tags wählen, keine Geheimnisse speichern. 5) Am Ende Link und Zusammenfassung nennen.` },
  { name: 'host_dokumentieren', title: 'Host dokumentieren', description: 'Einen Server, eine VM oder ein Gerät dokumentieren', arguments: [{ name: 'host', description: 'Hostname', required: true }, { name: 'details', description: 'Bekannte Details' }],
    text: a => `Dokumentiere den Host „${a.host}“ in Rackbook.\n${a.details ? `Bekannte Details:\n${a.details}\n` : ''}\nRufe zuerst rackbook_overview auf und suche nach vorhandenen Einträgen (Hostname, IP). Nutze die Host-Struktur: Kurzbeschreibung, Tabelle (Hardware/VM, OS, IP, Standort), Dienste, Netzwerk, Wartung. Verlinke vorhandene Dienst-Dokumente mit [Titel](/doc/<id>).` },
  { name: 'runbook_erstellen', title: 'Runbook erstellen', description: 'Eine Schritt-für-Schritt-Anleitung für einen Ablauf erstellen', arguments: [{ name: 'thema', description: 'z. B. „Proxmox-Node aktualisieren“', required: true }],
    text: a => `Erstelle ein Runbook „${a.thema}“ in Rackbook (Ordner für Runbooks verwenden, falls vorhanden). Struktur: Anlass/Ziel, Voraussetzungen, nummerierte Schritte mit Befehlen in Code-Blöcken, ## Prüfung, ## Rückfallebene. Suche vorher nach verwandten Dokumenten und verlinke sie.` },
  { name: 'dokumentation_pruefen', title: 'Dokumentation prüfen', description: 'Veraltete oder lückenhafte Dokumente finden und Verbesserungen vorschlagen', arguments: [{ name: 'ordner', description: 'Optional: Ordner-ID' }],
    text: a => `Prüfe die Rackbook-Dokumentation${a.ordner ? ` im Ordner ${a.ordner}` : ''}: Liste Dokumente mit list_documents, lies auffällige mit get_document und nenne Lücken (fehlende Zugriffsdaten, Backups, Wartung), Widersprüche und veraltete Angaben. Ändere nichts ohne Rückfrage; schlage konkrete Ergänzungen vor.` },
];

// ---------- JSON-RPC ----------
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function visibleTools(ctx) {
  return TOOLS.filter(t => ctx.scopes.has(t.scope));
}

async function handle(ctx, msg, req) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const v = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'rackbook', title: config.appName, version: '1.0.0' },
        instructions: guide(ctx),
      });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: visibleTools(ctx).map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })),
      });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unbekanntes Werkzeug: ${params.name}`);
      try {
        need(ctx, tool.scope);
        const r = await tool.run(ctx, params.arguments || {}, req);
        return rpcResult(id, { content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: false });
      } catch (e) {
        if (e instanceof ToolError || e instanceof HttpError) return rpcResult(id, { content: [{ type: 'text', text: e.message }], isError: true });
        throw e;
      }
    }
    case 'resources/list': {
      const docs = accessibleDocs(ctx).slice(0, 500);
      return rpcResult(id, {
        resources: [
          { uri: 'rackbook://guide', name: 'Anleitung', title: 'Rackbook – Anleitung für KI-Assistenten', mimeType: 'text/markdown' },
          ...docs.map(d => ({ uri: `rackbook://doc/${d.id}`, name: d.title, title: d.title, description: `${folderName(d.folder_id)} · ${JSON.parse(d.tags).join(', ')}`, mimeType: 'text/markdown' })),
        ],
      });
    }
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [{ uriTemplate: 'rackbook://doc/{id}', name: 'Dokument', mimeType: 'text/markdown' }] });
    case 'resources/read': {
      const uri = String(params.uri || '');
      if (uri === 'rackbook://guide') return rpcResult(id, { contents: [{ uri, mimeType: 'text/markdown', text: guide(ctx) }] });
      const m = uri.match(/^rackbook:\/\/doc\/([A-Za-z0-9_-]+)$/);
      if (!m) return rpcError(id, -32002, 'Ressource nicht gefunden', { uri });
      try {
        const d = loadDoc(ctx, m[1]);
        return rpcResult(id, { contents: [{ uri, mimeType: 'text/markdown', text: `# ${d.title}\n\n${d.content}` }] });
      } catch { return rpcError(id, -32002, 'Ressource nicht gefunden', { uri }); }
    }
    case 'prompts/list':
      return rpcResult(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
    case 'prompts/get': {
      const p = PROMPTS.find(x => x.name === params.name);
      if (!p) return rpcError(id, -32602, `Unbekannter Prompt: ${params.name}`);
      const args = params.arguments || {};
      const missing = p.arguments.find(x => x.required && !args[x.name]);
      if (missing) return rpcError(id, -32602, `Argument fehlt: ${missing.name}`);
      return rpcResult(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] });
    }
    default:
      return rpcError(id, -32601, `Methode nicht unterstützt: ${method}`);
  }
}

// ---------- HTTP-Handler (POST /mcp) ----------
const limiters = new Map();
export async function mcpHandler(req, res) {
  // Schutz vor DNS-Rebinding: fremde Browser-Origins ablehnen.
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = config.publicUrl ? new URL(origin).origin === new URL(config.publicUrl).origin : new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return res.status(403).json(rpcError(null, -32000, 'Origin nicht erlaubt'));
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(rpcError(null, -32000, 'Nur POST wird unterstützt (zustandsloser Streamable-HTTP-Server).'));
  }
  const s = getMcpSettings();
  if (!s.enabled) return res.status(403).json(rpcError(null, -32000, 'Der MCP-Zugriff ist in Rackbook deaktiviert.'));
  const ctx = authenticate(req);
  if (!ctx) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="rackbook", error="invalid_token"');
    return res.status(401).json(rpcError(null, -32001, 'Ungültiges, abgelaufenes oder widerrufenes Token.'));
  }
  let lim = limiters.get(s.rateLimitPerMinute);
  if (!lim) { lim = new RateLimiter(s.rateLimitPerMinute, 60000); limiters.set(s.rateLimitPerMinute, lim); }
  if (!lim.hit('t' + ctx.token.id)) {
    res.setHeader('Retry-After', String(lim.retryAfter('t' + ctx.token.id)));
    return res.status(429).json(rpcError(null, -32000, 'Zu viele Anfragen – bitte kurz warten.'));
  }
  const body = req.body;
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  if (!msgs.length || msgs.some(m => !m || m.jsonrpc !== '2.0' || typeof m.method !== 'string')) {
    if (msgs.every(m => m && m.jsonrpc === '2.0' && (m.result !== undefined || m.error !== undefined))) return res.status(202).end();
    return res.status(400).json(rpcError(null, -32600, 'Ungültige JSON-RPC-Anfrage'));
  }
  const out = [];
  for (const m of msgs) {
    if (m.id === undefined || m.id === null) continue; // Benachrichtigung (z. B. notifications/initialized)
    try { out.push(await handle(ctx, m, req)); } catch (e) {
      console.error('MCP:', e);
      out.push(rpcError(m.id, -32603, 'Interner Fehler'));
    }
  }
  if (!out.length) return res.status(202).end();
  res.setHeader('Cache-Control', 'no-store');
  res.json(batch ? out : out[0]);
}
