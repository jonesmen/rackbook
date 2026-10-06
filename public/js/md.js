// Rackbook-Markdown: Parser (Text → Blöcke), Serializer (Blöcke → Text) und sicherer HTML-Renderer.
// Der gesamte Text wird escaped; Links/Quellen werden auf sichere Schemata beschränkt. Die Ausgabe nutzt
// ausschließlich CSS-Klassen (CSP: keine Inline-Styles). Erweiterungen gegenüber Standard-Markdown:
//   > [!NOTE] Hinweisblock      ::name {json}  Einzelblöcke (Medien, Einbettungen, Diagramme …)
//   :::toggle Titel … :::       :::columns / :::column … :::  Spalten
//   ```math / ```mermaid / ```kanban / ```base   $x^2$ Inline-Mathe   [^1] Fußnoten
//   {{date:2026-01-31}} {{time:14:30}} {{status:Text|farbe}}

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const slug = s => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');

export const CALLOUTS = {
  note: { label: 'Hinweis', icon: 'info' },
  tip: { label: 'Tipp', icon: 'lightbulb' },
  important: { label: 'Wichtig', icon: 'priority_high' },
  warning: { label: 'Warnung', icon: 'warning' },
  caution: { label: 'Achtung', icon: 'dangerous' },
};
export const STATUS_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'];
const LEAF = ['image', 'video', 'audio', 'pdf', 'file', 'embed', 'drawio', 'excalidraw', 'subpages', 'synced', 'pagebreak'];
const FENCED = ['math', 'mermaid', 'kanban', 'base'];

let seq = 0;
export const bid = () => 'b' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- URLs ----------
export function safeHref(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^(#|\/(?!\/)|\.\.?\/)/.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:, data:, vbscript: …
  return u;
}
// Quellen für Bilder/Medien: eigene Dateien oder (falls erlaubt) https
function mediaSrc(src, ctx) {
  const u = String(src || '').trim();
  const m = u.match(/^\/files\/([A-Za-z0-9_-]{20})(?:[?#].*)?$/);
  if (m) return ctx.fileUrl ? ctx.fileUrl(m[1]) : '/files/' + m[1];
  if (/^https:\/\//i.test(u) && ctx.embeds !== false) return u;
  return null;
}
export const fileId = src => (String(src || '').match(/^\/files\/([A-Za-z0-9_-]{20})/) || [])[1] || null;

// ---------- Einbettungen ----------
export const EMBED_PROVIDERS = {
  youtube: { label: 'YouTube', icon: 'smart_display', aspect: 'video' },
  vimeo: { label: 'Vimeo', icon: 'movie', aspect: 'video' },
  loom: { label: 'Loom', icon: 'videocam', aspect: 'video' },
  figma: { label: 'Figma', icon: 'design_services', aspect: 'tall' },
  miro: { label: 'Miro', icon: 'dashboard', aspect: 'tall' },
  airtable: { label: 'Airtable', icon: 'table_view', aspect: 'tall' },
  typeform: { label: 'Typeform', icon: 'quiz', aspect: 'tall' },
  framer: { label: 'Framer', icon: 'web', aspect: 'tall' },
  gdrive: { label: 'Google Drive', icon: 'add_to_drive', aspect: 'tall' },
  gsheets: { label: 'Google Sheets', icon: 'grid_on', aspect: 'tall' },
  iframe: { label: 'Webseite', icon: 'web_asset', aspect: 'tall' },
};
export function embedInfo(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.replace(/^www\./, ''), p = u.pathname;
  let m;
  const out = (provider, src) => ({ provider, src, ...EMBED_PROVIDERS[provider] });
  if (h === 'youtu.be' && (m = p.match(/^\/([\w-]{6,})/))) return out('youtube', `https://www.youtube-nocookie.com/embed/${m[1]}`);
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
    const id = u.searchParams.get('v') || (p.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/) || [])[1];
    if (id && /^[\w-]+$/.test(id)) return out('youtube', `https://www.youtube-nocookie.com/embed/${id}`);
  }
  if (/(^|\.)vimeo\.com$/.test(h) && (m = p.match(/\/(\d{5,})/))) return out('vimeo', `https://player.vimeo.com/video/${m[1]}`);
  if (/(^|\.)loom\.com$/.test(h) && (m = p.match(/^\/(?:share|embed)\/([\w-]+)/))) return out('loom', `https://www.loom.com/embed/${m[1]}`);
  if (/(^|\.)figma\.com$/.test(h)) {
    if (p.startsWith('/embed')) return out('figma', u.href);
    if (/^\/(file|design|proto|board|slides)\//.test(p)) return out('figma', `https://www.figma.com/embed?embed_host=rackbook&url=${encodeURIComponent(u.href)}`);
  }
  if (h === 'miro.com' && (m = p.match(/^\/app\/(?:board|live-embed)\/([^/]+)/))) return out('miro', `https://miro.com/app/live-embed/${m[1]}/`);
  if (h === 'airtable.com') return out('airtable', p.startsWith('/embed/') ? u.href : `https://airtable.com/embed${p}${u.search}`);
  if (/(^|\.)typeform\.com$/.test(h) && (m = p.match(/^\/to\/([\w-]+)/))) return out('typeform', `https://form.typeform.com/to/${m[1]}`);
  if (/(^|\.)framer\.(com|website|app|ai)$/.test(h)) return out('framer', u.href);
  if (h === 'drive.google.com') {
    if ((m = p.match(/^\/file\/d\/([\w-]+)/))) return out('gdrive', `https://drive.google.com/file/d/${m[1]}/preview`);
    if ((m = p.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/))) return out('gdrive', `https://drive.google.com/embeddedfolderview?id=${m[1]}#list`);
    if (u.searchParams.get('id')) return out('gdrive', `https://drive.google.com/file/d/${u.searchParams.get('id')}/preview`);
  }
  if (h === 'docs.google.com' && (m = p.match(/^\/(spreadsheets|document|presentation|forms)\/d\/(e\/)?([\w-]+)/))) {
    if (m[1] === 'forms') return out('gdrive', `https://docs.google.com/forms/d/${m[2] || ''}${m[3]}/viewform?embedded=true`);
    const kind = m[1] === 'spreadsheets' ? 'gsheets' : 'gdrive';
    return out(kind, m[2] ? `https://docs.google.com/${m[1]}/d/e/${m[3]}/pubhtml?widget=true` : `https://docs.google.com/${m[1]}/d/${m[3]}/preview`);
  }
  return out('iframe', u.href);
}

// ---------- Inline ----------
const RX = {
  esc: /\\([!-/:-@[-`{-~])/y,
  code: /(`+)([\s\S]*?[^`])\1(?!`)/y,
  math: /\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/y,
  chip: /\{\{(date|time|status):([^{}\n]*)\}\}/y,
  fn: /\[\^([\w-]{1,30})\]/y,
  img: /!\[([^\]\n]*)\]\(([^)\s]+)\)/y,
  link: /\[((?:\\.|[^\]\\\n])+)\]\(([^)\s]+)\)/y,
  bold: /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/y,
  ital: /\*(?![\s*])([\s\S]*?[^\s\\*])\*(?!\*)/y,
  strike: /~~(?!\s)([\s\S]+?)(?<!\s)~~/y,
};
const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
export function fmtDay(v) {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])}. ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : String(v);
}
export function parseStatus(v) {
  const [label, color] = String(v).split('|');
  return { label: (label || '').trim() || 'Status', color: STATUS_COLORS.includes((color || '').trim()) ? color.trim() : 'gray' };
}
export function chipHtml(kind, value) {
  if (kind === 'date') return `<span class="md-chip"><span class="ms">event</span>${esc(fmtDay(value))}</span>`;
  if (kind === 'time') return `<span class="md-chip"><span class="ms">schedule</span>${esc(value)}</span>`;
  const s = parseStatus(value);
  return `<span class="md-status c-${s.color}">${esc(s.label)}</span>`;
}

// mode 'view' (Lesen) oder 'edit' (contenteditable im Editor: Sonder-Elemente als nicht editierbare Chips)
export function inline(src, ctx = {}, mode = 'view') {
  const s = String(src ?? '');
  const edit = mode === 'edit';
  let out = '', i = 0, m;
  const at = re => { re.lastIndex = i; return re.exec(s); };
  const atom = (md, html) => (edit ? `<span class="ed-atom" contenteditable="false" data-md="${esc(md)}">${html}</span>` : html);
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && (m = at(RX.esc))) { out += esc(m[1]); i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\n') { out += '<br>'; i += 2; continue; }
    if (c === '\n') { out += '<br>'; i++; continue; }
    if (c === '`' && (m = at(RX.code))) {
      const t = m[2].replace(/^ (.*) $/, '$1');
      out += `<code class="md-code">${esc(t)}</code>`; i += m[0].length; continue;
    }
    if (c === '$' && (m = at(RX.math))) {
      out += atom(m[0], `<span class="md-math" data-tex="${esc(m[1])}">${esc(m[1])}</span>`); i += m[0].length; continue;
    }
    if (c === '{' && (m = at(RX.chip))) { out += atom(m[0], chipHtml(m[1], m[2])); i += m[0].length; continue; }
    if (c === '[' && (m = at(RX.fn))) {
      const n = ctx.fnNum ? ctx.fnNum(m[1]) : m[1];
      out += atom(m[0], edit ? `<sup class="md-fnref">${esc(m[1])}</sup>` : `<sup class="md-fnref"><a href="#fn-${esc(slug(m[1]))}" id="fnref-${esc(slug(m[1]))}">${esc(n)}</a></sup>`);
      i += m[0].length; continue;
    }
    if (c === '!' && (m = at(RX.img))) {
      const src = mediaSrc(m[2], ctx);
      out += src ? `<img class="md-inline-img" src="${esc(src)}" alt="${esc(m[1])}" loading="lazy">` : esc(m[1]);
      i += m[0].length; continue;
    }
    if (c === '[' && (m = at(RX.link))) {
      const ok = safeHref(m[2].replace(/\\([()])/g, '$1'));
      const text = inline(m[1], ctx, mode);
      if (!ok) out += text;
      else {
        const ext = /^(https?:|mailto:)/i.test(ok);
        out += `<a href="${esc(ok)}"${ext ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${text}</a>`;
      }
      i += m[0].length; continue;
    }
    if (c === '*' && (m = at(RX.bold))) { out += `<strong>${inline(m[1], ctx, mode)}</strong>`; i += m[0].length; continue; }
    if (c === '*' && (m = at(RX.ital))) { out += `<em>${inline(m[1], ctx, mode)}</em>`; i += m[0].length; continue; }
    if (c === '~' && (m = at(RX.strike))) { out += `<del>${inline(m[1], ctx, mode)}</del>`; i += m[0].length; continue; }
    // Klartext bis zum nächsten möglichen Sonderzeichen
    let j = i + 1;
    while (j < s.length && !'\\\n`${[!*~'.includes(s[j])) j++;
    out += esc(s.slice(i, j));
    i = j;
  }
  return out;
}

export function plain(s) {
  return String(s || '')
    .replace(/\{\{(date|time):([^}]*)\}\}/g, (m, k, v) => (k === 'date' ? fmtDay(v) : v))
    .replace(/\{\{status:([^}|]*)[^}]*\}\}/g, '$1')
    .replace(/\[\^[\w-]+\]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/`/g, '').replace(/\*\*?/g, '').replace(/~~/g, '').replace(/\$/g, '');
}

// ---------- Parser ----------
const isTask = l => /^\s*[-*+]\s+\[[ xX]\]\s/.test(l) || /^\s*[-*+]\s+\[[ xX]\]$/.test(l);
const isUl = l => /^\s*[-*+]\s+/.test(l);
const isOl = l => /^\s*\d+[.)]\s+/.test(l);
const isHr = l => /^\s*(---+|\*\*\*+|___+)\s*$/.test(l);
const isStart = l => /^(#{1,6}\s|```|~~~|>|\||:::|::[a-z]|\[\^[\w-]+\]:\s?)/.test(l.trim()) || isUl(l) || isOl(l) || isHr(l) || /^!\[[^\]]*\]\([^)]+\)\s*$/.test(l.trim());

function parseJson(s) {
  if (!s || !s.trim()) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function parse(src, lineOffset = 0) {
  const L = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0, m;
  while (i < L.length) {
    const l = L[i];
    const ln = i + lineOffset;
    if (!l.trim()) { i++; continue; }
    // Code und Spezialblöcke in Zäunen
    if ((m = l.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/))) {
      const fence = m[1], lang = m[2].toLowerCase(), buf = [];
      i++;
      while (i < L.length && !(L[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*(`{3,}|~{3,})\s*$/.test(L[i]) && L[i].trim().length >= fence.length)) { buf.push(L[i]); i++; }
      i++;
      const text = buf.join('\n');
      if (lang === 'math' || lang === 'mermaid') { out.push({ id: bid(), type: lang, text }); continue; }
      if (lang === 'kanban' || lang === 'base') {
        const data = parseJson(text);
        if (data) { out.push({ id: bid(), type: lang, data }); continue; }
      }
      out.push({ id: bid(), type: 'code', lang: m[2], text });
      continue;
    }
    // Container (:::toggle, :::columns)
    if ((m = l.match(/^\s*(:{3,})(toggle|columns|column)\b\s*(.*)$/))) {
      const name = m[2], arg = m[3].trim(), inner = [];
      const start = i + 1;
      let depth = 1;
      i++;
      while (i < L.length) {
        if (/^\s*:{3,}[a-z]/.test(L[i])) depth++;
        else if (/^\s*:{3,}\s*$/.test(L[i])) { depth--; if (depth === 0) break; }
        inner.push(L[i]); i++;
      }
      i++;
      if (name === 'toggle') out.push({ id: bid(), type: 'toggle', text: arg, children: parse(inner.join('\n'), lineOffset + start) });
      else if (name === 'columns') {
        const cols = parse(inner.join('\n'), lineOffset + start).filter(b => b.type === 'column').map(b => b.children);
        if (cols.length >= 2) out.push({ id: bid(), type: 'columns', cols: cols.slice(0, 5) });
        else cols.forEach(c => out.push(...c));
      } else out.push({ id: bid(), type: 'column', children: parse(inner.join('\n'), lineOffset + start) });
      continue;
    }
    // Einzeldirektiven
    if ((m = l.match(/^\s*::([a-z]+)\s*(\{.*\})?\s*$/)) && LEAF.includes(m[1])) {
      const data = parseJson(m[2] || '');
      if (data && (m[1] !== 'synced' || /^[A-Za-z0-9_-]{8,40}$/.test(String(data.id || '')))) {
        const b = { ...data, id: bid(), type: m[1] };
        delete b.text; delete b.children; delete b.cols; delete b.rows;
        if (b.type === 'synced') b.ref = String(data.id);
        out.push(b);
        i++; continue;
      }
    }
    if ((m = l.match(/^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/))) { out.push({ id: bid(), type: 'h', level: Math.min(4, m[1].length), text: m[2] }); i++; continue; }
    if (isHr(l)) { out.push({ id: bid(), type: 'hr' }); i++; continue; }
    if ((m = l.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/))) {
      out.push({ id: bid(), type: 'image', alt: m[1], src: m[2], caption: m[3] || '' }); i++; continue;
    }
    if ((m = l.match(/^\s*\[\^([\w-]{1,30})\]:\s?(.*)$/))) { out.push({ id: bid(), type: 'footnote', ref: m[1], text: m[2] }); i++; continue; }
    if (l.trim().startsWith('|')) {
      const rows = [];
      while (i < L.length && L[i].trim().startsWith('|')) { rows.push(L[i].trim()); i++; }
      const cells = r => r.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const body = rows.filter((r, k) => !(k === 1 && /^\|[\s:|-]+\|?$/.test(r))).map(cells);
      const w = Math.max(...body.map(r => r.length));
      out.push({ id: bid(), type: 'table', rows: body.map(r => r.concat(Array(w - r.length).fill(''))) });
      continue;
    }
    if (l.trim().startsWith('>')) {
      const buf = [];
      while (i < L.length && L[i].trim().startsWith('>')) { buf.push(L[i].trim().replace(/^>\s?/, '')); i++; }
      const cm = buf[0].match(/^\[!(note|tip|important|warning|caution)\]\s*(.*)$/i);
      if (cm) {
        const rest = [cm[2], ...buf.slice(1)].filter((x, k) => k > 0 || x);
        out.push({ id: bid(), type: 'callout', kind: cm[1].toLowerCase(), text: joinLines(rest) });
      } else out.push({ id: bid(), type: 'quote', text: joinLines(buf) });
      continue;
    }
    if (isTask(l)) {
      const mm = l.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/);
      out.push({ id: bid(), type: 'todo', done: mm[1] !== ' ', text: mm[2], line: ln }); i++; continue;
    }
    if (isUl(l)) { out.push({ id: bid(), type: 'bullet', text: l.replace(/^\s*[-*+]\s+/, '') }); i++; continue; }
    if (isOl(l)) {
      const n = Number(l.match(/^\s*(\d+)/)[1]);
      out.push({ id: bid(), type: 'number', text: l.replace(/^\s*\d+[.)]\s+/, ''), start: n }); i++; continue;
    }
    const buf = [l];
    i++;
    while (i < L.length && L[i].trim() && !isStart(L[i])) { buf.push(L[i]); i++; }
    out.push({ id: bid(), type: 'p', text: joinLines(buf.map(x => x.trim())) });
  }
  return out;
}
// Zeilen eines Absatzes: Backslash am Zeilenende = harter Umbruch, sonst Leerzeichen
function joinLines(lines) {
  let s = '';
  lines.forEach((x, k) => {
    if (k === 0) { s = x; return; }
    if (/(^|[^\\])\\$/.test(s)) s = s.slice(0, -1) + '\n' + x;
    else s += ' ' + x;
  });
  return s.replace(/(^|[^\\])\\$/, '$1');
}

// ---------- Serializer ----------
// Zeilenanfänge, die sonst als Block gelesen würden, werden escaped.
function guardLine(x) {
  if (/^(#{1,6}\s|>|\||:::?|```|~~~|[-*+]\s|\d+[.)]\s|!\[|\[\^[\w-]+\]:)/.test(x) || isHr(x)) return x.replace(/^(\d+)([.)])/, '$1\\$2').replace(/^([#>|:`~*+!\-[])/, '\\$1');
  return x;
}
const textLines = t => String(t || '').split('\n').map(x => x.replace(/\s+$/, ''));
const hardBreaks = (t, guard = true) => textLines(t).map((x, k) => (guard ? guardLine(x) : x)).join('\\\n');
const directive = (name, obj) => `::${name}${obj && Object.keys(obj).length ? ' ' + JSON.stringify(obj) : ''}`;
const pick = (b, keys) => Object.fromEntries(keys.filter(k => b[k] !== undefined && b[k] !== '' && b[k] !== null).map(k => [k, b[k]]));

function fenceFor(text) {
  const runs = String(text).match(/`{3,}/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
}

export function serialize(blocks) {
  const parts = [];
  let prev = null, num = 0;
  for (const b of blocks || []) {
    let s;
    const listy = ['bullet', 'number', 'todo'].includes(b.type);
    if (b.type === 'number') num = prev && prev.type === 'number' ? num + 1 : (b.start && b.start > 0 ? b.start : 1);
    switch (b.type) {
      case 'p': s = hardBreaks(b.text); break;
      case 'h': s = '#'.repeat(b.level || 2) + ' ' + String(b.text || '').replace(/\n/g, ' '); break;
      case 'quote': s = textLines(b.text).map(x => '> ' + x).join('\n'); break;
      case 'callout': s = [`> [!${(b.kind || 'note').toUpperCase()}]`, ...textLines(b.text).map(x => '> ' + x)].join('\n'); break;
      case 'bullet': s = '- ' + String(b.text || '').replace(/\n/g, ' '); break;
      case 'number': s = `${num}. ` + String(b.text || '').replace(/\n/g, ' '); break;
      case 'todo': s = `- [${b.done ? 'x' : ' '}] ` + String(b.text || '').replace(/\n/g, ' '); break;
      case 'code': { const f = fenceFor(b.text); s = `${f}${b.lang || ''}\n${b.text || ''}\n${f}`; break; }
      case 'math': case 'mermaid': { const f = fenceFor(b.text); s = `${f}${b.type}\n${b.text || ''}\n${f}`; break; }
      case 'kanban': case 'base': s = '```' + b.type + '\n' + JSON.stringify(b.data || {}) + '\n```'; break;
      case 'hr': s = '---'; break;
      case 'pagebreak': s = '::pagebreak'; break;
      case 'subpages': s = '::subpages'; break;
      case 'table': {
        const rows = (b.rows && b.rows.length ? b.rows : [['']]).map(r => '| ' + r.map(c => String(c || '').replace(/\n/g, ' ').replace(/\|/g, '\\|')).join(' | ') + ' |');
        const w = (b.rows && b.rows[0] ? b.rows[0].length : 1);
        rows.splice(1, 0, '|' + Array(w).fill('---').join('|') + '|');
        s = rows.join('\n');
        break;
      }
      case 'image':
        s = b.src ? `![${String(b.alt || '').replace(/[[\]\n]/g, '')}](${b.src}${b.caption ? ` "${String(b.caption).replace(/["\n]/g, '')}"` : ''})` : directive('image', {});
        break;
      case 'video': case 'audio': case 'pdf': case 'file': s = directive(b.type, pick(b, ['src', 'name', 'size'])); break;
      case 'embed': s = directive('embed', pick(b, ['url', 'height'])); break;
      case 'drawio': case 'excalidraw': s = directive(b.type, pick(b, ['src'])); break;
      case 'synced': s = directive('synced', { id: b.ref }); break;
      case 'footnote': s = `[^${b.ref}]: ` + String(b.text || '').replace(/\n/g, ' '); break;
      case 'toggle': s = `:::toggle ${String(b.text || '').replace(/\n/g, ' ')}\n${serialize(b.children)}\n:::`; break;
      case 'columns': s = ':::columns\n' + (b.cols || []).map(c => `:::column\n${serialize(c)}\n:::`).join('\n') + '\n:::'; break;
      default: s = hardBreaks(b.text || '');
    }
    // Listenpunkte gleicher Art ohne Leerzeile zusammenhalten
    const join = prev && listy && prev.type === b.type ? '\n' : (prev ? '\n\n' : '');
    parts.push(join + s);
    prev = b;
  }
  return parts.join('');
}

// ---------- Renderer ----------
function renderTable(rows, ctx) {
  const [head, ...body] = rows.length ? rows : [['']];
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map(h => `<th>${inline(h, ctx)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(v < 10240 ? 1 : 0).replace('.', ',') + ' KB';
  return (v / 1048576).toFixed(1).replace('.', ',') + ' MB';
}

export function kanbanData(d) {
  const cols = Array.isArray(d && d.columns) ? d.columns : [];
  return {
    columns: cols.slice(0, 20).map((c, k) => ({
      id: String(c.id || 'c' + k), title: String(c.title ?? ''), color: STATUS_COLORS.includes(c.color) ? c.color : 'gray',
      cards: (Array.isArray(c.cards) ? c.cards : []).slice(0, 500).map((x, j) => ({ id: String(x.id || `k${k}_${j}`), title: String(x.title ?? ''), note: String(x.note ?? '') })),
    })),
  };
}
export const BASE_TYPES = { text: 'Text', number: 'Zahl', select: 'Auswahl', checkbox: 'Checkbox', date: 'Datum', url: 'Link' };
export function baseData(d) {
  const cols = (Array.isArray(d && d.columns) ? d.columns : []).slice(0, 30).map((c, k) => ({
    id: String(c.id || 'c' + k), name: String(c.name ?? ''), type: BASE_TYPES[c.type] ? c.type : 'text',
    options: Array.isArray(c.options) ? c.options.map(o => (typeof o === 'string' ? { label: o, color: 'gray' } : { label: String(o.label ?? ''), color: STATUS_COLORS.includes(o.color) ? o.color : 'gray' })) : [],
  }));
  const rows = (Array.isArray(d && d.rows) ? d.rows : []).slice(0, 2000).map((r, k) => ({ id: String(r.id || 'r' + k), cells: r.cells && typeof r.cells === 'object' ? r.cells : {} }));
  return { title: String((d && d.title) || ''), columns: cols, rows };
}
export function baseCellHtml(col, v, ctx) {
  if (v === undefined || v === null || v === '') return '';
  switch (col.type) {
    case 'checkbox': return `<span class="ms md-check${v ? ' fill' : ''}">${v ? 'check_box' : 'check_box_outline_blank'}</span>`;
    case 'number': return esc(String(v).replace('.', ','));
    case 'date': return esc(fmtDay(v));
    case 'select': { const o = col.options.find(x => x.label === v); return `<span class="md-status c-${o ? o.color : 'gray'}">${esc(v)}</span>`; }
    case 'url': { const ok = /^https?:\/\//i.test(String(v)) && safeHref(v); return ok ? `<a href="${esc(ok)}" target="_blank" rel="noopener noreferrer nofollow">${esc(String(v).replace(/^https?:\/\//, ''))}</a>` : esc(v); }
    default: return inline(String(v), ctx);
  }
}
const sortKey = (col, v) => (col.type === 'number' ? (Number(v) || 0) : col.type === 'checkbox' ? (v ? 1 : 0) : String(v ?? '').toLowerCase());

function renderBlock(b, ctx, st) {
  switch (b.type) {
    case 'h': {
      const t = b.text || '';
      let id = 'h-' + (slug(plain(t)) || 'abschnitt');
      if (st.ids[id]) id += '-' + (++st.ids[id]); else st.ids[id] = 1;
      if (b.level <= 3 && !ctx.nested) st.toc.push({ id, text: plain(t), level: b.level });
      return `<h${b.level} id="${id}" class="md-h${b.level}">${inline(t, ctx)}</h${b.level}>`;
    }
    case 'p': return `<p class="md-p">${inline(b.text, ctx)}</p>`;
    case 'quote': return `<blockquote class="md-quote">${inline(b.text, ctx)}</blockquote>`;
    case 'callout': {
      const c = CALLOUTS[b.kind] || CALLOUTS.note;
      return `<div class="md-callout k-${esc(b.kind in CALLOUTS ? b.kind : 'note')}"><span class="ms">${c.icon}</span><div><div class="md-callout-t">${c.label}</div>${inline(b.text, ctx)}</div></div>`;
    }
    case 'code': return `<div class="md-pre-wrap">${b.lang ? `<span class="md-lang">${esc(b.lang)}</span>` : ''}<button type="button" class="md-copy ms" title="Kopieren" data-copy>content_copy</button><pre class="md-pre">${esc(b.text)}</pre></div>`;
    case 'math': return `<div class="md-math-block" data-tex="${esc(b.text)}"><pre class="md-pre">${esc(b.text)}</pre></div>`;
    case 'mermaid': return `<div class="md-mermaid" data-src="${esc(b.text)}"><pre class="md-pre">${esc(b.text)}</pre></div>`;
    case 'hr': return '<hr class="md-hr">';
    case 'pagebreak': return '<div class="md-pagebreak" role="separator"><span>Seitenumbruch</span></div>';
    case 'table': return renderTable(b.rows || [], ctx);
    case 'image': {
      if (!b.src) return '';
      const src = mediaSrc(b.src, ctx);
      if (!src) return `<div class="md-media-missing"><span class="ms">image</span>${esc(b.alt || 'Bild')}</div>`;
      return `<figure class="md-figure"><img class="md-img" src="${esc(src)}" alt="${esc(b.alt || '')}" loading="lazy">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'video': case 'audio': {
      if (!b.src) return '';
      const src = mediaSrc(b.src, ctx);
      if (!src) return `<div class="md-media-missing"><span class="ms">${b.type === 'video' ? 'movie' : 'music_note'}</span>${esc(b.name || (b.type === 'video' ? 'Video' : 'Audio'))}</div>`;
      return b.type === 'video'
        ? `<figure class="md-figure"><video class="md-video" src="${esc(src)}" controls preload="metadata"></video>${b.name ? `<figcaption>${esc(b.name)}</figcaption>` : ''}</figure>`
        : `<div class="md-audio">${b.name ? `<div class="md-audio-t"><span class="ms">music_note</span>${esc(b.name)}</div>` : ''}<audio src="${esc(src)}" controls preload="metadata"></audio></div>`;
    }
    case 'pdf': {
      if (!b.src) return '';
      const src = mediaSrc(b.src, ctx);
      if (!src) return `<div class="md-media-missing"><span class="ms">picture_as_pdf</span>${esc(b.name || 'PDF')}</div>`;
      return `<div class="md-pdf"><iframe class="md-pdf-frame" src="${esc(src)}" title="${esc(b.name || 'PDF')}" loading="lazy"></iframe><a class="md-pdf-link" href="${esc(src)}" target="_blank" rel="noopener"><span class="ms">open_in_new</span>${esc(b.name || 'PDF öffnen')}</a></div>`;
    }
    case 'file': {
      if (!b.src) return '';
      const src = mediaSrc(b.src, ctx);
      const name = b.name || 'Datei';
      const href = src ? src + (src.includes('?') ? '&' : '?') + 'download' : null;
      return `<${href ? `a href="${esc(href)}" download="${esc(name)}"` : 'div'} class="md-file"><span class="ms">attach_file</span><span class="md-file-n">${esc(name)}</span><span class="md-file-s">${esc(fmtSize(b.size))}</span>${href ? '<span class="ms">download</span>' : ''}</${href ? 'a' : 'div'}>`;
    }
    case 'embed': {
      if (!b.url) return '';
      const e = embedInfo(b.url);
      if (!e) return `<div class="md-media-missing"><span class="ms">link_off</span>Ungültige Einbettung</div>`;
      if (ctx.embeds === false) return `<a class="md-file" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer nofollow"><span class="ms">${e.icon}</span><span class="md-file-n">${esc(e.label)}: ${esc(b.url)}</span><span class="ms">open_in_new</span></a>`;
      const h = ['sm', 'md', 'lg'].includes(b.height) ? b.height : '';
      return `<div class="md-embed a-${e.aspect}${h ? ' h-' + h : ''}"><iframe src="${esc(e.src)}" title="${esc(e.label)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation" allow="fullscreen; picture-in-picture; encrypted-media; clipboard-write" allowfullscreen></iframe></div>`;
    }
    case 'drawio': case 'excalidraw': {
      if (!b.src) return '';
      const src = mediaSrc(b.src, ctx);
      const label = b.type === 'drawio' ? 'Draw.io-Diagramm' : 'Excalidraw-Zeichnung';
      return src ? `<figure class="md-figure md-diagram"><img class="md-img" src="${esc(src)}" alt="${label}" loading="lazy"></figure>` : `<div class="md-media-missing"><span class="ms">${b.type === 'drawio' ? 'schema' : 'draw'}</span>${label} (leer)</div>`;
    }
    case 'subpages': {
      const list = ctx.subpages || [];
      return `<div class="md-subpages">${list.length ? list.map(p => `<a class="md-subpage" href="${esc(p.href || '/doc/' + encodeURIComponent(p.id))}"><span class="ms">description</span>${esc(p.title)}</a>`).join('') : '<div class="md-empty">Keine Unterseiten.</div>'}</div>`;
    }
    case 'synced': {
      const content = ctx.synced && ctx.synced[b.ref];
      if (content === undefined || ctx.inSynced) return `<div class="md-synced missing"><span class="ms">sync_disabled</span>Synchronisierter Block nicht verfügbar</div>`;
      const inner = renderBlocks(parse(content), { ...ctx, inSynced: true, nested: true, interactive: false }, st);
      return `<div class="md-synced">${inner}</div>`;
    }
    case 'kanban': {
      const d = kanbanData(b.data);
      return `<div class="md-kanban">${d.columns.map(c => `<div class="md-kcol"><div class="md-kcol-h"><span class="md-status c-${c.color}">${esc(c.title || 'Spalte')}</span><span class="md-kcount">${c.cards.length}</span></div>${c.cards.map(k => `<div class="md-kcard"><div class="md-kcard-t">${inline(k.title, ctx)}</div>${k.note ? `<div class="md-kcard-n">${inline(k.note, ctx)}</div>` : ''}</div>`).join('')}</div>`).join('')}</div>`;
    }
    case 'base': {
      const d = baseData(b.data);
      return `<div class="md-base">${d.title ? `<div class="md-base-t"><span class="ms">table_view</span>${esc(d.title)}</div>` : ''}<div class="md-table-wrap"><table class="md-table" data-base><thead><tr>${d.columns.map((c, k) => `<th data-sort-col="${k}" tabindex="0" title="Sortieren">${esc(c.name)}<span class="ms md-sort">unfold_more</span></th>`).join('')}</tr></thead><tbody>${d.rows.map(r => `<tr>${d.columns.map(c => `<td data-sort="${esc(String(sortKey(c, r.cells[c.id])))}"${c.type === 'number' ? ' class="num"' : ''}>${baseCellHtml(c, r.cells[c.id], ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
    }
    case 'toggle': return `<details class="md-toggle"><summary>${inline(b.text, ctx) || 'Umschaltblock'}</summary><div class="md-toggle-body">${renderBlocks(b.children || [], { ...ctx, nested: true }, st)}</div></details>`;
    case 'columns': return `<div class="md-cols c${(b.cols || []).length}">${(b.cols || []).map(c => `<div class="md-col">${renderBlocks(c, { ...ctx, nested: true }, st)}</div>`).join('')}</div>`;
    case 'footnote': return '';
    default: return `<p class="md-p">${inline(b.text || '', ctx)}</p>`;
  }
}

function renderBlocks(blocks, ctx, st) {
  const out = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (['bullet', 'number', 'todo'].includes(b.type)) {
      const items = [];
      while (k < blocks.length && blocks[k].type === b.type) items.push(blocks[k++]);
      k--;
      if (b.type === 'todo') {
        const ia = ctx.interactive && !ctx.inSynced;
        out.push(`<ul class="md-tasks">${items.map(it => `<li class="${it.done ? 'done' : ''}"><span class="ms md-check${it.done ? ' fill' : ''}${ia ? ' clickable' : ''}"${ia && it.line !== undefined ? ` data-task-line="${it.line}" role="checkbox" aria-checked="${it.done}" tabindex="0"` : ''}>${it.done ? 'check_box' : 'check_box_outline_blank'}</span><span>${inline(it.text, ctx)}</span></li>`).join('')}</ul>`);
      } else {
        const tag = b.type === 'number' ? 'ol' : 'ul';
        const start = b.type === 'number' && b.start > 1 ? ` start="${Number(b.start)}"` : '';
        out.push(`<${tag} class="md-list"${start}>${items.map(it => `<li>${inline(it.text, ctx)}</li>`).join('')}</${tag}>`);
      }
      continue;
    }
    out.push(renderBlock(b, ctx, st));
  }
  return out.join('');
}

function collectFootnotes(blocks, acc = []) {
  for (const b of blocks) {
    if (b.type === 'footnote') acc.push(b);
    if (b.children) collectFootnotes(b.children, acc);
    if (b.cols) b.cols.forEach(c => collectFootnotes(c, acc));
  }
  return acc;
}

// ctx: { interactive, fileUrl(id), embeds, synced: {id: md}, subpages: [{id,title,href}] }
export function renderMd(blocks, ctx = {}) {
  const st = { toc: [], ids: {} };
  const notes = collectFootnotes(blocks);
  const order = notes.map(n => n.ref);
  const c = { ...ctx, fnNum: ref => (order.indexOf(ref) >= 0 ? order.indexOf(ref) + 1 : ref) };
  let html = renderBlocks(blocks, c, st);
  if (notes.length) {
    html += `<section class="md-footnotes"><ol>${notes.map(n => `<li id="fn-${esc(slug(n.ref))}">${inline(n.text, c)} <a href="#fnref-${esc(slug(n.ref))}" class="md-fnback" aria-label="Zurück zum Text">↩</a></li>`).join('')}</ol></section>`;
  }
  if (!html) html = '<p class="md-empty">Noch kein Inhalt.</p>';
  return { html, toc: st.toc };
}

export function md(src, ctx = {}) {
  return renderMd(parse(src), ctx);
}

export function excerpt(c) {
  const line = String(c || '').split('\n').find(l => l.trim() && !/^(#|\||-|\*|>|```|~~~|\d+\.|::|!\[|\[\^|\{)/.test(l.trim())) || '';
  const t = plain(line);
  return t.length > 120 ? t.slice(0, 118) + '…' : t;
}
