// Vorlagen für neue Dokumente: mitgelieferte (nicht änderbar) und eigene (in der Datenbank).
// Platzhalter {{heute}} wird beim Anlegen durch das aktuelle Datum ersetzt.
import { Router } from 'express';
import { db } from './db.js';
import { HttpError, randomToken } from './security.js';
import { requireRole, audit } from './auth.js';
import { normContent, normTags, ctrlStrip } from './routes/docs.js';

export const BUILTIN_TEMPLATES = [
  {
    id: 'builtin-dienst', name: 'Dienst / Anwendung', icon: 'deployed_code', description: 'Docker-Dienst oder Anwendung mit Zugriff, Installation, Backup und Wartung', title: 'Neuer Dienst', tags: ['dienst'],
    content: `Kurzbeschreibung: Wofür wird der Dienst genutzt?

## Zugriff

| | |
|---|---|
| URL | \`https://…\` |
| Host | \`…\` |
| Port | \`…\` |
| Anmeldung | Passwort im Passwortmanager unter *…* |

## Installation

\`\`\`yaml
services:
  app:
    image: …
\`\`\`

## Konfiguration

## Abhängigkeiten

-

## Backup

> [!IMPORTANT]
> Was wird gesichert, wohin und wie oft?

## Wartung & Updates

## Offene Punkte

- [ ] Dokumentation vervollständigen
`,
  },
  {
    id: 'builtin-host', name: 'Host / Server', icon: 'dns', description: 'Physischer Server, VM oder Gerät mit Hardware, Netzwerk und Diensten', title: 'Neuer Host', tags: ['host'],
    content: `Kurzbeschreibung des Hosts.

| Eigenschaft | Wert |
|---|---|
| Typ | Physisch / VM / Container |
| Hardware | |
| Betriebssystem | |
| IP-Adresse | \`…\` |
| Standort | |

## Dienste

-

## Netzwerk

## Wartung

- [ ] Updates prüfen
`,
  },
  {
    id: 'builtin-runbook', name: 'Runbook', icon: 'menu_book', description: 'Schritt-für-Schritt-Anleitung mit Prüfung und Rückfallebene', title: 'Runbook: …', tags: ['runbook'],
    content: `> [!NOTE]
> **Anlass:** Wann wird dieses Runbook gebraucht? **Ziel:** Was ist danach erreicht?

## Voraussetzungen

-

## Schritte

1. Ersten Schritt beschreiben
2. Zweiten Schritt beschreiben

\`\`\`bash
# Befehle
\`\`\`

## Prüfung

- [ ] Dienst erreichbar

## Rückfallebene

> [!WARNING]
> Was tun, wenn etwas schiefgeht?
`,
  },
  {
    id: 'builtin-projekt', name: 'Projekt (Hauptdokument)', icon: 'folder_special', description: 'Übersicht eines Projekts – Details kommen als Unterseiten', title: 'Neues Projekt', tags: ['projekt'],
    content: `## Zweck

Worum geht es in diesem Projekt?

## Zugriff

## Architektur

\`\`\`mermaid
graph LR
  Nutzer --> Proxy[Reverse Proxy]
  Proxy --> App
  App --> DB[(Datenbank)]
\`\`\`

## Abhängigkeiten

## Unterseiten

::subpages

## Offene Punkte

- [ ]
`,
  },
  {
    id: 'builtin-netzwerk', name: 'Netzwerk / VLAN', icon: 'lan', description: 'Netzsegment mit VLAN, Adressbereich und Regeln', title: 'Netzwerk: …', tags: ['netzwerk'],
    content: `| VLAN | Name | Netz | Gateway | DHCP | Zweck |
|---|---|---|---|---|---|
| 10 | | \`10.0.10.0/24\` | \`10.0.10.1\` | | |

## Firewall-Regeln

-

## Offene Punkte

- [ ]
`,
  },
  {
    id: 'builtin-stoerung', name: 'Störung / Vorfall', icon: 'report', description: 'Ablauf, Ursache und Maßnahmen einer Störung festhalten', title: 'Störung: …', tags: ['stoerung'],
    content: `**Beginn:** {{heute}} · **Status:** {{status:In Arbeit|orange}} · **Betroffen:** …

## Ablauf

## Ursache

## Maßnahmen

- [ ]

## Lehren daraus
`,
  },
];

// {{heute}} → Datums-Chip mit dem aktuellen Datum
export function applyPlaceholders(text) {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(text || '').replace(/\{\{heute\}\}/g, `{{date:${iso}}}`);
}

const dto = t => ({
  id: t.id, name: t.name, description: t.description, icon: t.icon, title: t.title, tags: JSON.parse(t.tags || '[]'), content: t.content,
  builtin: false, createdById: t.created_by ?? null, createdBy: t.created_by_name ?? null, updated: t.updated_at,
});
const SELECT = 'SELECT t.*, u.display_name AS created_by_name FROM templates t LEFT JOIN users u ON u.id = t.created_by';

export function listTemplates() {
  return [
    ...BUILTIN_TEMPLATES.map(t => ({ ...t, builtin: true })),
    ...db.prepare(`${SELECT} ORDER BY t.name`).all().map(dto),
  ];
}
export function getTemplate(id) {
  const b = BUILTIN_TEMPLATES.find(t => t.id === id);
  if (b) return { ...b, builtin: true };
  const t = db.prepare(`${SELECT} WHERE t.id = ?`).get(String(id || ''));
  return t ? dto(t) : null;
}

function input(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = ctrlStrip(b.name).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!out.name) throw new HttpError(400, 'Bitte einen Namen für die Vorlage angeben.');
  }
  if (!partial || b.description !== undefined) out.description = ctrlStrip(b.description).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!partial || b.icon !== undefined) out.icon = /^[a-z0-9_]{1,40}$/.test(String(b.icon || '')) ? String(b.icon) : 'description';
  if (!partial || b.title !== undefined) out.title = ctrlStrip(b.title).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!partial || b.tags !== undefined) out.tags = JSON.stringify(normTags(b.tags));
  if (!partial || b.content !== undefined) out.content = normContent(b.content ?? '');
  return out;
}
function mayChange(user, t) {
  return user.role === 'admin' || t.createdById === user.id;
}

export const templateApi = Router();
const editor = requireRole('editor');

templateApi.get('/', (req, res) => res.json({ templates: listTemplates() }));

templateApi.post('/', editor, (req, res) => {
  const b = req.body || {};
  // Aus einem bestehenden Dokument („Als Vorlage speichern“)
  if (b.fromDoc) {
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(String(b.fromDoc));
    if (!d) throw new HttpError(404, 'Dokument nicht gefunden.');
    b.title = b.title ?? d.title;
    b.tags = b.tags ?? JSON.parse(d.tags);
    b.content = b.content ?? d.content;
    b.name = b.name || d.title;
  }
  const t = input(b, false);
  const id = 'tpl_' + randomToken(9);
  const now = Date.now();
  db.prepare('INSERT INTO templates (id, name, description, icon, title, tags, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, t.name, t.description, t.icon, t.title, t.tags, t.content, req.user.id, now, now);
  audit(req, 'template.created', id, { name: t.name });
  res.status(201).json({ template: getTemplate(id) });
});

templateApi.put('/:id', editor, (req, res) => {
  const cur = getTemplate(req.params.id);
  if (!cur) throw new HttpError(404, 'Vorlage nicht gefunden.');
  if (cur.builtin) throw new HttpError(400, 'Mitgelieferte Vorlagen können nicht geändert werden – speichere eine Kopie.');
  if (!mayChange(req.user, cur)) throw new HttpError(403, 'Nur der Ersteller oder ein Administrator kann diese Vorlage ändern.');
  const t = input(req.body || {}, true);
  const keys = Object.keys(t);
  if (keys.length) db.prepare(`UPDATE templates SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => t[k]), Date.now(), cur.id);
  audit(req, 'template.updated', cur.id, { name: t.name ?? cur.name });
  res.json({ template: getTemplate(cur.id) });
});

templateApi.delete('/:id', editor, (req, res) => {
  const cur = getTemplate(req.params.id);
  if (!cur) throw new HttpError(404, 'Vorlage nicht gefunden.');
  if (cur.builtin) throw new HttpError(400, 'Mitgelieferte Vorlagen können nicht gelöscht werden.');
  if (!mayChange(req.user, cur)) throw new HttpError(403, 'Nur der Ersteller oder ein Administrator kann diese Vorlage löschen.');
  db.prepare('DELETE FROM templates WHERE id = ?').run(cur.id);
  audit(req, 'template.deleted', cur.id, { name: cur.name });
  res.json({ ok: true });
});
