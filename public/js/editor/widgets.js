// Spezialblöcke des Editors (Code, Tabelle, Medien, Einbettungen, Diagramme, Kanban, Datenbank …)
import { html, Component } from '/vendor/preact-htm.js';
import { embedInfo, EMBED_PROVIDERS, fmtSize, kanbanData, baseData, BASE_TYPES, STATUS_COLORS, bid } from '../md.js';
import { renderTex, renderMermaidInto } from '../hydrate.js';

const LANGS = ['', 'bash', 'shell', 'powershell', 'yaml', 'json', 'ini', 'toml', 'dockerfile', 'nginx', 'apache', 'sql', 'python', 'javascript', 'typescript', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'html', 'css', 'xml', 'markdown', 'diff', 'text'];

// Textarea, die mit dem Inhalt wächst
export class AutoTA extends Component {
  ref = { current: null };
  componentDidMount() { this.fit(); if (this.props.autofocus) this.ref.current.focus(); }
  componentDidUpdate() { this.fit(); }
  fit() { const t = this.ref.current; if (!t) return; t.style.height = 'auto'; t.style.height = Math.max(this.props.min || 40, t.scrollHeight + 2) + 'px'; }
  render(p) {
    return html`<textarea ref=${this.ref} class=${p.cls || ''} value=${p.value} placeholder=${p.placeholder || ''} spellcheck=${p.spellcheck ? 'true' : 'false'}
      onInput=${e => { p.onInput(e.target.value); this.fit(); }}
      onKeyDown=${e => {
        if (e.key === 'Tab' && !e.shiftKey && p.tabs) {
          e.preventDefault();
          const t = e.target, s = t.selectionStart;
          t.setRangeText('  ', s, t.selectionEnd, 'end');
          p.onInput(t.value);
        }
        if (p.onKeyDown) p.onKeyDown(e);
      }}></textarea>`;
  }
}

const copyText = (ed, text) => {
  const done = () => ed.env.flash('In die Zwischenablage kopiert');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
};

// ---------- Code ----------
export function CodeW({ b, ed }) {
  return html`
    <div class="w-code">
      <div class="w-code-head">
        <select class="w-select dark" value=${b.lang || ''} aria-label="Sprache" onChange=${e => ed.mutate(() => { b.lang = e.target.value; })}>
          ${(LANGS.includes(b.lang || '') ? LANGS : [b.lang, ...LANGS]).map(l => html`<option value=${l}>${l || 'Klartext'}</option>`)}
        </select>
        <button type="button" class="w-icon dark" title="Kopieren" onClick=${() => copyText(ed, b.text || '')}><span class="ms">content_copy</span></button>
      </div>
      <${AutoTA} cls="w-code-ta" value=${b.text || ''} tabs placeholder="Code eingeben …" autofocus=${b._new} onInput=${v => ed.mutate(() => { b.text = v; }, 'typing')} />
    </div>`;
}

// ---------- Mathe ----------
class TexPreview extends Component {
  ref = { current: null };
  componentDidMount() { this.draw(); }
  componentDidUpdate(prev) { if (prev.tex !== this.props.tex) this.draw(); }
  draw() { clearTimeout(this.t); this.t = setTimeout(() => { if (this.ref.current) renderTex(this.ref.current, this.props.tex || '\\;', this.props.display); }, 150); }
  render(p) { return html`<div class=${p.display ? 'md-math-block w-preview' : 'md-math'} ref=${this.ref}></div>`; }
}
export function MathW({ b, ed }) {
  return html`
    <div class="w-box">
      <div class="w-head"><span class="ms">function</span>Mathe-Block (LaTeX)</div>
      <${TexPreview} tex=${b.text} display />
      <${AutoTA} cls="w-mono-ta" value=${b.text || ''} placeholder="z. B. E = mc^2  oder  \\sum_{i=1}^{n} i" autofocus=${b._new} onInput=${v => ed.mutate(() => { b.text = v; }, 'typing')} />
    </div>`;
}
export { TexPreview };

// ---------- Mermaid ----------
class MermaidPreview extends Component {
  ref = { current: null };
  componentDidMount() { this.draw(); }
  componentDidUpdate(prev) { if (prev.src !== this.props.src) this.draw(); }
  draw() {
    clearTimeout(this.t);
    this.t = setTimeout(() => {
      const el = this.ref.current;
      if (!el) return;
      if (!String(this.props.src || '').trim()) { el.textContent = 'Noch kein Diagramm.'; return; }
      el.classList.remove('rendered', 'error');
      renderMermaidInto(el, this.props.src);
    }, 400);
  }
  render() { return html`<div class="md-mermaid w-preview" ref=${this.ref}></div>`; }
}
export class MermaidW extends Component {
  state = { code: !!this.props.b._new };
  render({ b, ed }, { code }) {
    return html`
      <div class="w-box">
        <div class="w-head"><span class="ms">account_tree</span>Mermaid-Diagramm
          <span class="grow"></span>
          <button type="button" class="w-btn" onClick=${() => this.setState({ code: !code })}><span class="ms">code</span>${code ? 'Quelltext ausblenden' : 'Quelltext bearbeiten'}</button>
          <button type="button" class="w-icon" title="Quelltext kopieren" onClick=${() => copyText(ed, b.text || '')}><span class="ms">content_copy</span></button>
        </div>
        <${MermaidPreview} src=${b.text} />
        ${code && html`<${AutoTA} cls="w-mono-ta" value=${b.text || ''} tabs placeholder=${'graph LR\n  A[Router] --> B[Switch]'} autofocus onInput=${v => ed.mutate(() => { b.text = v; }, 'typing')} />`}
        <div class="w-hint">Syntax: <a href="https://mermaid.js.org/intro/" target="_blank" rel="noopener noreferrer">mermaid.js.org</a></div>
      </div>`;
  }
}

// ---------- Tabelle ----------
export function TableW({ b, ed }) {
  const rows = b.rows && b.rows.length ? b.rows : (b.rows = [['', ''], ['', '']]);
  const w = rows[0].length;
  const set = (r, c, v) => ed.mutate(() => { rows[r][c] = v; }, 'typing');
  const addRow = at => ed.mutate(() => { rows.splice(at, 0, Array(w).fill('')); });
  const addCol = at => ed.mutate(() => { rows.forEach(r => r.splice(at, 0, '')); });
  const delRow = r => ed.mutate(() => { if (rows.length > 1) rows.splice(r, 1); });
  const delCol = c => ed.mutate(() => { if (w > 1) rows.forEach(r => r.splice(c, 1)); });
  return html`
    <div class="w-table">
      <div class="md-table-wrap">
        <table class="md-table w-tbl">
          <thead><tr>${rows[0].map((h, c) => html`<th><input class="w-cell th" value=${h} placeholder=${'Spalte ' + (c + 1)} onInput=${e => set(0, c, e.target.value)} />
            <span class="w-colops"><button type="button" title="Spalte links einfügen" onClick=${() => addCol(c)}><span class="ms">add</span></button><button type="button" title="Spalte löschen" onClick=${() => delCol(c)}><span class="ms">close</span></button></span></th>`)}</tr></thead>
          <tbody>${rows.slice(1).map((r, k) => html`<tr>${r.map((v, c) => html`<td><input class="w-cell" value=${v} onInput=${e => set(k + 1, c, e.target.value)}
              onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); if (k + 2 === rows.length) addRow(rows.length); requestAnimationFrame(() => { const t = e.target.closest('tbody').rows[k + 1]; t && t.cells[c].querySelector('input').focus(); }); } }} /></td>`)}
            <td class="w-rowops"><button type="button" title="Zeile löschen" onClick=${() => delRow(k + 1)}><span class="ms">close</span></button></td></tr>`)}</tbody>
        </table>
      </div>
      <div class="w-actions">
        <button type="button" class="w-btn" onClick=${() => addRow(rows.length)}><span class="ms">add</span>Zeile</button>
        <button type="button" class="w-btn" onClick=${() => addCol(w)}><span class="ms">add</span>Spalte</button>
      </div>
    </div>`;
}

// ---------- Medien & Dateien ----------
const MEDIA = {
  image: { icon: 'image', label: 'Bild', accept: 'image/*', hint: 'PNG, JPG, GIF, WebP, SVG' },
  video: { icon: 'movie', label: 'Video', accept: 'video/*', hint: 'MP4, WebM, MOV' },
  audio: { icon: 'music_note', label: 'Audio', accept: 'audio/*', hint: 'MP3, OGG, WAV, M4A' },
  pdf: { icon: 'picture_as_pdf', label: 'PDF', accept: 'application/pdf,.pdf', hint: 'PDF-Dokument' },
  file: { icon: 'attach_file', label: 'Datei', accept: '', hint: 'Beliebige Datei als Anhang' },
};
export class MediaW extends Component {
  state = { busy: false, url: '', err: '' };
  fileRef = { current: null };
  async upload(file) {
    const { b, ed } = this.props;
    if (!file) return;
    this.setState({ busy: true, err: '' });
    try {
      const f = await ed.env.upload(file);
      ed.mutate(() => {
        b.src = f.url;
        if (b.type !== 'image') { b.name = f.name; b.size = f.size; } else if (!b.alt) b.alt = f.name.replace(/\.[a-z0-9]+$/i, '');
      });
    } catch (e) { this.setState({ err: e.message || 'Upload fehlgeschlagen' }); }
    this.setState({ busy: false });
  }
  render({ b, ed }, { busy, url, err }) {
    const m = MEDIA[b.type];
    const meta = ed.env.meta || {};
    if (!b.src) {
      return html`
        <div class=${'w-empty' + (busy ? ' busy' : '')} onDragOver=${e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop=${e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) this.upload(f); }}>
          <span class="ms w-empty-i">${m.icon}</span>
          <div class="w-empty-b">
            <div class="w-empty-t">${busy ? 'Wird hochgeladen …' : `${m.label} einfügen`}</div>
            <div class="w-empty-s">${meta.uploads === false ? 'Uploads sind deaktiviert.' : `${m.hint} · max. ${meta.uploadMaxMb || 25} MB · Datei hierher ziehen`}</div>
            <div class="w-empty-row">
              ${meta.uploads !== false && html`<button type="button" class="btn btn-primary sm" disabled=${busy} onClick=${() => this.fileRef.current.click()}><span class="ms s16">upload</span>Hochladen</button>`}
              ${b.type !== 'file' && meta.embeds !== false && html`
                <input class="w-input" placeholder="… oder https://-Adresse" value=${url} onInput=${e => this.setState({ url: e.target.value })}
                  onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); this.useUrl(); } }} />
                <button type="button" class="btn btn-ghost sm" disabled=${!/^https:\/\//i.test(url)} onClick=${() => this.useUrl()}>Übernehmen</button>`}
            </div>
            ${err && html`<div class="w-err">${err}</div>`}
          </div>
          <input type="file" hidden accept=${m.accept} ref=${this.fileRef} onChange=${e => { const f = e.target.files[0]; e.target.value = ''; this.upload(f); }} />
        </div>`;
    }
    const src = ed.env.mediaUrl(b.src);
    const tools = html`<div class="w-float">
      <button type="button" class="w-icon" title="Ersetzen" onClick=${() => ed.mutate(() => { b.src = ''; })}><span class="ms">swap_horiz</span></button>
      <button type="button" class="w-icon" title="Entfernen" onClick=${() => ed.remove(b)}><span class="ms">delete</span></button>
    </div>`;
    if (b.type === 'image') {
      return html`<figure class="md-figure w-media">${tools}<img class="md-img" src=${src} alt=${b.alt || ''} />
        <input class="w-caption" placeholder="Bildunterschrift hinzufügen …" value=${b.caption || ''} onInput=${e => ed.mutate(() => { b.caption = e.target.value; }, 'typing')} /></figure>`;
    }
    if (b.type === 'video') return html`<figure class="md-figure w-media">${tools}<video class="md-video" src=${src} controls preload="metadata"></video></figure>`;
    if (b.type === 'audio') return html`<div class="md-audio w-media">${tools}<div class="md-audio-t"><span class="ms">music_note</span>${b.name || 'Audio'}</div><audio src=${src} controls preload="metadata"></audio></div>`;
    if (b.type === 'pdf') return html`<div class="md-pdf w-media">${tools}<iframe class="md-pdf-frame" src=${src} title=${b.name || 'PDF'}></iframe><div class="md-pdf-link"><span class="ms">picture_as_pdf</span>${b.name || 'PDF'}</div></div>`;
    return html`<div class="md-file w-media">${tools}<span class="ms">attach_file</span><span class="md-file-n">${b.name || 'Datei'}</span><span class="md-file-s">${fmtSize(b.size)}</span></div>`;
  }
  useUrl() {
    const { b, ed } = this.props;
    const u = this.state.url.trim();
    if (!/^https:\/\//i.test(u)) return;
    ed.mutate(() => { b.src = u; if (b.type !== 'image') b.name = decodeURIComponent(u.split('/').pop().split('?')[0] || '') || u; });
  }
}

// ---------- Einbettungen ----------
export class EmbedW extends Component {
  state = { url: '' };
  render({ b, ed }, { url }) {
    const meta = ed.env.meta || {};
    const prov = EMBED_PROVIDERS[b.provider] || EMBED_PROVIDERS.iframe;
    if (!b.url) {
      const info = url && embedInfo(url);
      return html`
        <div class="w-empty">
          <span class="ms w-empty-i">${prov.icon}</span>
          <div class="w-empty-b">
            <div class="w-empty-t">${prov.label} einbetten</div>
            <div class="w-empty-s">${meta.embeds === false ? 'Externe Einbettungen sind vom Administrator deaktiviert – es wird nur ein Link angezeigt.' : 'Link einfügen (https://…). Der Inhalt wird abgesichert in einem iframe angezeigt.'}</div>
            <div class="w-empty-row">
              <input class="w-input wide" placeholder=${placeholderFor(b.provider)} value=${url} autofocus
                onInput=${e => this.setState({ url: e.target.value })} onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); if (info) this.apply(); } }} />
              <button type="button" class="btn btn-primary sm" disabled=${!info} onClick=${() => this.apply()}>Einbetten</button>
            </div>
            ${url && !info && html`<div class="w-err">Bitte eine gültige https://-Adresse angeben.</div>`}
            ${info && info.provider !== 'iframe' && html`<div class="w-hint">Erkannt: ${info.label}</div>`}
          </div>
        </div>`;
    }
    const e = embedInfo(b.url);
    return html`
      <div class="w-embed">
        <div class="w-head"><span class="ms">${e ? e.icon : 'link'}</span>${e ? e.label : 'Einbettung'}<span class="w-head-url">${b.url}</span><span class="grow"></span>
          <select class="w-select" value=${b.height || ''} title="Höhe" onChange=${ev => ed.mutate(() => { b.height = ev.target.value || undefined; })}>
            <option value="">Standardhöhe</option><option value="sm">Niedrig</option><option value="md">Mittel</option><option value="lg">Hoch</option>
          </select>
          <button type="button" class="w-icon" title="Link ändern" onClick=${() => { this.setState({ url: b.url }); ed.mutate(() => { b.url = ''; }); }}><span class="ms">edit</span></button>
        </div>
        <div dangerouslySetInnerHTML=${{ __html: ed.env.renderHtml([{ type: 'embed', url: b.url, height: b.height }]) }}></div>
      </div>`;
  }
  apply() {
    const { b, ed } = this.props;
    const info = embedInfo(this.state.url);
    if (info) ed.mutate(() => { b.url = this.state.url.trim(); delete b.provider; });
  }
}
function placeholderFor(p) {
  return {
    youtube: 'https://www.youtube.com/watch?v=…', vimeo: 'https://vimeo.com/…', loom: 'https://www.loom.com/share/…', figma: 'https://www.figma.com/design/…',
    miro: 'https://miro.com/app/board/…', airtable: 'https://airtable.com/shr…', typeform: 'https://…typeform.com/to/…', framer: 'https://….framer.website',
    gdrive: 'https://drive.google.com/file/d/…', gsheets: 'https://docs.google.com/spreadsheets/d/…',
  }[p] || 'https://…';
}

// ---------- Diagramme (Draw.io / Excalidraw) ----------
export function DiagramW({ b, ed }) {
  const label = b.type === 'drawio' ? 'Draw.io-Diagramm' : 'Excalidraw-Zeichnung';
  const icon = b.type === 'drawio' ? 'schema' : 'draw';
  const open = () => ed.openDiagram(b);
  if (b.type === 'drawio' && !(ed.env.meta || {}).drawioUrl) {
    return html`<div class="w-empty"><span class="ms w-empty-i">${icon}</span><div class="w-empty-b"><div class="w-empty-t">${label}</div><div class="w-empty-s">Draw.io ist nicht eingerichtet. Ein Administrator kann die Adresse unter Administration → System → Editor & Medien festlegen.</div></div></div>`;
  }
  if (!b.src) {
    return html`<button type="button" class="w-empty click" onClick=${open}><span class="ms w-empty-i">${icon}</span><div class="w-empty-b"><div class="w-empty-t">${label}</div><div class="w-empty-s">Klicken, um den Editor zu öffnen.</div></div></button>`;
  }
  return html`<figure class="md-figure md-diagram w-media w-diagram" onDblClick=${open}>
    <div class="w-float"><button type="button" class="w-icon" title="Bearbeiten" onClick=${open}><span class="ms">edit</span></button><button type="button" class="w-icon" title="Entfernen" onClick=${() => ed.remove(b)}><span class="ms">delete</span></button></div>
    <img class="md-img" src=${ed.env.mediaUrl(b.src)} alt=${label} /></figure>`;
}

// Vollbild-Editor im iframe
export class DiagramModal extends Component {
  ref = { current: null };
  state = { busy: false, err: '' };
  componentDidMount() { window.addEventListener('message', this.onMsg); }
  componentWillUnmount() { window.removeEventListener('message', this.onMsg); }
  post(msg) { const w = this.ref.current && this.ref.current.contentWindow; if (w) w.postMessage(this.props.b.type === 'drawio' ? JSON.stringify(msg) : msg, this.origin()); }
  origin() { return this.props.b.type === 'drawio' ? new URL(this.props.drawioUrl).origin : location.origin; }
  async currentSvg() {
    const { b, ed } = this.props;
    if (!b.src) return null;
    try { const r = await fetch(ed.env.mediaUrl(b.src), { credentials: 'same-origin' }); return r.ok ? await r.text() : null; } catch { return null; }
  }
  onMsg = async e => {
    if (!this.ref.current || e.source !== this.ref.current.contentWindow || e.origin !== this.origin()) return;
    const { b } = this.props;
    if (b.type === 'drawio') {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'init') {
        const svg = await this.currentSvg();
        let xml = '';
        if (svg) { try { xml = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement.getAttribute('content') || ''; } catch { xml = ''; } }
        this.post({ action: 'load', xml, autosave: 0, title: 'Rackbook-Diagramm' });
      } else if (m.event === 'save') {
        this.exitAfter = !!m.exit;
        this.post({ action: 'export', format: 'xmlsvg', spinKey: 'saving' });
      } else if (m.event === 'export' && m.data) {
        const svg = m.data.startsWith('data:') ? decodeDataUrl(m.data) : m.data;
        await this.saveSvg(svg, 'diagramm.drawio.svg');
        if (this.exitAfter) this.props.onClose(); else this.post({ action: 'status', message: 'Gespeichert', modified: false });
      } else if (m.event === 'exit') this.props.onClose();
    } else {
      const m = e.data || {};
      if (m.type === 'ready') this.post({ type: 'load', svg: await this.currentSvg() });
      else if (m.type === 'save' && typeof m.svg === 'string') {
        await this.saveSvg(m.svg, 'zeichnung.excalidraw.svg');
        if (m.exit) this.props.onClose(); else this.post({ type: 'saved' });
      } else if (m.type === 'exit') this.props.onClose();
    }
  };
  async saveSvg(svg, name) {
    const { b, ed } = this.props;
    this.setState({ busy: true, err: '' });
    try {
      const f = await ed.env.upload(new File([svg], name, { type: 'image/svg+xml' }));
      ed.mutate(() => { b.src = f.url; });
      this.setState({ busy: false });
    } catch (err) { this.setState({ busy: false, err: err.message || 'Speichern fehlgeschlagen' }); }
  }
  render({ b, drawioUrl, onClose }, { busy, err }) {
    const src = b.type === 'drawio'
      ? `${drawioUrl}/?embed=1&proto=json&spin=1&ui=atlas&libraries=1&saveAndExit=1&noExitBtn=0&lang=de`
      : '/excalidraw.html';
    return html`
      <div class="diagram-overlay" role="dialog" aria-modal="true" aria-label="Diagramm bearbeiten">
        ${(b.type === 'drawio' || busy || err) && html`<div class="diagram-bar">
          <span class="ms">${b.type === 'drawio' ? 'schema' : 'draw'}</span>
          <b>${b.type === 'drawio' ? 'Draw.io' : 'Excalidraw'}</b>
          <span class="muted">${busy ? 'Speichert …' : err || (b.type === 'drawio' ? 'Mit „Speichern“ bzw. „Speichern & Beenden“ übernehmen.' : 'Mit „Speichern“ übernehmen.')}</span>
          <span class="grow"></span>
          <button type="button" class="btn btn-ghost sm" onClick=${onClose}>Schließen</button>
        </div>`}
        <iframe ref=${this.ref} class="diagram-frame" src=${src} title="Diagramm-Editor"></iframe>
      </div>`;
  }
}
function decodeDataUrl(d) {
  const [head, data] = d.split(',');
  return /;base64/.test(head) ? decodeURIComponent(escape(atob(data))) : decodeURIComponent(data);
}

// ---------- Kanban ----------
export class KanbanW extends Component {
  drag = null;
  render({ b, ed }) {
    if (!b.data || !Array.isArray(b.data.columns)) b.data = kanbanData(b.data);
    const d = b.data;
    d.columns.forEach(c => { if (!Array.isArray(c.cards)) c.cards = []; });
    const mut = (fn, kind) => ed.mutate(fn, kind);
    const dropOn = (col, idx) => {
      const g = this.drag; this.drag = null;
      if (!g) return;
      mut(() => {
        const from = d.columns.find(c => c.id === g.col);
        const k = from.cards.findIndex(x => x.id === g.card);
        if (k < 0) return;
        const [card] = from.cards.splice(k, 1);
        let at = idx === undefined ? col.cards.length : idx;
        if (from === col && k < at) at--;
        col.cards.splice(at, 0, card);
      });
    };
    return html`
      <div class="w-kanban md-kanban">
        ${d.columns.map((c, ci) => html`
          <div class="md-kcol" onDragOver=${e => { if (this.drag) e.preventDefault(); }} onDrop=${e => { e.preventDefault(); dropOn(c); }}>
            <div class="md-kcol-h">
              <button type="button" class=${'md-status c-' + c.color + ' w-color'} title="Farbe ändern" onClick=${() => mut(() => { c.color = STATUS_COLORS[(STATUS_COLORS.indexOf(c.color) + 1) % STATUS_COLORS.length]; })}></button>
              <input class="w-kcol-t" value=${c.title} placeholder="Spalte" onInput=${e => mut(() => { c.title = e.target.value; }, 'typing')} />
              <span class="md-kcount">${c.cards.length}</span>
              <button type="button" class="w-icon sm" title="Spalte löschen" onClick=${() => { if (!c.cards.length || confirm(`Spalte „${c.title}“ mit ${c.cards.length} Karte(n) löschen?`)) mut(() => d.columns.splice(ci, 1)); }}><span class="ms">close</span></button>
            </div>
            ${c.cards.map((k, ki) => html`
              <div class="md-kcard w-kcard" draggable="true" onDragStart=${e => { this.drag = { col: c.id, card: k.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k.title); e.stopPropagation(); }}
                onDragOver=${e => { if (this.drag) { e.preventDefault(); e.stopPropagation(); } }} onDrop=${e => { e.preventDefault(); e.stopPropagation(); dropOn(c, ki); }}>
                <input class="w-kcard-t" value=${k.title} placeholder="Karte" onInput=${e => mut(() => { k.title = e.target.value; }, 'typing')} />
                <input class="w-kcard-n" value=${k.note} placeholder="Notiz …" onInput=${e => mut(() => { k.note = e.target.value; }, 'typing')} />
                <button type="button" class="w-icon sm w-kdel" title="Karte löschen" onClick=${() => mut(() => c.cards.splice(ki, 1))}><span class="ms">close</span></button>
              </div>`)}
            <button type="button" class="w-kadd" onClick=${() => mut(() => c.cards.push({ id: bid(), title: '', note: '' }))}><span class="ms">add</span>Karte</button>
          </div>`)}
        <button type="button" class="w-kadd col" onClick=${() => mut(() => d.columns.push({ id: bid(), title: 'Neue Spalte', color: 'gray', cards: [] }))}><span class="ms">add</span>Spalte</button>
      </div>`;
  }
}

// ---------- Datenbank (Base) ----------
export class BaseW extends Component {
  state = { colMenu: null, sort: null };
  render({ b, ed }, { colMenu, sort }) {
    if (!b.data || !Array.isArray(b.data.columns)) b.data = baseData(b.data);
    const d = b.data;
    const mut = (fn, kind) => ed.mutate(fn, kind);
    let rows = d.rows;
    if (sort) {
      const col = d.columns.find(c => c.id === sort.id);
      if (col) {
        const key = r => { const v = r.cells[col.id]; return col.type === 'number' ? Number(v) || 0 : col.type === 'checkbox' ? (v ? 1 : 0) : String(v ?? '').toLowerCase(); };
        rows = rows.slice().sort((x, y) => { const a = key(x), c2 = key(y); const r = typeof a === 'number' ? a - c2 : String(a).localeCompare(String(c2), 'de'); return sort.dir === 'asc' ? r : -r; });
      }
    }
    const cell = (r, c) => {
      const v = r.cells[c.id];
      const set = (val, kind) => mut(() => { r.cells[c.id] = val; }, kind);
      switch (c.type) {
        case 'checkbox': return html`<button type="button" class="w-check" aria-pressed=${!!v} onClick=${() => set(!v)}><span class=${'ms md-check' + (v ? ' fill' : '')}>${v ? 'check_box' : 'check_box_outline_blank'}</span></button>`;
        case 'number': return html`<input class="w-cell num" type="number" step="any" value=${v ?? ''} onInput=${e => set(e.target.value === '' ? '' : Number(e.target.value), 'typing')} />`;
        case 'date': return html`<input class="w-cell" type="date" value=${v || ''} onInput=${e => set(e.target.value)} />`;
        case 'select': return html`<select class="w-cell" value=${v || ''} onChange=${e => set(e.target.value)}><option value="">–</option>${c.options.map(o => html`<option value=${o.label}>${o.label}</option>`)}</select>`;
        case 'url': return html`<input class="w-cell" type="url" placeholder="https://" value=${v || ''} onInput=${e => set(e.target.value, 'typing')} />`;
        default: return html`<input class="w-cell" value=${v || ''} onInput=${e => set(e.target.value, 'typing')} />`;
      }
    };
    return html`
      <div class="w-base md-base">
        <div class="md-base-t"><span class="ms">table_view</span><input class="w-base-t" value=${d.title} placeholder="Datenbank ohne Titel" onInput=${e => mut(() => { d.title = e.target.value; }, 'typing')} /></div>
        <div class="md-table-wrap">
          <table class="md-table w-tbl">
            <thead><tr>
              ${d.columns.map(c => html`<th class="w-base-th">
                <button type="button" class="w-th-btn" onClick=${() => this.setState({ colMenu: colMenu === c.id ? null : c.id })}><span class="ms">${typeIcon(c.type)}</span>${c.name || 'Ohne Namen'}${sort && sort.id === c.id ? html`<span class="ms">${sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'}</span>` : ''}</button>
                ${colMenu === c.id && html`<div class="menu w-colmenu" onClick=${e => e.stopPropagation()}>
                  <input class="w-input" value=${c.name} placeholder="Name" onInput=${e => mut(() => { c.name = e.target.value; }, 'typing')} />
                  <div class="menu-label">TYP</div>
                  <select class="w-input" value=${c.type} onChange=${e => mut(() => { c.type = e.target.value; })}>${Object.entries(BASE_TYPES).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
                  ${c.type === 'select' && html`<div class="menu-label">OPTIONEN (kommagetrennt)</div>
                    <input class="w-input" value=${c.options.map(o => o.label).join(', ')} onChange=${e => mut(() => {
                      const labels = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
                      c.options = labels.map((l, k) => c.options.find(o => o.label === l) || { label: l, color: STATUS_COLORS[(k + 1) % STATUS_COLORS.length] });
                    })} />`}
                  <div class="menu-sep"></div>
                  <button type="button" class="menu-item" onClick=${() => this.setState({ sort: { id: c.id, dir: 'asc' }, colMenu: null })}><span class="ms">arrow_upward</span>Aufsteigend sortieren</button>
                  <button type="button" class="menu-item" onClick=${() => this.setState({ sort: { id: c.id, dir: 'desc' }, colMenu: null })}><span class="ms">arrow_downward</span>Absteigend sortieren</button>
                  <button type="button" class="menu-item danger" onClick=${() => { mut(() => { d.columns = d.columns.filter(x => x !== c); d.rows.forEach(r => delete r.cells[c.id]); }); this.setState({ colMenu: null }); }}><span class="ms">delete</span>Spalte löschen</button>
                </div>`}
              </th>`)}
              <th class="w-addcol"><button type="button" class="w-icon" title="Spalte hinzufügen" onClick=${() => mut(() => d.columns.push({ id: bid(), name: 'Spalte ' + (d.columns.length + 1), type: 'text', options: [] }))}><span class="ms">add</span></button></th>
            </tr></thead>
            <tbody>
              ${rows.map(r => html`<tr>${d.columns.map(c => html`<td class=${c.type === 'number' ? 'num' : ''}>${cell(r, c)}</td>`)}
                <td class="w-rowops"><button type="button" title="Zeile löschen" onClick=${() => mut(() => { d.rows = d.rows.filter(x => x !== r); })}><span class="ms">close</span></button></td></tr>`)}
            </tbody>
          </table>
        </div>
        <div class="w-actions"><button type="button" class="w-btn" onClick=${() => mut(() => d.rows.push({ id: bid(), cells: {} }))}><span class="ms">add</span>Neue Zeile</button>
          ${sort && html`<button type="button" class="w-btn" onClick=${() => this.setState({ sort: null })}><span class="ms">close</span>Sortierung aufheben</button>`}</div>
      </div>`;
  }
}
const typeIcon = t => ({ text: 'notes', number: 'tag', select: 'arrow_drop_down_circle', checkbox: 'check_box', date: 'event', url: 'link' })[t] || 'notes';

// ---------- Unterseiten ----------
export function SubpagesW({ ed }) {
  const list = ed.env.subpages();
  return html`
    <div class="w-box">
      <div class="w-head"><span class="ms">account_tree</span>Unterseiten<span class="grow"></span>
        ${ed.env.newSubpage && html`<button type="button" class="w-btn" onClick=${() => ed.env.newSubpage()}><span class="ms">note_add</span>Unterseite anlegen</button>`}</div>
      <div class="md-subpages">
        ${list.length ? list.map(p => html`<div class="md-subpage"><span class="ms">description</span>${p.title}</div>`) : html`<div class="md-empty">Noch keine Unterseiten – sie erscheinen hier automatisch.</div>`}
      </div>
    </div>`;
}

