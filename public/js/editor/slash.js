// Einträge des „/“-Menüs
export const GROUPS = ['Basis', 'Medien', 'Datenbank & Planung', 'Erweitert', 'Inline', 'Layout', 'Einbetten'];

export const SLASH_ITEMS = [
  { key: 'p', group: 'Basis', icon: 'text_fields', label: 'Text', desc: 'Tippen Sie einfach mit normalem Text los.', kw: 'absatz paragraph text normal' },
  { key: 'todo', group: 'Basis', icon: 'check_box', label: 'To-do-Liste', desc: 'Aufgaben mit einer To-do-Liste verfolgen.', kw: 'todo aufgabe checkbox task' },
  { key: 'h1', group: 'Basis', icon: 'format_h1', label: 'Überschrift 1', desc: 'Große Abschnittsüberschrift.', kw: 'heading titel h1 #' },
  { key: 'h2', group: 'Basis', icon: 'format_h2', label: 'Überschrift 2', desc: 'Mittlere Abschnittsüberschrift.', kw: 'heading h2 ##' },
  { key: 'h3', group: 'Basis', icon: 'format_h3', label: 'Überschrift 3', desc: 'Kleine Abschnittsüberschrift.', kw: 'heading h3 ###' },
  { key: 'bullet', group: 'Basis', icon: 'format_list_bulleted', label: 'Aufzählung', desc: 'Eine einfache Aufzählungsliste.', kw: 'bullet list liste punkte ul' },
  { key: 'number', group: 'Basis', icon: 'format_list_numbered', label: 'Nummerierte Liste', desc: 'Eine Liste mit Nummerierung.', kw: 'numbered list ol zahlen schritte' },
  { key: 'quote', group: 'Basis', icon: 'format_quote', label: 'Zitat', desc: 'Ein Zitat hervorheben.', kw: 'quote blockquote' },
  { key: 'callout', group: 'Basis', icon: 'info', label: 'Hinweisblock', desc: 'Hinweis, Tipp oder Warnung hervorheben.', kw: 'callout hinweis tipp warnung info note' },
  { key: 'toggle', group: 'Basis', icon: 'arrow_right', label: 'Umschaltblock', desc: 'Aufklappbarer Bereich für Details.', kw: 'toggle aufklappen details' },
  { key: 'code', group: 'Basis', icon: 'code', label: 'Code', desc: 'Code-Block mit Syntax-Sprache.', kw: 'code snippet befehl bash' },
  { key: 'table', group: 'Basis', icon: 'table', label: 'Tabelle', desc: 'Einfache Tabelle mit Zeilen und Spalten.', kw: 'table tabelle' },
  { key: 'hr', group: 'Basis', icon: 'horizontal_rule', label: 'Trennlinie', desc: 'Abschnitte optisch trennen.', kw: 'divider linie hr trenner' },
  { key: 'pagebreak', group: 'Basis', icon: 'insert_page_break', label: 'Seitenumbruch', desc: 'Neue Seite beim Drucken / PDF.', kw: 'page break umbruch drucken' },
  { key: 'footnote', group: 'Basis', icon: 'superscript', label: 'Fußnote', desc: 'Fußnote einfügen und am Ende erläutern.', kw: 'footnote fussnote anmerkung' },

  { key: 'image', group: 'Medien', icon: 'image', label: 'Bild', desc: 'Bild hochladen oder per Link einfügen.', kw: 'image bild foto screenshot' },
  { key: 'video', group: 'Medien', icon: 'movie', label: 'Video', desc: 'Video hochladen oder verlinken.', kw: 'video film' },
  { key: 'audio', group: 'Medien', icon: 'music_note', label: 'Audio', desc: 'Audiodatei hochladen.', kw: 'audio ton sound musik' },
  { key: 'pdf', group: 'Medien', icon: 'picture_as_pdf', label: 'PDF einbetten', desc: 'PDF direkt im Dokument anzeigen.', kw: 'pdf dokument' },
  { key: 'file', group: 'Medien', icon: 'attach_file', label: 'Dateianhang', desc: 'Beliebige Datei zum Herunterladen.', kw: 'file datei anhang upload attachment' },

  { key: 'base', group: 'Datenbank & Planung', icon: 'table_view', label: 'Base (inline)', desc: 'Datenbank mit Spaltentypen und Sortierung.', kw: 'base datenbank database inline' },
  { key: 'kanban', group: 'Datenbank & Planung', icon: 'view_kanban', label: 'Kanban', desc: 'Board mit Spalten und Karten.', kw: 'kanban board karten' },

  { key: 'mathinline', group: 'Erweitert', icon: 'functions', label: 'Mathe (inline)', desc: 'Formel im Fließtext (LaTeX).', kw: 'math mathe formel latex inline' },
  { key: 'math', group: 'Erweitert', icon: 'function', label: 'Matheblock', desc: 'Abgesetzte Formel (LaTeX).', kw: 'math mathe formel latex block equation' },
  { key: 'mermaid', group: 'Erweitert', icon: 'account_tree', label: 'Mermaid-Diagramm', desc: 'Diagramm aus Text (Flussdiagramm, Sequenz …).', kw: 'mermaid diagramm flowchart graph' },
  { key: 'drawio', group: 'Erweitert', icon: 'schema', label: 'Draw.io', desc: 'Diagramm mit dem Draw.io-Editor.', kw: 'drawio diagrams.net diagramm netzwerkplan' },
  { key: 'excalidraw', group: 'Erweitert', icon: 'draw', label: 'Excalidraw', desc: 'Handgezeichnete Skizze.', kw: 'excalidraw skizze zeichnung whiteboard' },
  { key: 'subpages', group: 'Erweitert', icon: 'account_tree', label: 'Unterseiten', desc: 'Liste aller Unterseiten dieser Seite.', kw: 'unterseiten subpages kinder' },
  { key: 'asset', group: 'Erweitert', icon: 'inventory_2', label: 'Inventar-Eintrag', desc: 'Karte mit Angaben aus dem Inventar (IPs, System …).', kw: 'inventar host server vm ip asset gerät netzwerk' },
  { key: 'synced', group: 'Erweitert', icon: 'sync', label: 'Synchronisierter Block', desc: 'Inhalt, der auf mehreren Seiten gleich bleibt.', kw: 'synced sync synchron wiederverwenden' },

  { key: 'date', group: 'Inline', icon: 'event', label: 'Datum', desc: 'Datum einfügen.', kw: 'date datum tag heute' },
  { key: 'time', group: 'Inline', icon: 'schedule', label: 'Uhrzeit', desc: 'Uhrzeit einfügen.', kw: 'time uhrzeit zeit' },
  { key: 'status', group: 'Inline', icon: 'label', label: 'Status', desc: 'Farbige Statusmarke.', kw: 'status label badge marke' },
  { key: 'emoji', group: 'Inline', icon: 'mood', label: 'Emoji', desc: 'Emoji auswählen.', kw: 'emoji smiley icon' },

  { key: 'cols2', group: 'Layout', icon: 'view_column_2', label: '2 Spalten', desc: 'Inhalt in zwei Spalten.', kw: 'columns spalten layout 2' },
  { key: 'cols3', group: 'Layout', icon: 'view_week', label: '3 Spalten', desc: 'Inhalt in drei Spalten.', kw: 'columns spalten layout 3' },
  { key: 'cols4', group: 'Layout', icon: 'view_column', label: '4 Spalten', desc: 'Inhalt in vier Spalten.', kw: 'columns spalten layout 4' },
  { key: 'cols5', group: 'Layout', icon: 'calendar_view_week', label: '5 Spalten', desc: 'Inhalt in fünf Spalten.', kw: 'columns spalten layout 5' },

  { key: 'embed:iframe', group: 'Einbetten', icon: 'web_asset', label: 'iframe einbetten', desc: 'Beliebige Webseite einbetten.', kw: 'iframe embed webseite' },
  { key: 'embed:airtable', group: 'Einbetten', icon: 'table_view', label: 'Airtable', desc: 'Airtable-Ansicht einbetten.', kw: 'airtable' },
  { key: 'embed:loom', group: 'Einbetten', icon: 'videocam', label: 'Loom', desc: 'Loom-Video einbetten.', kw: 'loom video' },
  { key: 'embed:figma', group: 'Einbetten', icon: 'design_services', label: 'Figma', desc: 'Figma-Design einbetten.', kw: 'figma design' },
  { key: 'embed:typeform', group: 'Einbetten', icon: 'quiz', label: 'Typeform', desc: 'Typeform-Formular einbetten.', kw: 'typeform formular umfrage' },
  { key: 'embed:miro', group: 'Einbetten', icon: 'dashboard', label: 'Miro', desc: 'Miro-Board einbetten.', kw: 'miro board whiteboard' },
  { key: 'embed:youtube', group: 'Einbetten', icon: 'smart_display', label: 'YouTube', desc: 'YouTube-Video einbetten.', kw: 'youtube yt video' },
  { key: 'embed:vimeo', group: 'Einbetten', icon: 'movie', label: 'Vimeo', desc: 'Vimeo-Video einbetten.', kw: 'vimeo video' },
  { key: 'embed:framer', group: 'Einbetten', icon: 'web', label: 'Framer', desc: 'Framer-Seite einbetten.', kw: 'framer prototyp' },
  { key: 'embed:gdrive', group: 'Einbetten', icon: 'add_to_drive', label: 'Google Drive', desc: 'Datei oder Ordner aus Google Drive.', kw: 'google drive docs' },
  { key: 'embed:gsheets', group: 'Einbetten', icon: 'grid_on', label: 'Google Sheets', desc: 'Google-Tabelle einbetten.', kw: 'google sheets tabelle spreadsheet' },
];

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const norm2 = s => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
// Suche tolerant gegenüber Umlauten („ueber“, „uber“ und „über“ finden „Überschrift“)
export function filterItems(q) {
  const raw = String(q || '').trim();
  if (!raw) return SLASH_ITEMS;
  const variants = [...new Set([norm(raw), norm2(raw)])];
  const scored = [];
  for (const it of SLASH_ITEMS) {
    const labels = [norm(it.label), norm2(it.label)];
    const hay = labels.join(' ') + ' ' + norm(it.kw) + ' ' + norm2(it.kw) + ' ' + norm(it.group);
    const t = variants.find(v => v.split(/\s+/).every(w => hay.includes(w)));
    if (t === undefined) continue;
    scored.push({ it, s: labels.some(l => l.startsWith(t)) ? 0 : labels.some(l => l.includes(t)) ? 1 : 2 });
  }
  return scored.sort((a, b) => a.s - b.s).map(x => x.it);
}
