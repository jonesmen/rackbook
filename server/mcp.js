// Leichtgewichtiger MCP-Server (Model Context Protocol, Streamable HTTP, zustandslos).
// KI-Assistenten (Claude, ChatGPT, Cursor …) können darüber Dokumentation lesen und pflegen.
import { getSynced, syncedRefs } from './synced.js';
import { getTemplate, listTemplates, applyPlaceholders } from './templates.js';
import { KINDS, STATUSES, FIELDS, listAssets, getAsset, createAsset, updateAsset, ipOverview, ipOverviewText, isIp, parseCidr, ipToInt } from './assets.js';
import { getEditorSettings, storeBuffer, getFileRow, readFileBuffer, fileSnippet, fileRefs, fileDto } from './files.js';
import { fmtSize } from '../public/js/md.js';
import { db, tx, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { HttpError, randomToken, sha256, RateLimiter } from './security.js';
import { audit, clientIp, publicUser } from './auth.js';
import {
  normTitle, normTags, normContent, folderExists, insertDoc, saveRevision, ctrlStrip,
} from './routes/docs.js';
import { excerpt } from '../public/js/md.js';
import { folderAncestors, folderDescendants, checkFolderParent, checkDocParent, moveDocSubtree, docDescendants, docAncestors } from './tree.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SCOPES = ['read', 'write', 'delete', 'folders', 'files'];
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

// ---------- Globale Einstellungen (Verwaltung → KI / MCP) ----------
export const MCP_DEFAULTS = {
  enabled: false,
  allowViewerTokens: true,
  allowWrite: true,
  allowDelete: false,
  allowFolders: false,
  allowFiles: true,
  maxTokenDays: 365,
  aiTag: 'ki',
  guidelines: '',
  rateLimitPerMinute: 120,
};
export const getMcpSettings = () => ({ ...MCP_DEFAULTS, ...getSetting('mcp', {}) });

export function saveMcpSettings(b = {}) {
  const s = getMcpSettings();
  for (const k of ['enabled', 'allowViewerTokens', 'allowWrite', 'allowDelete', 'allowFolders', 'allowFiles']) if (b[k] !== undefined) s[k] = !!b[k];
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
  if (editor && s.allowFiles) out.push('files');
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
    // Ordner-Freigabe gilt inkl. aller Unterordner
    folders: [...new Set(JSON.parse(row.folders).flatMap(f => [...folderDescendants(f)]))],
    rootFolders: JSON.parse(row.folders),
    settings: s,
  };
}

// ---------- Hilfen ----------
class ToolError extends Error {}
const need = (ctx, scope) => {
  if (!ctx.scopes.has(scope)) throw new ToolError(`Keine Berechtigung: Dieses Token hat das Recht „${scope}“ nicht.`);
};
const folderOk = (ctx, f) => !ctx.folders.length || ctx.folders.includes(f);
const folderList = ctx => db.prepare('SELECT id, name, icon, parent_id FROM folders ORDER BY sort, name').all().filter(f => folderOk(ctx, f.id));
const folderName = id => db.prepare('SELECT name FROM folders WHERE id = ?').get(id)?.name || id;
// Vollständiger Pfad, z. B. „Projekte / Rackbook“
const folderPath = id => [...folderAncestors(id).reverse(), id].map(folderName).join(' / ');
const docTitle = id => db.prepare('SELECT title FROM documents WHERE id = ?').get(id)?.title || id;
const children = id => db.prepare('SELECT id, title FROM documents WHERE parent_id = ? AND deleted_at IS NULL ORDER BY title').all(id);
const userName = id => (id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name ?? null : null);

// Ordnerbaum als eingerückte Liste (für die Anleitung)
function folderTree(ctx) {
  const all = folderList(ctx);
  const ids = new Set(all.map(f => f.id));
  const count = id => db.prepare('SELECT COUNT(*) AS n FROM documents WHERE folder_id = ? AND deleted_at IS NULL').get(id).n;
  const out = [];
  const walk = (parent, depth) => all.filter(f => (f.parent_id && ids.has(f.parent_id) ? f.parent_id : null) === parent).forEach(f => {
    out.push(`${'  '.repeat(depth)}- \`${f.id}\` – ${f.name} (${count(f.id)} Dokumente)`);
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  return out.join('\n');
}
const iso = ts => (ts ? new Date(ts).toISOString() : null);

function loadDoc(ctx, id) {
  const d = db.prepare(`SELECT d.*, u.display_name AS updated_by_name FROM documents d LEFT JOIN users u ON u.id = d.updated_by
                        WHERE d.id = ? AND d.deleted_at IS NULL`).get(String(id || ''));
  if (!d || !folderOk(ctx, d.folder_id)) throw new ToolError(`Dokument „${id}“ nicht gefunden (oder nicht freigegeben).`);
  return d;
}
const meta = d => ({
  id: d.id, title: d.title, folder: d.folder_id, folderName: folderName(d.folder_id), folderPath: folderPath(d.folder_id),
  parent: d.parent_id ?? null, parentTitle: d.parent_id ? docTitle(d.parent_id) : null, tags: JSON.parse(d.tags),
  version: d.version, updatedAt: iso(d.updated_at), updatedBy: d.updated_by_name ?? userName(d.updated_by), pinned: !!d.pinned,
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
  const folder = next.folder ?? d.folder_id;
  const parent = next.parent !== undefined ? next.parent : (d.parent_id ?? null);
  db.prepare(`UPDATE documents SET title = ?, folder_id = ?, parent_id = ?, tags = ?, content = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_via = 'mcp'
              WHERE id = ?`).run(next.title ?? d.title, folder, parent, next.tags ?? d.tags, next.content ?? d.content, Date.now(), ctx.user.id, d.id);
  if (folder !== d.folder_id) moveDocSubtree(d.id, folder);
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(d.id);
}
// Elternseite prüfen (inkl. Token-Freigabe); liefert { parent, folder }
function parentFor(ctx, id, parent) {
  if (parent === null || parent === '') return { parent: null, folder: null };
  loadDoc(ctx, parent);
  try { return checkDocParent(id, parent); } catch (e) { throw new ToolError(e.message); }
}
const logWrite = (ctx, req, action, target, details) => {
  req.user = ctx.user;
  audit(req, action, target, { ...details, via: 'mcp', token: ctx.token.name });
};

// ---------- Anleitung für die KI ----------
export function guide(ctx) {
  const s = ctx.settings;
  const folders = folderTree(ctx);
  const perms = [...ctx.scopes].map(x => ({ read: 'lesen & suchen', write: 'Dokumente anlegen & bearbeiten', delete: 'Dokumente in den Papierkorb verschieben', folders: 'Ordner anlegen' }[x])).join(', ');
  return `# Rackbook – Anleitung für KI-Assistenten

Rackbook ist die Markdown-Dokumentation einer IT-/Homelab-Umgebung (Server, Netzwerk, Dienste, Backups, Runbooks).
Du arbeitest im Namen von **${ctx.user.displayName}** (Rolle: ${ctx.user.role}). Deine Rechte: ${perms}.
${ctx.folders.length ? `Du hast nur Zugriff auf diese Ordner (inkl. Unterordner): ${ctx.rootFolders.join(', ')}.\n` : ''}
## Ordner (\`folder\`-ID verwenden, eingerückt = Unterordner)
${folders || '- (keine Ordner freigegeben)'}

## Arbeitsweise
1. **Erst suchen, dann schreiben.** Prüfe mit \`search_documents\`, ob es schon ein Dokument zum Thema gibt. Bestehende Dokumente ergänzen statt Duplikate anlegen.
2. **Vor dem Ändern lesen.** \`get_document\` liefert Inhalt und \`version\`. Für kleine Änderungen \`replace_in_document\` oder \`append_to_document\` nutzen, für Umbauten \`update_document\` mit der gelesenen \`version\`.
3. **Ein Dokument pro Thema** (ein Host, ein Dienst, ein Ablauf). Titel kurz und eindeutig, z. B. „Traefik Reverse Proxy“, „pve-01“, „Wiederherstellung nach Stromausfall“.
4. **Passenden Ordner wählen** (siehe Liste). Gibt es keinen passenden, frage den Benutzer${ctx.scopes.has('folders') ? ' oder lege mit `create_folder` einen an (mit `parent` als Unterordner)' : ''}.
5. **Zusammengehöriges bündeln – pro Projekt/System eine Struktur:** ein **Hauptdokument** (Übersicht, Zugriff, Links) und die Detailthemen als **Unterseiten** davon (\`parent\` = ID des Hauptdokuments, z. B. „SSO“, „Backup“, „Update-Runbook“). Unterseiten liegen automatisch im Ordner ihrer Elternseite. Größere Projekte bekommen einen eigenen (Unter-)Ordner. Nicht dasselbe Projekt über mehrere Ordner verstreuen.
6. **Tags**: 2–5 kurze, kleingeschriebene Schlagwörter (z. B. \`docker\`, \`proxmox\`, \`dns\`) – vorhandene Tags wiederverwenden (\`rackbook_overview\`).${s.aiTag ? ` Das Tag \`${s.aiTag}\` wird bei deinen Änderungen automatisch ergänzt.` : ''}
7. **Keine Geheimnisse speichern**: keine Passwörter, API-Keys, Tokens oder privaten Schlüssel. Stattdessen auf den Ablageort verweisen (z. B. „Passwort in Vaultwarden unter *Dienst / Admin*“).
8. Jede Änderung wird versioniert und ist für Menschen nachvollziehbar. Erfinde keine Fakten – nur dokumentieren, was der Benutzer gesagt hat oder was du verifiziert hast. Unklares als offene Aufgabe (\`- [ ]\`) festhalten.

## Unterstütztes Markdown (Rackbook-Editor)
Der Inhalt ist Markdown; im Web-Editor erscheint jeder Absatz als Block. Verwende nur die folgenden Formen:
- Überschriften \`##\` bis \`####\` (\`#\` nur in Ausnahmefällen – der Titel ist separat). \`##\`/\`###\` bilden das Inhaltsverzeichnis.
- **fett**, *kursiv*, ~~durchgestrichen~~, \`Inline-Code\` für IPs, Hostnamen, Pfade, Ports. Harter Zeilenumbruch: \`\\\` am Zeilenende.
- Code-Blöcke mit Sprache: \`\`\`bash, \`\`\`yaml, \`\`\`ini …
- Listen (\`-\`, \`1.\`), Tabellen (\`| a | b |\` mit Trennzeile \`|---|---|\`)
- Zitat: Zeile mit \`>\`. **Hinweisblock:** erste Zeile \`> [!NOTE]\` (auch \`[!TIP]\`, \`[!IMPORTANT]\`, \`[!WARNING]\`, \`[!CAUTION]\`), danach \`> Text\`
- Aufgaben: \`- [ ] offen\` / \`- [x] erledigt\` – offene Aufgaben erscheinen auf dem Dashboard
- Links: \`[Text](https://…)\`, Verweis auf andere Dokumente: \`[Titel](/doc/<id>)\` – Unterseiten werden unter der Elternseite automatisch aufgelistet
- Aufklappbar: \`:::toggle Titel\` … \`:::\` · Spalten: \`:::columns\` mit 2–5 Blöcken \`:::column\` … \`:::\`, abgeschlossen mit \`:::\`
- Diagramme als Text: \`\`\`mermaid (z. B. \`graph LR\` für Netzwerkpläne, \`sequenceDiagram\` für Abläufe) – bevorzugt für Topologien
- Formeln: \`$…$\` im Text, \`\`\`math für Blöcke (LaTeX)
- Inline: Datum \`{{date:2026-01-31}}\`, Uhrzeit \`{{time:14:30}}\`, Status \`{{status:In Arbeit|blue}}\` (Farben: gray, blue, green, yellow, orange, red, purple)
- Fußnoten: \`[^1]\` im Text und am Ende \`[^1]: Erläuterung\`
- Trennlinie \`---\`, Seitenumbruch für den Druck \`::pagebreak\`, Liste der Unterseiten \`::subpages\`
- Kanban-Board: \`\`\`kanban mit JSON \`{"columns":[{"title":"Offen","color":"gray","cards":[{"title":"…","note":"…"}]}]}\`
- Einbettung (nur wenn der Benutzer es wünscht): \`::embed {"url":"https://…"}\` (YouTube, Vimeo, Loom, Figma, Miro, Airtable, Typeform, Google Drive/Sheets, beliebige https-Seite)
- Dateien: \`list_files\` zeigt hochgeladene Bilder, PDFs und Anhänge (auch je Dokument), \`read_file\` liefert ihren Inhalt (Bilder als Bild, Text/Konfigurationen/SVG als Text, PDFs als Ressource).${ctx.scopes.has('files') ? ' Mit `upload_file` lädst du Dateien hoch (Base64 oder Text, max. 20 MB) – mit `document` direkt ins Dokument; sonst das gelieferte Markdown selbst einfügen. Netzpläne lieber als ```mermaid, Screenshots/Fotos als Bild.' : ''}
- Vorlagen: \`list_templates\` zeigt Vorlagen für Dienst, Host, Runbook, Projekt, Netzwerk, Störung und eigene – neue Dokumente möglichst mit \`create_document\` + \`template\` anlegen und dann füllen.
- Inventar${ctx.folders.length ? ' (für dieses Token nicht verfügbar)' : ''}: Hosts, VMs, Container, Geräte, Dienste und Netzwerke sind als strukturierte Einträge erfasst (\`list_assets\`, \`get_asset\`${ctx.scopes.has('write') ? ', \`save_asset\`' : ''}, \`ip_overview\`). IPs, Hardware und „läuft auf“ gehören ins Inventar, Erklärungen und Abläufe ins Dokument; beides über \`doc\` verknüpfen und im Dokument mit \`::asset {"id":"as_…"}\` als Karte einbinden. Vor dem Vergeben einer IP \`ip_overview\` prüfen.
- Nicht verändern oder neu erfinden: Zeilen mit \`::image\`/\`![…](/files/…)\`, \`::video\`, \`::audio\`, \`::pdf\`, \`::file\`, \`::drawio\`, \`::excalidraw\`, \`::synced\` sowie \`\`\`base-Blöcke – sie verweisen auf hochgeladene Dateien, Zeichnungen bzw. synchronisierte Inhalte. Beim Umschreiben eines Dokuments unverändert übernehmen.
- Kein HTML.

## Empfohlene Struktur
**Dienst/Anwendung:** Kurzbeschreibung (1–2 Sätze) → \`## Zugriff\` (URL, Host, Port) → \`## Installation\` / \`## Konfiguration\` (Code-Blöcke) → \`## Abhängigkeiten\` → \`## Wartung & Updates\` → \`## Offene Punkte\` (Aufgaben).
**Host/Hardware:** Kurzbeschreibung → Tabelle mit Hardware, OS, IP, Standort → \`## Dienste\` → \`## Netzwerk\` → \`## Wartung\`.
**Runbook:** Anlass/Ziel → nummerierte Schritte mit Befehlen → \`## Prüfung\` → \`## Rückfallebene\`.
**Projekt:** Hauptdokument (Zweck, Zugriff, Architektur-Überblick, Abhängigkeiten, offene Punkte) + Unterseiten je Teilthema (Konfiguration, Integrationen, Backup, Runbooks, Entwicklung).
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
      const recent = docs.slice(0, 10).map(d => `- ${d.title} (\`${d.id}\`, ${folderPath(d.folder_id)}${d.parent_id ? `, Unterseite von „${docTitle(d.parent_id)}“` : ''}, ${iso(d.updated_at).slice(0, 10)})`).join('\n');
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
        if (a.folder && !folderDescendants(a.folder).has(d.folder_id)) continue;
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
        text: top.length ? top.map(h => `- **${h.d.title}** (\`${h.d.id}\`, ${folderPath(h.d.folder_id)}${h.d.parent_id ? ` › ${docTitle(h.d.parent_id)}` : ''}) – …${h.snippet}…`).join('\n') : `Keine Treffer für „${a.query}“.`,
        structured: { results: top.map(h => ({ ...meta(h.d), snippet: h.snippet })) },
      };
    },
  },
  {
    name: 'list_documents', scope: 'read', title: 'Dokumente auflisten',
    description: 'Listet Dokumente (neueste zuerst), optional gefiltert nach Ordner (inkl. Unterordner), Elternseite oder Tag.',
    inputSchema: { type: 'object', properties: { folder: str('Optional: Ordner-ID (inkl. Unterordner)'), parent: str('Optional: nur Unterseiten dieses Dokuments'), tag: str('Optional: Tag'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 } } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const inFolder = a.folder ? folderDescendants(a.folder) : null;
      const all = accessibleDocs(ctx).filter(d => (!inFolder || inFolder.has(d.folder_id)) && (!a.parent || d.parent_id === a.parent) && (!a.tag || JSON.parse(d.tags).includes(String(a.tag).toLowerCase())));
      const off = Math.max(0, Number(a.offset) || 0), lim = Math.min(200, Number(a.limit) || 50);
      const page = all.slice(off, off + lim);
      return {
        text: `${all.length} Dokumente${all.length > page.length ? ` (zeige ${off + 1}–${off + page.length})` : ''}:\n` + page.map(d => `- ${d.title} (\`${d.id}\`, ${folderPath(d.folder_id)}${d.parent_id ? ` › Unterseite von „${docTitle(d.parent_id)}“` : ''}, Tags: ${JSON.parse(d.tags).join(', ') || '–'})`).join('\n'),
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
      const kids = children(d.id);
      const synced = getSynced(syncedRefs(d.content));
      const backlinks = db.prepare("SELECT id, title, folder_id FROM documents WHERE deleted_at IS NULL AND id <> ? AND content LIKE ?").all(d.id, `%/doc/${d.id}%`)
        .filter(x => folderOk(ctx, x.folder_id) && new RegExp(`/doc/${d.id}(?![A-Za-z0-9_-])`).test(db.prepare('SELECT content FROM documents WHERE id = ?').get(x.id).content)).map(x => ({ id: x.id, title: x.title }));
      const linkedAssets = listAssets().filter(x => x.doc === d.id).map(x => ({ id: x.id, name: x.name, kind: x.kind }));
      const crumbs = docAncestors(d.id).reverse().map(id => `${docTitle(id)} (\`${id}\`)`).join(' › ');
      return {
        text: `# ${d.title}\nID: ${d.id} · Ordner: ${m.folderPath} (\`${d.folder_id}\`)${crumbs ? ` · Elternseiten: ${crumbs}` : ''} · Tags: ${m.tags.join(', ') || '–'} · Version: ${d.version} · Geändert: ${m.updatedAt}${m.updatedBy ? ' von ' + m.updatedBy : ''}`
          + `${kids.length ? `\nUnterseiten: ${kids.map(k => `${k.title} (\`${k.id}\`)`).join(', ')}` : ''}`
          + `${backlinks.length ? `\nVerlinkt von: ${backlinks.map(k => `${k.title} (\`${k.id}\`)`).join(', ')}` : ''}`
          + `${linkedAssets.length ? `\nInventar: ${linkedAssets.map(k => `${k.name} (${KINDS[k.kind]}, \`${k.id}\`)`).join(', ')}` : ''}\n\n${d.content}`
          + (Object.keys(synced).length ? `\n\n---\nInhalt der eingebundenen synchronisierten Blöcke (nur lesen, nicht in das Dokument kopieren):\n${Object.entries(synced).map(([id, c]) => `[${id}]\n${c}`).join('\n\n')}` : ''),
        structured: { ...m, content: d.content, children: kids, backlinks, assets: linkedAssets, synced },
      };
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
    description: 'Legt ein neues Dokument an – optional als Unterseite eines bestehenden Dokuments (`parent`). Vorher mit search_documents prüfen, ob es das Thema schon gibt. Der Titel wird separat übergeben – den Inhalt nicht mit einer #-Überschrift beginnen.',
    inputSchema: { type: 'object', properties: {
      title: str('Kurzer, eindeutiger Titel'), folder: str('Ordner-ID (siehe rackbook_overview); bei `parent` nicht nötig'),
      parent: str('Optional: ID des Hauptdokuments, unter dem diese Seite als Unterseite erscheint'),
      tags: { type: 'array', items: { type: 'string' }, description: '2–5 kleingeschriebene Tags' }, content: str('Inhalt in Markdown'),
      template: str('Optional: Vorlagen-ID (siehe list_templates). Ohne `content` wird der Vorlageninhalt übernommen; Tags der Vorlage werden ergänzt.'),
    }, required: ['title'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run(ctx, a, req) {
      if (a.template) {
        const t = getTemplate(a.template);
        if (!t) throw new ToolError(`Vorlage „${a.template}“ nicht gefunden (siehe list_templates).`);
        if (!a.content) a.content = applyPlaceholders(t.content);
        a.tags = [...(a.tags || []), ...t.tags];
      }
      if (!a.content) throw new ToolError('Bitte `content` oder `template` angeben.');
      const p = a.parent ? parentFor(ctx, null, a.parent) : { parent: null, folder: null };
      const folder = p.folder || a.folder;
      if (!folder) throw new ToolError('Bitte `folder` oder `parent` angeben.');
      checkFolder(ctx, folder);
      const dup = db.prepare('SELECT id, folder_id FROM documents WHERE lower(title) = lower(?) AND deleted_at IS NULL').all(normTitle(a.title)).find(x => folderOk(ctx, x.folder_id));
      if (dup) throw new ToolError(`Es gibt bereits ein Dokument mit diesem Titel (\`${dup.id}\`). Bitte dieses ergänzen (get_document / append_to_document) oder einen anderen Titel wählen.`);
      const id = insertDoc({ title: a.title, folder, parent: p.parent, tags: withAiTag(ctx, a.tags || []), content: String(a.content || '').replace(/^#\s+.*\n+/, '') }, ctx.user.id, 'mcp');
      const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      logWrite(ctx, req, 'doc.created', id, { title: d.title });
      return { text: `Dokument „${d.title}“ angelegt (ID \`${id}\`, Version 1${p.parent ? `, Unterseite von „${docTitle(p.parent)}“` : ''}, Ordner ${folderPath(folder)}). Link: /doc/${id}`, structured: meta(d) };
    },
  },
  {
    name: 'update_document', scope: 'write', title: 'Dokument überarbeiten',
    description: 'Ersetzt Titel, Ordner, Elternseite (`parent`, leerer String = oberste Ebene), Tags und/oder den gesamten Inhalt. Unterseiten wandern beim Ordnerwechsel mit. `version` aus get_document ist Pflicht – hat ein Mensch das Dokument inzwischen geändert, schlägt die Änderung fehl und du musst neu lesen. Für kleine Änderungen besser replace_in_document oder append_to_document nutzen.',
    inputSchema: { type: 'object', properties: {
      id: str('Dokument-ID'), version: { type: 'integer', description: 'Version aus get_document' }, title: str('Neuer Titel'), folder: str('Neue Ordner-ID'),
      parent: str('Neue Elternseite (Dokument-ID) oder leerer String für oberste Ebene'),
      tags: { type: 'array', items: { type: 'string' } }, content: str('Neuer vollständiger Markdown-Inhalt'),
    }, required: ['id', 'version'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run(ctx, a, req) {
      return tx(() => {
        const d = loadDoc(ctx, a.id);
        if (Number(a.version) !== d.version) throw new ToolError(`Versionskonflikt: aktuell ist Version ${d.version}, übergeben wurde ${a.version}. Bitte get_document erneut aufrufen und die Änderung auf den aktuellen Stand anwenden.`);
        if (a.folder !== undefined) checkFolder(ctx, a.folder);
        let folder = a.folder, parent;
        if (a.parent !== undefined) {
          const p = parentFor(ctx, d.id, a.parent);
          parent = p.parent;
          if (p.folder) folder = p.folder;
        } else if (folder !== undefined && folder !== d.folder_id && d.parent_id) parent = null; // Ordnerwechsel löst von der Elternseite
        const next = {
          title: a.title !== undefined ? normTitle(a.title) : undefined,
          folder,
          parent,
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
      const ids = [d.id, ...docDescendants(d.id)];
      const now = Date.now();
      tx(() => ids.forEach(id => db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now, ctx.user.id, id)));
      logWrite(ctx, req, 'doc.deleted', d.id, { title: d.title, subpages: ids.length - 1 });
      return { text: `„${d.title}“${ids.length > 1 ? ` und ${ids.length - 1} Unterseite(n)` : ''} wurde(n) in den Papierkorb verschoben.` };
    },
  },
  {
    name: 'create_folder', scope: 'folders', title: 'Ordner anlegen',
    description: 'Legt einen neuen Ordner an. Nur wenn kein vorhandener Ordner passt. icon ist ein Material-Symbols-Name (z. B. dns, lan, router, storage, security, cloud, terminal).',
    inputSchema: { type: 'object', properties: { name: str('Ordnername'), parent: str('Optional: ID des übergeordneten Ordners (für Unterordner)'), icon: str('Material-Symbols-Name', { default: 'folder' }), hue: { type: 'integer', minimum: 0, maximum: 360, description: 'Farbton 0–360' } }, required: ['name'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(ctx, a, req) {
      if (ctx.folders.length && !(a.parent && folderOk(ctx, a.parent))) throw new ToolError('Dieses Token ist auf bestimmte Ordner beschränkt und darf nur Unterordner darin anlegen.');
      let parent = null;
      if (a.parent) { if (!folderExists(a.parent)) throw new ToolError(`Ordner „${a.parent}“ existiert nicht.`); try { parent = checkFolderParent(null, a.parent); } catch (e) { throw new ToolError(e.message); } }
      const name = ctrlStrip(a.name).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) throw new ToolError('Bitte einen Namen angeben.');
      const exists = db.prepare('SELECT id FROM folders WHERE lower(name) = lower(?) AND parent_id IS ?').get(name, parent);
      if (exists) throw new ToolError(`Ordner existiert bereits: \`${exists.id}\`.`);
      const icon = /^[a-z0-9_]{1,40}$/.test(a.icon || '') ? a.icon : 'folder';
      const hue = Math.min(360, Math.max(0, Math.round(Number(a.hue ?? 200)) || 0));
      const base = name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ordner';
      let id = base, i = 2;
      while (folderExists(id)) id = `${base}-${i++}`;
      const sort = (db.prepare('SELECT MAX(sort) AS m FROM folders').get().m ?? 0) + 1;
      db.prepare('INSERT INTO folders (id, name, icon, hue, sort, parent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, icon, hue, sort, parent, ctx.user.id, Date.now());
      logWrite(ctx, req, 'folder.created', id, { name, parent });
      return { text: `Ordner „${folderPath(id)}“ angelegt (ID \`${id}\`).` };
    },
  },
  {
    name: 'list_files', scope: 'read', title: 'Dateien auflisten',
    description: 'Listet hochgeladene Dateien (Bilder, PDFs, Anhänge, Diagramme) – alle zugänglichen oder nur die eines Dokuments – mit ID, Typ, Größe, verwendenden Dokumenten und dem Markdown zum Einbinden. Inhalt mit read_file lesen.',
    inputSchema: { type: 'object', properties: { document: str('Optional: nur Dateien dieses Dokuments (ID)'), query: str('Optional: Suche im Dateinamen'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const users = fileUsage();
      let rows;
      if (a.document) {
        const d = loadDoc(ctx, a.document);
        const ids = new Set([...fileRefs(d.content), ...db.prepare('SELECT id FROM files WHERE doc_id = ?').all(d.id).map(r => r.id)]);
        rows = [...ids].map(getFileRow).filter(Boolean);
      } else {
        rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all().filter(f => fileAccessible(ctx, f, users));
      }
      if (a.query) { const q = String(a.query).toLowerCase(); rows = rows.filter(f => f.name.toLowerCase().includes(q)); }
      rows = rows.slice(0, Math.min(200, Number(a.limit) || 50));
      const list = rows.map(f => ({ ...fileDto(f), documents: (users.get(f.id) || []).filter(d => folderOk(ctx, d.folder)).map(d => ({ id: d.id, title: d.title })), markdown: fileSnippet(f) }));
      return {
        text: list.length ? list.map(f => `- \`${f.id}\` ${f.name} · ${f.mime} · ${fmtSize(f.size)}${f.documents.length ? ` · in: ${f.documents.map(d => `${d.title} (\`${d.id}\`)`).join(', ')}` : ' · (nirgends eingebunden)'}\n  Einbinden: ${f.markdown}`).join('\n') : 'Keine Dateien gefunden.',
        structured: { files: list },
      };
    },
  },
  {
    name: 'read_file', scope: 'read', title: 'Datei lesen',
    description: 'Liefert den Inhalt einer hochgeladenen Datei: Bilder (PNG, JPEG, GIF, WebP) als Bild, Textdateien (Konfigurationen, Logs, CSV, JSON, YAML, SVG, Draw.io/Excalidraw-Diagramme) als Text, PDFs als eingebettete Ressource. Andere Formate nur als Metadaten.',
    inputSchema: { type: 'object', properties: { id: str('Datei-ID (aus list_files oder aus /files/<id> im Dokument)') }, required: ['id'] },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const id = String(a.id || '').replace(/^.*\/files\//, '').replace(/[?#].*$/, '');
      const f = getFileRow(id);
      if (!f || !fileAccessible(ctx, f)) throw new ToolError(`Datei „${a.id}“ nicht gefunden (oder nicht freigegeben).`);
      const buf = readFileBuffer(f.id);
      if (!buf) throw new ToolError('Die Datei ist auf dem Server nicht mehr vorhanden.');
      const head = `Datei \`${f.id}\` – ${f.name} (${f.mime}, ${fmtSize(f.size)})`;
      const structured = fileDto(f);
      if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) {
        if (buf.length > 5 * 1048576) return { text: `${head}\nDas Bild ist größer als 5 MB und wird nicht übertragen.`, structured };
        return { content: [{ type: 'text', text: head }, { type: 'image', data: buf.toString('base64'), mimeType: f.mime }], structured };
      }
      if (f.mime === 'application/pdf') {
        if (buf.length > 10 * 1048576) return { text: `${head}\nDas PDF ist größer als 10 MB und wird nicht übertragen.`, structured };
        return { content: [{ type: 'text', text: head }, { type: 'resource', resource: { uri: `rackbook://file/${f.id}`, mimeType: 'application/pdf', blob: buf.toString('base64') } }], structured };
      }
      const text = asText(buf);
      if (text !== null) {
        const max = 512 * 1024;
        const cut = text.length > max;
        return { text: `${head}${cut ? ' – gekürzt auf die ersten 512 KB' : ''}\n\n${cut ? text.slice(0, max) : text}`, structured };
      }
      return { text: `${head}\nDieses Format kann nicht als Text oder Bild übertragen werden.`, structured };
    },
  },
  {
    name: 'upload_file', scope: 'files', title: 'Datei hochladen',
    description: 'Lädt eine Datei hoch (Base64 in `data` oder reiner Text in `text`, z. B. eine Konfigurationsdatei, ein Diagramm als SVG oder ein Screenshot). Liefert das Markdown zum Einbinden. Mit `document` wird sie direkt in dieses Dokument eingefügt (optional am Ende von `section`). Keine Geheimnisse hochladen.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Dateiname mit Endung, z. B. „netzplan.png“ oder „docker-compose.yml“'),
        data: str('Dateiinhalt als Base64 (für Binärdateien wie Bilder oder PDFs)'),
        text: str('Alternativ: Dateiinhalt als Text (UTF-8)'),
        document: str('Optional: Dokument-ID, in das die Datei eingefügt wird'),
        section: str('Optional: Abschnittsüberschrift im Dokument, an deren Ende eingefügt wird'),
        caption: str('Optional: Bildunterschrift/Alternativtext für Bilder'),
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run(ctx, a, req) {
      const es = getEditorSettings();
      if (!es.uploads) throw new ToolError('Datei-Uploads sind in Rackbook deaktiviert (Verwaltung → System → Editor & Medien).');
      const maxBytes = Math.min(es.uploadMaxMb, MCP_UPLOAD_MAX_MB) * 1048576;
      let buf;
      if (typeof a.text === 'string' && a.data === undefined) buf = Buffer.from(a.text, 'utf8');
      else if (typeof a.data === 'string') {
        const b64 = a.data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new ToolError('`data` ist kein gültiges Base64.');
        buf = Buffer.from(b64, b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
      } else throw new ToolError('Bitte `data` (Base64) oder `text` angeben.');
      if (!buf.length) throw new ToolError('Die Datei ist leer.');
      if (buf.length > maxBytes) throw new ToolError(`Datei zu groß (max. ${Math.round(maxBytes / 1048576)} MB über MCP).`);
      let doc = null;
      if (a.document) { need(ctx, 'write'); doc = loadDoc(ctx, a.document); }
      const f = storeBuffer(buf, { name: String(a.name || 'datei'), docId: doc ? doc.id : null, userId: ctx.user.id });
      logWrite(ctx, req, 'file.uploaded', f.id, { name: f.name, size: f.size, mime: f.mime });
      const snippet = fileSnippet(f, a.caption);
      if (doc) {
        const r = TOOLS.find(t => t.name === 'append_to_document').run(ctx, { id: doc.id, content: snippet, section: a.section }, req);
        return { text: `Datei \`${f.id}\` (${f.name}, ${f.mime}, ${fmtSize(f.size)}) hochgeladen und eingefügt. ${r.text}`, structured: { file: f, markdown: snippet, document: r.structured } };
      }
      return { text: `Datei \`${f.id}\` (${f.name}, ${f.mime}, ${fmtSize(f.size)}) hochgeladen.\nZum Einbinden in ein Dokument diese Zeile verwenden (eigener Absatz):\n${snippet}`, structured: { file: f, markdown: snippet } };
    },
  },
  {
    name: 'list_templates', scope: 'read', title: 'Vorlagen auflisten',
    description: 'Listet die Dokumentvorlagen (Dienst, Host, Runbook, Projekt … sowie eigene). Mit create_document und `template` ein neues Dokument daraus anlegen; mit `full: true` auch den Inhalt.',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Inhalt der Vorlagen mitliefern' } } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      const list = listTemplates();
      return {
        text: list.map(t => `- \`${t.id}\` ${t.name}${t.builtin ? ' (mitgeliefert)' : ''} – ${t.description || ''}${a.full ? `\n\n${t.content}\n` : ''}`).join('\n'),
        structured: { templates: list.map(t => ({ id: t.id, name: t.name, description: t.description, tags: t.tags, builtin: t.builtin, ...(a.full ? { content: t.content } : {}) })) },
      };
    },
  },
  {
    name: 'list_assets', scope: 'read', title: 'Inventar auflisten',
    description: `Listet Inventar-Einträge (Typen: ${Object.entries(KINDS).map(([k, v]) => `${k}=${v}`).join(', ')}) mit IPs, Status und „läuft auf“. Filter nach Typ, Suchbegriff (Name, IP, Tags, Felder) oder übergeordnetem Eintrag.`,
    inputSchema: { type: 'object', properties: { kind: str('Optional: Typ', { enum: Object.keys(KINDS) }), query: str('Optional: Suche in Name, IPs, Tags und Feldern'), parent: str('Optional: nur Einträge, die auf diesem Eintrag laufen (ID)') } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      noFolderLimit(ctx);
      const all = listAssets();
      const byId = new Map(all.map(x => [x.id, x]));
      let list = all;
      if (a.kind) list = list.filter(x => x.kind === a.kind);
      if (a.parent) list = list.filter(x => x.parent === a.parent);
      if (a.query) {
        const q = String(a.query).trim().toLowerCase();
        // IP-Suche: genaue Adresse oder Netzwerk, das die Adresse enthält
        if (isIp(q)) {
          list = list.filter(x => x.ips.some(i => i.address.toLowerCase() === q)
            || (x.kind === 'network' && /^\d+\.\d+\.\d+\.\d+$/.test(q) && parseCidr(x.data.cidr) && ipToInt(q) >= parseCidr(x.data.cidr).start && ipToInt(q) <= parseCidr(x.data.cidr).end));
        } else list = list.filter(x => [x.name, ...x.ips.map(i => i.address), ...x.tags, ...Object.values(x.data)].join(' ').toLowerCase().includes(q));
      }
      return {
        text: list.length ? list.map(x => `- \`${x.id}\` ${x.name} (${KINDS[x.kind]}${x.status !== 'active' ? `, ${STATUSES[x.status]}` : ''})${x.ips.length ? ` · ${x.ips.map(i => i.address).join(', ')}` : ''}${x.data.cidr ? ` · ${x.data.cidr}` : ''}${x.parent ? ` · läuft auf ${byId.get(x.parent)?.name || x.parent}` : ''}`).join('\n') : 'Keine Inventar-Einträge gefunden.',
        structured: { assets: list },
      };
    },
  },
  {
    name: 'get_asset', scope: 'read', title: 'Inventar-Eintrag lesen',
    description: 'Liefert einen Inventar-Eintrag mit allen Feldern, IPs, übergeordnetem Eintrag, darauf laufenden Einträgen und verknüpftem Dokument.',
    inputSchema: { type: 'object', properties: { id: str('ID des Eintrags (as_…)') }, required: ['id'] },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      noFolderLimit(ctx);
      const x = getAsset(a.id);
      if (!x) throw new ToolError(`Inventar-Eintrag „${a.id}“ nicht gefunden.`);
      const kids = listAssets().filter(k => k.parent === x.id);
      const parent = x.parent ? getAsset(x.parent) : null;
      const doc = x.doc && db.prepare('SELECT id, title, folder_id FROM documents WHERE id = ? AND deleted_at IS NULL').get(x.doc);
      const lines = [`# ${x.name} (${KINDS[x.kind]}, ${STATUSES[x.status]})`, `ID: \`${x.id}\`${parent ? ` · läuft auf ${parent.name} (\`${parent.id}\`)` : ''}${x.tags.length ? ` · Tags: ${x.tags.join(', ')}` : ''}`];
      if (x.ips.length) lines.push('', 'IPs:', ...x.ips.map(i => `- ${i.address}${i.mac ? ` (MAC ${i.mac})` : ''}${i.note ? ` – ${i.note}` : ''}`));
      const fields = Object.entries(x.data).filter(([k]) => k !== 'notes');
      if (fields.length) lines.push('', ...fields.map(([k, v]) => `- ${k}: ${v}`));
      if (x.data.notes) lines.push('', 'Notizen:', x.data.notes);
      if (kids.length) lines.push('', 'Läuft darauf:', ...kids.map(k => `- ${k.name} (${KINDS[k.kind]}, \`${k.id}\`)`));
      if (doc && folderOk(ctx, doc.folder_id)) lines.push('', `Dokumentation: ${doc.title} (\`${doc.id}\`)`);
      return { text: lines.join('\n'), structured: { ...x, children: kids.map(k => ({ id: k.id, name: k.name, kind: k.kind })) } };
    },
  },
  {
    name: 'save_asset', scope: 'write', title: 'Inventar-Eintrag anlegen/ändern',
    description: `Legt einen Inventar-Eintrag an (ohne \`id\`) oder ändert ihn (mit \`id\`, nur übergebene Felder). Vorher mit list_assets prüfen, ob es ihn schon gibt. \`data\`-Felder: ${FIELDS.join(', ')} (Netzwerke: cidr z. B. 10.0.20.0/24, vlan, gateway, dhcp z. B. 10.0.20.100-10.0.20.200). Keine Passwörter speichern.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Optional: ID eines bestehenden Eintrags'),
        kind: str('Typ', { enum: Object.keys(KINDS) }),
        name: str('Name, z. B. Hostname'),
        status: str('Status', { enum: Object.keys(STATUSES) }),
        parent: str('Optional: ID des Eintrags, auf dem dieser läuft (z. B. VM → Server); leer = keiner'),
        ips: { type: 'array', items: { type: 'object', properties: { address: { type: 'string' }, mac: { type: 'string' }, note: { type: 'string' } }, required: ['address'] }, description: 'IP-Adressen (ersetzt die bisherige Liste)' },
        data: { type: 'object', description: 'Felder (nur übergebene werden geändert; leerer Text löscht ein Feld)', additionalProperties: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        doc: str('Optional: ID des Dokuments mit der ausführlichen Dokumentation'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run(ctx, a, req) {
      noFolderLimit(ctx);
      if (a.doc) loadDoc(ctx, a.doc);
      const body = { ...a };
      delete body.id;
      let x;
      try {
        if (a.id) x = updateAsset(a.id, body, ctx.user.id);
        else {
          if (!a.kind || !a.name) throw new ToolError('Zum Anlegen `kind` und `name` angeben.');
          const dup = listAssets().find(y => y.kind === a.kind && y.name.toLowerCase() === String(a.name).trim().toLowerCase());
          if (dup) throw new ToolError(`Es gibt bereits „${dup.name}“ (\`${dup.id}\`). Zum Ändern \`id\` angeben.`);
          x = createAsset(body, ctx.user.id);
        }
      } catch (e) { if (e instanceof HttpError) throw new ToolError(e.message); throw e; }
      logWrite(ctx, req, a.id ? 'asset.updated' : 'asset.created', x.id, { name: x.name, kind: x.kind });
      const conflicts = ipOverview().conflicts.filter(c => c.assets.some(y => y.id === x.id));
      return {
        text: `Inventar-Eintrag „${x.name}“ ${a.id ? 'aktualisiert' : 'angelegt'} (\`${x.id}\`).${conflicts.length ? `\nAchtung, doppelt vergebene IP: ${conflicts.map(c => `${c.address} (${c.assets.map(y => y.name).join(', ')})`).join('; ')}` : ''}\nIn Dokumente einbinden mit: ::asset {"id":"${x.id}"}`,
        structured: x,
      };
    },
  },
  {
    name: 'ip_overview', scope: 'read', title: 'IP-Belegung',
    description: 'Zeigt je erfasstem Netzwerk die belegten IPs, freie Adressen (nächste 10), DHCP-Bereich und doppelt vergebene IPs. Vor dem Vergeben einer neuen IP aufrufen.',
    inputSchema: { type: 'object', properties: { network: str('Optional: Netzwerk-ID, CIDR oder Name') } },
    annotations: { readOnlyHint: true },
    run(ctx, a) {
      noFolderLimit(ctx);
      const o = ipOverview();
      return { text: ipOverviewText(o, a.network), structured: o };
    },
  },
];

// Inventar gilt für die ganze Umgebung – nicht für Tokens, die auf Ordner beschränkt sind
function noFolderLimit(ctx) {
  if (ctx.folders.length) throw new ToolError('Das Inventar ist nur für Tokens ohne Ordner-Beschränkung verfügbar.');
}

// ---------- Dateien ----------
const MCP_UPLOAD_MAX_MB = 20;
// Welche (nicht gelöschten) Dokumente binden welche Datei ein?
function fileUsage() {
  const map = new Map();
  for (const d of db.prepare('SELECT id, title, folder_id, content FROM documents WHERE deleted_at IS NULL').iterate()) {
    for (const fid of fileRefs(d.content)) { if (!map.has(fid)) map.set(fid, []); map.get(fid).push({ id: d.id, title: d.title, folder: d.folder_id }); }
  }
  return map;
}
// Ohne Ordner-Beschränkung sind alle Dateien lesbar (wie für angemeldete Benutzer in der Web-Oberfläche);
// mit Beschränkung nur Dateien, die in freigegebenen Dokumenten stecken, oder eigene Uploads.
function fileAccessible(ctx, f, usage) {
  if (!ctx.folders.length) return true;
  if (f.created_by === ctx.user.id) return true;
  const docs = (usage || fileUsage()).get(f.id) || [];
  if (docs.some(d => folderOk(ctx, d.folder))) return true;
  const own = f.doc_id && db.prepare('SELECT folder_id FROM documents WHERE id = ? AND deleted_at IS NULL').get(f.doc_id);
  return !!(own && folderOk(ctx, own.folder_id));
}
// Text erkennen: gültiges UTF-8 ohne Steuerzeichen-Müll
function asText(buf) {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return null;
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf.length > 4 * 1048576 ? buf.subarray(0, 4 * 1048576) : buf);
    const ctrl = (t.slice(0, 8192).match(/[\u0001-\u0008\u000e-\u001f]/g) || []).length;
    return ctrl > 8 ? null : t;
  } catch { return null; }
}

// Schneller Vorab-Check des Tokens (bestimmt, wie groß der Anfragekörper sein darf)
export function hasValidToken(req) {
  try { return !!authenticate(req); } catch { return false; }
}

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
        return rpcResult(id, { content: r.content || [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: false });
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
