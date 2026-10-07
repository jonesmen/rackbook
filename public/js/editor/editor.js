// Block-Editor (Notion-ähnlich): jeder Absatz ist ein Block, „/“ öffnet das Einfügemenü.
// Gespeichert wird weiterhin Markdown (siehe md.js) – so bleiben Suche, Export und MCP unverändert nutzbar.
import { html, Component } from '/vendor/preact-htm.js';
import { parse, serialize, bid, CALLOUTS, STATUS_COLORS, parseStatus, fmtDay, esc, ASSET_ICONS } from '../md.js';
import { domToMd, toEditHtml, setCaret, caretOffset, caretAtStart, caretAtEnd, caretOnFirstLine, caretOnLastLine, caretClientRect, splitAtCaret, textLen } from './dom.js';
import { GROUPS, filterItems } from './slash.js';
import { EMOJI_GROUPS, searchEmoji } from './emoji.js';
import { hydrate } from '../hydrate.js';
import { CodeW, MathW, MermaidW, TableW, MediaW, EmbedW, DiagramW, DiagramModal, KanbanW, BaseW, SubpagesW, TexPreview } from './widgets.js';

const TEXT_TYPES = ['p', 'h', 'quote', 'callout', 'bullet', 'number', 'todo', 'footnote', 'toggle'];
const isText = b => TEXT_TYPES.includes(b.type);
const LISTY = ['bullet', 'number', 'todo'];
const TURN_INTO = [
  ['p', 'Text', 'text_fields'], ['h1', 'Überschrift 1', 'format_h1'], ['h2', 'Überschrift 2', 'format_h2'], ['h3', 'Überschrift 3', 'format_h3'],
  ['bullet', 'Aufzählung', 'format_list_bulleted'], ['number', 'Nummerierte Liste', 'format_list_numbered'], ['todo', 'To-do-Liste', 'check_box'],
  ['quote', 'Zitat', 'format_quote'], ['callout', 'Hinweisblock', 'info'], ['toggle', 'Umschaltblock', 'arrow_right'],
];
const PLACEHOLDER = { p: "Tippe „/“ für Befehle …", h: 'Überschrift', quote: 'Zitat', callout: 'Hinweis', bullet: 'Listenpunkt', number: 'Listenpunkt', todo: 'Aufgabe', footnote: 'Fußnotentext', toggle: 'Umschaltblock' };

// ---------- Baum-Helfer ----------
function childLists(b) {
  if (b.type === 'toggle') return [b.children || (b.children = [])];
  if (b.type === 'columns') return b.cols || (b.cols = []);
  return [];
}
function locate(list, id, parent = null) {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === id) return { arr: list, idx: i, b, parent };
    for (const sub of childLists(b)) { const r = locate(sub, id, b); if (r) return r; }
  }
  return null;
}
function textOrder(list, out = []) {
  for (const b of list) {
    if (isText(b)) out.push(b.id);
    if (b.type === 'toggle' && b._closed) continue;
    for (const sub of childLists(b)) textOrder(sub, out);
  }
  return out;
}
function contains(b, id) {
  for (const sub of childLists(b)) for (const c of sub) if (c.id === id || contains(c, id)) return true;
  return false;
}
function fresh(b) { // tiefe Kopie mit neuen IDs
  const c = JSON.parse(JSON.stringify(b));
  const walk = x => { x.id = bid(); childLists(x).forEach(l => l.forEach(walk)); };
  walk(c);
  return c;
}
const newText = (type = 'p', extra = {}) => ({ id: bid(), type, text: '', ...extra });

// ---------- Textblock (contenteditable) ----------
class TextBlock extends Component {
  ref = { current: null };
  shown = null;
  componentDidMount() { this.sync(); this.props.ed.register(this.props.b.id, this.ref.current, this); }
  componentWillUnmount() { this.props.ed.unregister(this.props.b.id, this.ref.current); }
  componentDidUpdate() { this.sync(); this.props.ed.register(this.props.b.id, this.ref.current, this); }
  shouldComponentUpdate(np) { return np.b !== this.props.b || np.b.text !== this.shown || np.cls !== this.props.cls || np.ph !== this.props.ph; }
  sync() {
    const el = this.ref.current, t = this.props.b.text || '';
    if (el && t !== this.shown) { el.innerHTML = t ? toEditHtml(t) : ''; this.shown = t; if (t.includes('$')) hydrate(el); }
  }
  read() {
    const el = this.ref.current;
    if (!el) return;
    if (!el.textContent && !el.querySelector('[data-md],img')) el.innerHTML = '';
    const t = domToMd(el);
    this.shown = t;
    this.props.b.text = t;
  }
  render({ b, ed, cls, ph, tag }) {
    const T = tag || 'div';
    return html`<${T} ref=${this.ref} class=${'ed-text ' + (cls || '')} contenteditable=${ed.readOnly ? 'false' : 'true'} spellcheck="true"
      data-ph=${ph || PLACEHOLDER[b.type] || ''} data-bid=${b.id}
      onInput=${e => { ed.beforeTyping(); this.read(); ed.onTextInput(b, e, this.ref.current); }}
      onKeyDown=${e => ed.onKey(b, e, this.ref.current, this)}
      onPaste=${e => ed.onPaste(b, e, this.ref.current, this)}
      onClick=${e => ed.onTextClick(b, e, this.ref.current, this)}
      onFocus=${() => ed.setActive(b.id)}></${T}>`;
  }
}

// ---------- Synchronisierter Block ----------
class SyncedW extends Component {
  render({ b, ed }) {
    const tree = ed.syncedTree(b.ref);
    const uses = ed.env.synced.usage(b.ref);
    if (tree === undefined) return html`<div class="md-synced missing"><span class="ms">sync_problem</span>Synchronisierter Block nicht gefunden.</div>`;
    const dup = ed.syncedOwner(b.ref) !== b.id;
    return html`
      <div class="ed-synced">
        <div class="ed-synced-bar"><span class="ms">sync</span>Synchronisierter Block${uses > 1 ? ` · auf ${uses} Seiten verwendet` : ''}
          <span class="grow"></span>
          <button type="button" class="w-btn" title="Inhalt als normale Blöcke übernehmen" onClick=${() => ed.unsync(b)}><span class="ms">sync_disabled</span>Synchronisierung aufheben</button>
        </div>
        ${dup ? html`<div class="md-body" dangerouslySetInnerHTML=${{ __html: ed.env.renderHtml(tree) }}></div>` : html`<${BlockList} list=${tree} ed=${ed} />`}
      </div>`;
  }
}

// ---------- Zeile mit Griff ----------
function BlockRow({ b, ed, num }) {
  const drop = ed.state.drop && ed.state.drop.id === b.id ? ' drop-' + ed.state.drop.pos : '';
  const active = ed.state.active === b.id ? ' active' : '';
  return html`
    <div class=${'ed-row t-' + b.type + (b.type === 'h' ? ' lv' + b.level : '') + drop + active} data-row=${b.id}
      onDragOver=${e => ed.onRowDragOver(b, e)} onDrop=${e => ed.onRowDrop(b, e)}>
      ${!ed.readOnly && html`<div class="ed-gutter" contenteditable="false">
        <button type="button" class="ed-g" title="Block darunter einfügen" tabindex="-1" onMouseDown=${e => e.preventDefault()} onClick=${() => ed.plus(b)}><span class="ms">add</span></button>
        <button type="button" class="ed-g drag" title="Ziehen zum Verschieben · Klicken für Optionen" tabindex="-1" draggable="true"
          onDragStart=${e => ed.onDragStart(b, e)} onDragEnd=${() => ed.onDragEnd()}
          onClick=${e => ed.openMenu(b, e)}><span class="ms">drag_indicator</span></button>
      </div>`}
      <div class="ed-content">${blockBody(b, ed, num)}</div>
    </div>`;
}

function blockBody(b, ed, num) {
  const mut = (fn, kind) => ed.mutate(fn, kind);
  switch (b.type) {
    case 'p': return html`<${TextBlock} b=${b} ed=${ed} cls="md-p" />`;
    case 'h': return html`<${TextBlock} b=${b} ed=${ed} cls=${'md-h' + b.level} ph=${'Überschrift ' + b.level} />`;
    case 'quote': return html`<${TextBlock} b=${b} ed=${ed} cls="md-quote" />`;
    case 'callout': {
      const c = CALLOUTS[b.kind] || CALLOUTS.note;
      return html`<div class=${'md-callout k-' + (b.kind in CALLOUTS ? b.kind : 'note')}>
        <button type="button" class="ms ed-callout-i" title="Art ändern" contenteditable="false" onClick=${e => ed.openMenu(b, e, 'callout')}>${c.icon}</button>
        <div class="grow"><${TextBlock} b=${b} ed=${ed} cls="ed-callout-t" ph=${c.label + ' …'} /></div></div>`;
    }
    case 'bullet': return html`<div class="ed-li"><span class="ed-marker" contenteditable="false">•</span><${TextBlock} b=${b} ed=${ed} cls="ed-li-t" /></div>`;
    case 'number': return html`<div class="ed-li"><span class="ed-marker num" contenteditable="false">${num}.</span><${TextBlock} b=${b} ed=${ed} cls="ed-li-t" /></div>`;
    case 'todo': return html`<div class=${'ed-li todo' + (b.done ? ' done' : '')}>
      <button type="button" class=${'ms md-check ed-check' + (b.done ? ' fill' : '')} contenteditable="false" aria-pressed=${!!b.done} onMouseDown=${e => e.preventDefault()} onClick=${() => mut(() => { b.done = !b.done; })}>${b.done ? 'check_box' : 'check_box_outline_blank'}</button>
      <${TextBlock} b=${b} ed=${ed} cls="ed-li-t" /></div>`;
    case 'footnote': return html`<div class="ed-li fn"><span class="ed-marker fn" contenteditable="false">[${b.ref}]</span><${TextBlock} b=${b} ed=${ed} cls="ed-li-t" /></div>`;
    case 'toggle': return html`<div class="ed-toggle">
      <div class="ed-toggle-h"><button type="button" class=${'ms ed-caret' + (b._closed ? '' : ' open')} contenteditable="false" onMouseDown=${e => e.preventDefault()} onClick=${() => { b._closed = !b._closed; ed.rerender(); }}>arrow_right</button>
        <${TextBlock} b=${b} ed=${ed} cls="ed-toggle-t" ph="Umschaltblock" /></div>
      ${!b._closed && html`<div class="ed-toggle-body"><${BlockList} list=${b.children || (b.children = [newText()])} ed=${ed} /></div>`}
    </div>`;
    case 'columns': return html`<div class=${'ed-cols md-cols c' + (b.cols || []).length}>${(b.cols || []).map(c => html`<div class="md-col ed-col"><${BlockList} list=${c} ed=${ed} /></div>`)}</div>`;
    case 'synced': return html`<${SyncedW} b=${b} ed=${ed} />`;
    case 'code': return html`<${CodeW} b=${b} ed=${ed} />`;
    case 'math': return html`<${MathW} b=${b} ed=${ed} />`;
    case 'mermaid': return html`<${MermaidW} b=${b} ed=${ed} />`;
    case 'table': return html`<${TableW} b=${b} ed=${ed} />`;
    case 'image': case 'video': case 'audio': case 'pdf': case 'file': return html`<${MediaW} b=${b} ed=${ed} />`;
    case 'embed': return html`<${EmbedW} b=${b} ed=${ed} />`;
    case 'drawio': case 'excalidraw': return html`<${DiagramW} b=${b} ed=${ed} />`;
    case 'kanban': return html`<${KanbanW} b=${b} ed=${ed} />`;
    case 'base': return html`<${BaseW} b=${b} ed=${ed} />`;
    case 'subpages': return html`<${SubpagesW} b=${b} ed=${ed} />`;
    case 'asset': return html`<div class="w-asset">
      <div dangerouslySetInnerHTML=${{ __html: ed.env.renderHtml([{ type: 'asset', ref: b.ref }], { assetLinks: false }) }}></div>
      <div class="w-float"><button type="button" class="w-icon" title="Anderen Eintrag wählen" onClick=${e => ed.setState({ pop: { kind: 'asset', rect: e.currentTarget.getBoundingClientRect(), block: b, replace: true } })}><span class="ms">swap_horiz</span></button>
        <button type="button" class="w-icon" title="Entfernen" onClick=${() => ed.remove(b)}><span class="ms">delete</span></button></div></div>`;
    case 'hr': return html`<hr class="md-hr ed-hr" />`;
    case 'pagebreak': return html`<div class="md-pagebreak"><span>Seitenumbruch</span></div>`;
    default: return html`<div class="md-media-missing">Unbekannter Block</div>`;
  }
}

function BlockList({ list, ed }) {
  let n = 0;
  return html`<div class="ed-list">${list.map((b, i) => {
    if (b.type === 'number') n = i > 0 && list[i - 1].type === 'number' ? n + 1 : (b.start > 0 ? b.start : 1);
    return html`<${BlockRow} key=${b.id} b=${b} ed=${ed} num=${n} />`;
  })}</div>`;
}

// ---------- Popover ----------
function Pop({ rect, children, cls, onClose }) {
  const top = Math.min(rect.bottom + 6, window.innerHeight - 40);
  const flip = rect.bottom + 360 > window.innerHeight && rect.top > 380;
  const style = flip ? { left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)) + 'px', bottom: (window.innerHeight - rect.top + 6) + 'px' }
    : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)) + 'px', top: top + 'px' };
  return html`<div class="ed-pop-back" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}><div class=${'ed-pop ' + (cls || '')} style=${style} onMouseDown=${e => e.stopPropagation()}>${children}</div></div>`;
}

class AssetPicker extends Component {
  state = { q: '' };
  render({ assets, onPick }, { q }) {
    const t = q.trim().toLowerCase();
    const list = assets.filter(a => !t || [a.name, ...a.ips.map(i => i.address), a.data.cidr || ''].join(' ').toLowerCase().includes(t)).slice(0, 40);
    return html`<div class="ed-emoji">
      <input class="w-input" placeholder="Inventar durchsuchen (Name, IP) …" value=${q} autofocus onInput=${e => this.setState({ q: e.target.value })}
        onKeyDown=${e => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); onPick(list[0]); } }} />
      <div class="ed-synced-list">${list.map(a => html`<button type="button" class="menu-item" onClick=${() => onPick(a)}>
        <span class="ms">${ASSET_ICONS[a.kind] || 'inventory_2'}</span><span class="grow ell">${a.name}</span><span class="faint small mono">${a.kind === 'network' ? a.data.cidr || '' : a.ips.map(i => i.address)[0] || ''}</span></button>`)}
        ${!list.length && html`<div class="md-empty">${assets.length ? 'Kein Treffer.' : 'Noch kein Inventar erfasst (Seitenleiste → Inventar).'}</div>`}</div>
    </div>`;
  }
}

class EmojiPicker extends Component {
  state = { q: '' };
  render({ onPick }, { q }) {
    const found = searchEmoji(q);
    return html`<div class="ed-emoji">
      <input class="w-input" placeholder="Emoji suchen …" value=${q} autofocus onInput=${e => this.setState({ q: e.target.value })}
        onKeyDown=${e => { if (e.key === 'Enter' && found && found[0]) { e.preventDefault(); onPick(found[0].e); } }} />
      <div class="ed-emoji-scroll">
        ${found ? html`<div class="ed-emoji-grid">${found.map(it => html`<button type="button" title=${it.k} onClick=${() => onPick(it.e)}>${it.e}</button>`)}${!found.length && html`<div class="md-empty">Nichts gefunden.</div>`}</div>`
          : EMOJI_GROUPS.map(g => html`<div class="menu-label">${g.name.toUpperCase()}</div><div class="ed-emoji-grid">${g.items.map(it => html`<button type="button" title=${it.k} onClick=${() => onPick(it.e)}>${it.e}</button>`)}</div>`)}
      </div></div>`;
  }
}

class ValuePop extends Component {
  constructor(p) { super(p); this.state = { v: p.value || '', color: p.color || 'blue' }; }
  render({ kind, onDone, onRemove }, { v, color }) {
    const ok = () => onDone(kind === 'status' ? `${v.trim() || 'Status'}|${color}` : v);
    const key = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    return html`<div class="ed-vpop">
      ${kind === 'date' && html`<div class="menu-label">DATUM</div><input class="w-input" type="date" value=${v} autofocus onInput=${e => this.setState({ v: e.target.value })} onKeyDown=${key} />
        <div class="w-actions"><button type="button" class="w-btn" onClick=${() => onDone(today())}>Heute</button>${v && html`<span class="muted small">${fmtDay(v)}</span>`}</div>`}
      ${kind === 'time' && html`<div class="menu-label">UHRZEIT</div><input class="w-input" type="time" value=${v} autofocus onInput=${e => this.setState({ v: e.target.value })} onKeyDown=${key} />
        <div class="w-actions"><button type="button" class="w-btn" onClick=${() => onDone(now())}>Jetzt</button></div>`}
      ${kind === 'status' && html`<div class="menu-label">STATUS</div><input class="w-input" value=${v} placeholder="z. B. In Arbeit" autofocus maxlength="40" onInput=${e => this.setState({ v: e.target.value })} onKeyDown=${key} />
        <div class="ed-colors">${STATUS_COLORS.map(c => html`<button type="button" class=${'md-status c-' + c + (c === color ? ' sel' : '')} onClick=${() => this.setState({ color: c })}>${v || 'Status'}</button>`)}</div>`}
      ${kind === 'math' && html`<div class="menu-label">FORMEL (LaTeX)</div><input class="w-input mono" value=${v} placeholder="a^2 + b^2 = c^2" autofocus onInput=${e => this.setState({ v: e.target.value })} onKeyDown=${key} />
        <div class="ed-math-prev"><${TexPreview} tex=${v} /></div>`}
      ${kind === 'link' && html`<div class="menu-label">LINK</div><input class="w-input" value=${v} placeholder="https://… oder /doc/<id>" autofocus onInput=${e => this.setState({ v: e.target.value })} onKeyDown=${key} />`}
      <div class="w-actions end">
        ${onRemove && html`<button type="button" class="w-btn danger" onClick=${onRemove}><span class="ms">delete</span>Entfernen</button>`}
        <button type="button" class="btn btn-primary sm" onClick=${ok}>Übernehmen</button>
      </div></div>`;
  }
}

// ---------- Editor ----------
export class BlockEditor extends Component {
  constructor(props) {
    super(props);
    this.readOnly = !!props.readOnly;
    this.doc = this.load(props.value);
    this.els = new Map();
    this.tbs = new Map();
    this.undoStack = []; this.redoStack = [];
    this.lastKind = null; this.lastSnap = 0;
    this.synced = {}; // ref → { tree, saved }
    this.state = { v: 0, slash: null, link: null, pop: null, menu: null, tb: null, drop: null, active: null, diagram: null };
    this.rootRef = { current: null };
    this.lastEmitted = this.value();
  }
  get env() { return this.props.env; }
  load(md) {
    const d = parse(md || '');
    this.ensureTrailing(d);
    return d;
  }
  componentDidMount() {
    document.addEventListener('selectionchange', this.onSel);
    if (this.props.autofocus) this.focusEnd();
  }
  componentWillUnmount() {
    document.removeEventListener('selectionchange', this.onSel);
    clearTimeout(this.emitT);
    this.flush();
  }
  // Wird von außen ein neuer Stand gesetzt (z. B. Konflikt → neu laden)?
  componentDidUpdate(prev) {
    if (this.pendingFocus) this.applyFocus();
    if (prev.docKey !== this.props.docKey) {
      this.doc = this.load(this.props.value);
      this.undoStack = []; this.redoStack = [];
      this.synced = {};
      this.lastEmitted = this.value();
      this.rerender();
    }
  }
  focusEnd() {
    const ids = textOrder(this.doc);
    if (ids.length) this.focus(ids[ids.length - 1], 'end');
  }
  rerender() { this.setState({ v: this.state.v + 1 }); }
  register(id, el, tb) { if (el) { this.els.set(id, el); this.tbs.set(id, tb); } }
  unregister(id, el) { if (this.els.get(id) === el) { this.els.delete(id); this.tbs.delete(id); } }
  setActive(id) { if (this.state.active !== id) this.setState({ active: id }); }

  // ----- Änderungen, Verlauf, Ausgabe -----
  snapshot() { return JSON.stringify(this.doc); }
  pushUndo(kind) {
    this.undoStack.push({ doc: this.snapshot(), focus: this.focusInfo() });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
    this.lastSnap = Date.now();
  }
  beforeTyping() {
    if (this.lastKind !== 'typing' || Date.now() - this.lastSnap > 1200) this.pushUndo('typing');
    else this.lastSnap = Date.now();
  }
  mutate(fn, kind) {
    if (this.readOnly) return;
    if (kind === 'typing') this.beforeTyping(); else this.pushUndo(kind || 'op');
    fn();
    this.normalize();
    this.rerender();
    this.scheduleEmit();
  }
  focusInfo() {
    const id = this.state.active, el = id && this.els.get(id);
    return id && el && document.activeElement === el ? { id, off: caretOffset(el) } : null;
  }
  restore(entry) {
    this.doc = JSON.parse(entry.doc);
    this.rerender();
    this.scheduleEmit();
    if (entry.focus) this.focus(entry.focus.id, entry.focus.off);
  }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ doc: this.snapshot(), focus: this.focusInfo() });
    this.lastKind = null;
    this.restore(e);
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ doc: this.snapshot(), focus: this.focusInfo() });
    this.lastKind = null;
    this.restore(e);
  }
  ensureTrailing(list) {
    if (!list.length || !isText(list[list.length - 1]) || list[list.length - 1].type === 'toggle') list.push(newText());
  }
  normalize() {
    this.ensureTrailing(this.doc);
    const walk = list => list.forEach(b => {
      if (b.type === 'toggle') { if (!b.children || !b.children.length) b.children = [newText()]; walk(b.children); }
      if (b.type === 'columns') { b.cols = (b.cols || []).map(c => (c.length ? c : [newText()])); b.cols.forEach(walk); }
    });
    walk(this.doc);
    Object.values(this.synced).forEach(s => { if (!s.tree.length) s.tree.push(newText()); walk(s.tree); });
  }
  scheduleEmit() {
    clearTimeout(this.emitT);
    this.emitT = setTimeout(() => this.flush(), 200);
  }
  value() {
    // Abschließende leere Absätze nicht speichern
    const list = this.doc.slice();
    while (list.length && list[list.length - 1].type === 'p' && !list[list.length - 1].text) list.pop();
    return serialize(list);
  }
  flush() {
    clearTimeout(this.emitT);
    const md = this.value();
    if (md !== this.lastEmitted) { this.lastEmitted = md; if (this.props.onChange) this.props.onChange(md); }
    for (const [ref, s] of Object.entries(this.synced)) {
      const list = s.tree.slice();
      while (list.length && list[list.length - 1].type === 'p' && !list[list.length - 1].text) list.pop();
      const v = serialize(list);
      if (v !== s.saved) { s.saved = v; this.env.synced.save(ref, v); }
    }
  }
  onTextInput(b, e, el) {
    this.scheduleEmit();
    if (e.isComposing) return;
    // Slash-Menü
    if (this.state.slash) this.updateSlash();
    else if (e.inputType === 'insertText' && e.data === '/') this.maybeOpenSlash(b, el);
    if (this.state.link) this.updateLink();
    else if (e.inputType === 'insertText' && e.data === '[') this.maybeOpenLink(b, el);
    // Markdown-Kürzel am Zeilenanfang
    if (e.inputType === 'insertText' && e.data === ' ' && ['p', 'bullet', 'number'].includes(b.type)) this.shortcut(b, el);
    if (e.inputType === 'insertText' && e.data === '`' && b.type === 'p' && b.text === '\\`\\`\\`') {
      this.mutate(() => { Object.assign(b, { type: 'code', lang: '', text: '', _new: true }); }, 'op');
    }
    if (b.type === 'p' && /^(---|\\\*\\\*\\\*|___)$/.test(b.text || '')) {
      this.mutate(() => { const { arr, idx } = locate(this.root(b), b.id); arr.splice(idx, 1, { id: bid(), type: 'hr' }, newText()); this.focusLater(arr[idx + 1].id, 0); });
    }
  }
  root(b) { // Liste, in der der Block liegt (Dokument oder synchronisierter Block)
    if (locate(this.doc, b.id)) return this.doc;
    for (const s of Object.values(this.synced)) if (locate(s.tree, b.id)) return s.tree;
    return this.doc;
  }
  shortcut(b, el) {
    const t = el.textContent.replace(/ /g, ' ');
    const off = caretOffset(el);
    const rules = [
      [/^#\s$/, { type: 'h', level: 1 }], [/^##\s$/, { type: 'h', level: 2 }], [/^###\s$/, { type: 'h', level: 3 }], [/^####\s$/, { type: 'h', level: 4 }],
      [/^[-*+]\s$/, { type: 'bullet' }], [/^1[.)]\s$/, { type: 'number' }], [/^\[\s?\]\s$/, { type: 'todo', done: false }], [/^\[x\]\s$/i, { type: 'todo', done: true }],
      [/^>\s$/, { type: 'quote' }], [/^!\s$/, { type: 'callout', kind: 'note' }],
    ];
    for (const [re, to] of rules) {
      const m = t.slice(0, off).match(re);
      if (m && off === m[0].length) {
        if (b.type !== 'p' && !(to.type === 'todo' && b.type === 'bullet')) return;
        const rest = t.slice(off);
        this.mutate(() => {
          Object.assign(b, to);
          // Kürzel entfernen, restlichen Inhalt behalten
          const tmp = document.createElement('div');
          tmp.innerHTML = el.innerHTML;
          const r = document.createRange();
          r.setStart(tmp, 0);
          let left = m[0].length, node = null;
          const tw = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
          while ((node = tw.nextNode())) { if (node.data.length >= left) { r.setEnd(node, left); break; } left -= node.data.length; }
          r.deleteContents();
          b.text = rest ? domToMd(tmp) : '';
        });
        this.focusLater(b.id, 0);
        return;
      }
    }
  }

  // ----- Fokus -----
  focus(id, where) {
    requestAnimationFrame(() => {
      const el = this.els.get(id);
      if (!el) {
        const row = this.rootRef.current && this.rootRef.current.querySelector(`[data-row="${id}"]`);
        if (row) { row.scrollIntoView({ block: 'nearest' }); const f = row.querySelector('textarea, input:not([type=file])') || row.querySelector('button:not(.ed-g)'); if (f) f.focus(); }
        return;
      }
      const off = where === 'end' ? textLen(el) : where === 'start' || where === undefined ? 0 : where;
      setCaret(el, off);
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 40 || r.top < 60) el.scrollIntoView({ block: 'nearest' });
    });
  }
  // Fokus direkt nach dem nächsten Rendern setzen (vor dem nächsten Tastendruck)
  focusLater(id, where) {
    this.pendingFocus = [id, where];
    this.rerender();
    setTimeout(() => this.applyFocus(), 0);
  }
  applyFocus() {
    if (!this.pendingFocus) return;
    const [id, where] = this.pendingFocus;
    const el = this.els.get(id);
    if (!el) { this.pendingFocus = null; this.focus(id, where); return; }
    this.pendingFocus = null;
    setCaret(el, where === 'end' ? textLen(el) : where === 'start' || where === undefined ? 0 : where);
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 40 || r.top < 60) el.scrollIntoView({ block: 'nearest' });
  }
  neighbor(b, dir) {
    const ids = textOrder(this.root(b));
    const k = ids.indexOf(b.id);
    return ids[k + dir];
  }

  // ----- Tastatur -----
  onKey(b, e, el, tb) {
    const mod = e.metaKey || e.ctrlKey;
    if (this.state.link && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) { e.preventDefault(); this.linkKey(e.key); return; }
    if (this.state.slash) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) { e.preventDefault(); this.slashKey(e.key); return; }
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); tb.read(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (k === 'y') { e.preventDefault(); this.redo(); return; }
      if (k === 'b') { e.preventDefault(); this.fmt('bold'); return; }
      if (k === 'i') { e.preventDefault(); this.fmt('italic'); return; }
      if (k === 'e') { e.preventDefault(); this.fmt('code'); return; }
      // Strg+K: mit Markierung Link setzen, sonst Schnellsuche (globaler Kurzbefehl)
      if (k === 'k') { if (!getSelection().isCollapsed) { e.preventDefault(); this.fmt('link'); } return; }
      if (k === 'x' && e.shiftKey) { e.preventDefault(); this.fmt('strikeThrough'); return; }
      if (k === 's') { e.preventDefault(); this.flush(); if (this.props.onSave) this.props.onSave(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.enter(b, el, tb); return; }
    if (e.key === 'Enter' && e.shiftKey && b.type !== 'h') { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
    if (e.key === 'Backspace' && caretAtStart(el)) { if (this.backspace(b, el, tb)) e.preventDefault(); return; }
    if (e.key === 'Delete' && caretAtEnd(el)) { if (this.deleteForward(b, el, tb)) e.preventDefault(); return; }
    if (e.key === 'ArrowUp' && !e.shiftKey && caretOnFirstLine(el)) { const id = this.neighbor(b, -1); if (id) { e.preventDefault(); this.focus(id, 'end'); } return; }
    if (e.key === 'ArrowDown' && !e.shiftKey && caretOnLastLine(el)) { const id = this.neighbor(b, 1); if (id) { e.preventDefault(); this.focus(id, 'start'); } return; }
    if (e.key === 'ArrowLeft' && caretAtStart(el)) { const id = this.neighbor(b, -1); if (id) { e.preventDefault(); this.focus(id, 'end'); } return; }
    if (e.key === 'ArrowRight' && caretAtEnd(el)) { const id = this.neighbor(b, 1); if (id) { e.preventDefault(); this.focus(id, 'start'); } return; }
    if (e.key === 'Tab') { e.preventDefault(); const id = this.neighbor(b, e.shiftKey ? -1 : 1); if (id) this.focus(id, 'end'); }
    if (e.key === 'Escape') el.blur();
  }
  enter(b, el, tb) {
    tb.read();
    const root = this.root(b);
    const loc = locate(root, b.id);
    if (!loc) return;
    const empty = !b.text;
    // Leerer Listenpunkt/Zitat/Hinweis + Enter → normaler Absatz
    if (empty && ['bullet', 'number', 'todo', 'quote', 'callout', 'footnote'].includes(b.type)) {
      this.mutate(() => { b.type = 'p'; delete b.done; delete b.kind; });
      this.focusLater(b.id, 0);
      return;
    }
    // Leerer Absatz als letzter Block in einem Umschaltblock/einer Spalte → hinter den Container springen
    if (empty && b.type === 'p' && loc.parent && loc.parent.type === 'toggle' && loc.idx === loc.arr.length - 1 && loc.arr.length > 1) {
      this.mutate(() => {
        loc.arr.splice(loc.idx, 1);
        const outer = locate(root, loc.parent.id);
        const n = newText();
        outer.arr.splice(outer.idx + 1, 0, n);
        this.focusLater(n.id, 0);
      });
      return;
    }
    this.pushUndo('op');
    const tail = splitAtCaret(el);
    tb.read();
    let n;
    if (b.type === 'toggle') {
      n = newText('p', { text: tail });
      b._closed = false;
      (b.children || (b.children = [])).unshift(n);
    } else {
      const type = LISTY.includes(b.type) ? b.type : 'p';
      n = newText(type, { text: tail });
      if (type === 'todo') n.done = false;
      // Enter am Anfang eines nicht leeren Blocks: neuer Block davor
      if (!b.text && tail && b.type !== 'p') { n.type = b.type; }
      loc.arr.splice(loc.idx + 1, 0, n);
    }
    this.normalize();
    this.rerender();
    this.scheduleEmit();
    this.focusLater(n.id, 0);
  }
  backspace(b, el, tb) {
    tb.read();
    const root = this.root(b);
    const loc = locate(root, b.id);
    if (!loc) return false;
    if (b.type !== 'p' && b.type !== 'toggle') {
      this.mutate(() => { b.type = 'p'; delete b.done; delete b.kind; delete b.level; delete b.ref; });
      this.focusLater(b.id, 0);
      return true;
    }
    if (b.type === 'toggle') {
      if (b.text) return false;
      this.mutate(() => { loc.arr.splice(loc.idx, 1, ...(b.children || []).filter(c => !(c.type === 'p' && !c.text))); });
      const prev = this.neighbor(b, -1);
      if (prev) this.focusLater(prev, 'end');
      return true;
    }
    const prev = loc.idx > 0 ? loc.arr[loc.idx - 1] : null;
    if (prev && isText(prev) && prev.type !== 'toggle') {
      const prevEl = this.els.get(prev.id);
      const at = prevEl ? textLen(prevEl) : 0;
      this.mutate(() => {
        prev.text = (prev.text || '') + (b.text || '');
        loc.arr.splice(loc.idx, 1);
      });
      this.focusLater(prev.id, at);
      return true;
    }
    if (prev && !isText(prev)) {
      // Vorheriger Block ist ein Widget: leeren Absatz entfernen, sonst nichts tun
      if (!b.text) {
        this.mutate(() => loc.arr.splice(loc.idx, 1));
        const id = this.neighbor(b, -1);
        if (id) this.focusLater(id, 'end');
        return true;
      }
      return true;
    }
    if (!prev && !b.text && loc.arr.length > 1) {
      const nid = this.neighbor(b, -1) || this.neighbor(b, 1);
      this.mutate(() => loc.arr.splice(loc.idx, 1));
      if (nid) this.focusLater(nid, 'end');
      return true;
    }
    if (!prev) {
      const id = this.neighbor(b, -1);
      if (id && !b.text) { this.focus(id, 'end'); return true; }
    }
    return false;
  }
  deleteForward(b, el, tb) {
    tb.read();
    const loc = locate(this.root(b), b.id);
    const next = loc && loc.arr[loc.idx + 1];
    if (next && isText(next) && next.type !== 'toggle') {
      const at = textLen(el);
      this.mutate(() => { b.text = (b.text || '') + (next.text || ''); loc.arr.splice(loc.idx + 1, 1); });
      this.focusLater(b.id, at);
      return true;
    }
    return false;
  }

  // ----- Formatierung -----
  fmt(kind) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    if (kind === 'link') {
      const r = sel.getRangeAt(0).cloneRange();
      const rect = r.getBoundingClientRect();
      const a = r.startContainer.parentElement && r.startContainer.parentElement.closest('a');
      this.setState({ pop: { kind: 'link', rect, range: r, value: a ? a.getAttribute('href') : '', anchor: a } });
      return;
    }
    if (kind === 'code') {
      if (sel.isCollapsed) return;
      const r = sel.getRangeAt(0);
      const inCode = r.commonAncestorContainer.parentElement && r.commonAncestorContainer.parentElement.closest('code');
      if (inCode) { inCode.replaceWith(document.createTextNode(inCode.textContent)); this.syncActive(); return; }
      document.execCommand('insertHTML', false, `<code class="md-code">${esc(sel.toString())}</code>`);
      return;
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(kind);
  }
  syncActive() {
    const id = this.state.active;
    const el = id && this.els.get(id);
    if (!el) return;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatSetBlockTextDirection' }));
  }
  onSel = () => {
    if (this.readOnly) return;
    const sel = getSelection();
    const root = this.rootRef.current;
    if (!root || !sel.rangeCount || sel.isCollapsed) { if (this.state.tb) this.setState({ tb: null }); return; }
    const r = sel.getRangeAt(0);
    const host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    const ed = host && host.closest('.ed-text');
    if (!ed || !root.contains(ed)) { if (this.state.tb) this.setState({ tb: null }); return; }
    const rect = r.getBoundingClientRect();
    this.setState({ tb: { top: rect.top, left: rect.left + rect.width / 2 } });
  };

  // ----- Einfügen -----
  onPaste(b, e, el, tb) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files || []);
    if (files.length) {
      e.preventDefault();
      this.uploadFiles(files, b);
      return;
    }
    const text = cd.getData('text/plain');
    if (!text) { e.preventDefault(); return; }
    e.preventDefault();
    if (!/\n/.test(text.trim())) { document.execCommand('insertText', false, text.replace(/\r/g, '')); return; }
    tb.read();
    const blocks = parse(text);
    if (!blocks.length) return;
    const loc = locate(this.root(b), b.id);
    this.mutate(() => {
      if (b.type === 'p' && !b.text) loc.arr.splice(loc.idx, 1, ...blocks);
      else loc.arr.splice(loc.idx + 1, 0, ...blocks);
    });
    const last = blocks[blocks.length - 1];
    if (isText(last)) this.focusLater(last.id, 'end');
  }
  async uploadFiles(files, after) {
    for (const file of files.slice(0, 20)) {
      const type = /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : file.type === 'application/pdf' ? 'pdf' : 'file';
      const nb = { id: bid(), type, src: '', name: file.name, _uploading: true };
      this.insertBlocksAfter(after, [nb]);
      after = nb;
      try {
        const f = await this.env.upload(file);
        this.mutate(() => {
          nb.src = f.url; delete nb._uploading;
          if (type === 'image') { nb.alt = f.name.replace(/\.[a-z0-9]+$/i, ''); delete nb.name; } else nb.size = f.size;
        });
      } catch (err) {
        this.env.flash(err.message || 'Upload fehlgeschlagen', true);
        const loc = locate(this.root(nb), nb.id);
        if (loc) this.mutate(() => loc.arr.splice(loc.idx, 1));
      }
    }
  }
  insertBlocksAfter(b, blocks) {
    const loc = b && locate(this.root(b), b.id);
    this.mutate(() => {
      if (!loc) this.doc.splice(this.doc.length - (this.doc.length && this.doc[this.doc.length - 1].type === 'p' && !this.doc[this.doc.length - 1].text ? 1 : 0), 0, ...blocks);
      else if (loc.b.type === 'p' && !loc.b.text) loc.arr.splice(loc.idx, 1, ...blocks);
      else loc.arr.splice(loc.idx + 1, 0, ...blocks);
    });
  }
  onRootDrop = e => {
    if (this.readOnly || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const row = e.target.closest && e.target.closest('[data-row]');
    const loc = row && (locate(this.doc, row.dataset.row) || null);
    this.uploadFiles(Array.from(e.dataTransfer.files), loc ? loc.b : null);
  };

  // ----- Atome (Datum, Status, Mathe …) -----
  onTextClick(b, e, el) {
    const atom = e.target.closest && e.target.closest('.ed-atom');
    if (!atom || this.readOnly) return;
    const md = atom.dataset.md;
    let m;
    const rect = atom.getBoundingClientRect();
    if ((m = md.match(/^\{\{(date|time|status):(.*)\}\}$/))) {
      const st = m[1] === 'status' ? parseStatus(m[2]) : null;
      this.setState({ pop: { kind: m[1], rect, atom, block: b, value: st ? st.label : m[2], color: st ? st.color : undefined } });
    } else if ((m = md.match(/^\$(.*)\$$/s))) {
      this.setState({ pop: { kind: 'math', rect, atom, block: b, value: m[1] } });
    }
  }
  atomDone(value) {
    const p = this.state.pop;
    const md = p.kind === 'math' ? `$${value.trim()}$` : `{{${p.kind}:${value}}}`;
    this.setState({ pop: null });
    if (p.kind === 'link') return this.linkDone(value);
    if (p.kind === 'math' && !value.trim()) return;
    if (p.kind !== 'status' && !value) return;
    if (p.atom) {
      const tmp = document.createElement('div');
      tmp.innerHTML = toEditHtml(md);
      p.atom.replaceWith(tmp.firstChild);
      const el = this.els.get(p.block.id);
      if (el) hydrate(el);
      if (el) el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
      return;
    }
    this.insertInline(p, toEditHtml(md) + ' ', true);
  }
  atomRemove() {
    const p = this.state.pop;
    this.setState({ pop: null });
    if (!p || !p.atom) return;
    const el = this.els.get(p.block.id);
    p.atom.remove();
    if (el) el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }
  insertInline(p, content, isHtml) {
    const el = this.els.get(p.block.id);
    if (!el) return;
    el.focus();
    const sel = getSelection();
    if (p.offset !== undefined) setCaret(el, p.offset);
    else if (p.range && el.contains(p.range.startContainer)) { sel.removeAllRanges(); sel.addRange(p.range); }
    else setCaret(el, textLen(el));
    if (isHtml) document.execCommand('insertHTML', false, content);
    else document.execCommand('insertText', false, content);
    if (isHtml) hydrate(el);
  }
  linkDone(url) {
    const p = this.state.pop || {};
    const u = String(url || '').trim();
    const ok = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(u);
    const sel = getSelection();
    if (p.range) { sel.removeAllRanges(); sel.addRange(p.range); }
    if (!u) { document.execCommand('unlink'); return; }
    if (!ok) { this.env.flash('Bitte einen Link mit https://, mailto: oder /doc/… angeben.', true); return; }
    if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(u)}">${esc(u)}</a>`);
    else document.execCommand('createLink', false, u);
  }

  // ----- [[ Verlinkung -----
  maybeOpenLink(b, el) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer, off = r.startOffset;
    if (node.nodeType !== 3 || off < 2 || node.data.slice(off - 2, off) !== '[[') return;
    const rect = caretClientRect() || el.getBoundingClientRect();
    this.setState({ link: { block: b, node, offset: off - 2, query: '', sel: 0, rect } });
  }
  updateLink() {
    const l = this.state.link;
    const sel = getSelection();
    if (!sel.rangeCount) return this.setState({ link: null });
    const r = sel.getRangeAt(0);
    if (r.startContainer !== l.node || r.startOffset < l.offset + 2 || l.node.data.slice(l.offset, l.offset + 2) !== '[[') return this.setState({ link: null });
    const query = l.node.data.slice(l.offset + 2, r.startOffset);
    if (query.length > 60 || /[\]\n]/.test(query)) return this.setState({ link: null });
    this.setState({ link: { ...l, query, sel: 0 } });
  }
  linkItems() {
    const l = this.state.link;
    const q = String(l.query || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const n = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const docs = (this.env.docs ? this.env.docs() : []).filter(d => !q || n(d.title).includes(q));
    return docs.sort((a, b) => (n(b.title).startsWith(q) - n(a.title).startsWith(q)) || b.updated - a.updated).slice(0, 8);
  }
  linkKey(key) {
    const l = this.state.link;
    const items = this.linkItems();
    if (key === 'Escape') return this.setState({ link: null });
    if (key === 'ArrowDown') return this.setState({ link: { ...l, sel: Math.min(items.length - 1, l.sel + 1) } });
    if (key === 'ArrowUp') return this.setState({ link: { ...l, sel: Math.max(0, l.sel - 1) } });
    if (items[l.sel]) this.applyLink(items[l.sel]);
    else this.setState({ link: null });
  }
  applyLink(d) {
    const l = this.state.link;
    this.setState({ link: null });
    const el = this.els.get(l.block.id);
    if (!el || !l.node.isConnected) return;
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(l.node, l.offset);
    r.setEnd(l.node, Math.min(l.node.data.length, l.offset + 2 + l.query.length));
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('insertHTML', false, `<a href="/doc/${esc(d.id)}">${esc(d.title)}</a>&nbsp;`);
  }

  // ----- Slash-Menü -----
  maybeOpenSlash(b, el) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer, off = r.startOffset;
    if (node.nodeType !== 3 || off < 1 || node.data[off - 1] !== '/') return;
    const before = node.data[off - 2];
    if (before && !/\s| /.test(before)) return;
    const rect = caretClientRect() || el.getBoundingClientRect();
    this.setState({ slash: { block: b, node, offset: off - 1, query: '', sel: 0, rect } });
  }
  updateSlash() {
    const s = this.state.slash;
    const sel = getSelection();
    if (!sel.rangeCount) return this.setState({ slash: null });
    const r = sel.getRangeAt(0);
    if (r.startContainer !== s.node || r.startOffset <= s.offset || s.node.data[s.offset] !== '/') return this.setState({ slash: null });
    const query = s.node.data.slice(s.offset + 1, r.startOffset);
    if (query.length > 30 || /\s\s/.test(query)) return this.setState({ slash: null });
    const items = filterItems(query);
    if (!items.length && query.length > 3) return this.setState({ slash: null });
    this.setState({ slash: { ...s, query, sel: 0 } });
  }
  slashKey(key) {
    const s = this.state.slash;
    const items = filterItems(s.query);
    if (key === 'Escape') return this.setState({ slash: null });
    if (key === 'ArrowDown') return this.setState({ slash: { ...s, sel: (s.sel + 1) % Math.max(1, items.length) } }, () => this.scrollSlash());
    if (key === 'ArrowUp') return this.setState({ slash: { ...s, sel: (s.sel - 1 + items.length) % Math.max(1, items.length) } }, () => this.scrollSlash());
    if ((key === 'Enter' || key === 'Tab') && items[s.sel]) this.applySlash(items[s.sel]);
  }
  scrollSlash() { const el = document.querySelector('.ed-slash .menu-item.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  plus(b) {
    // Neuen Absatz unter dem Block anlegen und das Menü dort öffnen
    const root = this.root(b);
    const loc = locate(root, b.id);
    let target = b;
    if (!(b.type === 'p' && !b.text)) {
      target = newText();
      this.mutate(() => loc.arr.splice(loc.idx + 1, 0, target));
    }
    setTimeout(() => {
      const el = this.els.get(target.id);
      if (!el) return;
      setCaret(el, textLen(el));
      document.execCommand('insertText', false, '/');
    }, 30);
  }
  applySlash(item) {
    const s = this.state.slash;
    this.setState({ slash: null });
    const b = s.block;
    const el = this.els.get(b.id);
    // "/abfrage" aus dem Text entfernen
    let range = null, offset;
    if (el && s.node.isConnected) {
      const r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(s.node, Math.min(s.node.data.length, s.offset + 1 + s.query.length));
      r.deleteContents();
      range = r.cloneRange();
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      offset = caretOffset(el);
      const tb = this.tbs.get(b.id);
      if (tb) tb.read(); else b.text = domToMd(el);
    }
    this.runItem(item.key, b, range, offset);
  }
  runItem(key, b, range, offset) {
    const root = this.root(b);
    const loc = locate(root, b.id);
    if (!loc) return;
    const empty = !b.text;
    const rect = (range && range.getBoundingClientRect()) || (this.els.get(b.id) || document.body).getBoundingClientRect();
    // Inline-Elemente
    if (['date', 'time', 'status', 'emoji', 'mathinline'].includes(key)) {
      const kind = key === 'mathinline' ? 'math' : key;
      const today = new Date();
      const value = key === 'date' ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}` : key === 'time' ? `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}` : '';
      this.setState({ pop: { kind, rect, offset, block: b, value, color: 'blue' } });
      return;
    }
    if (key === 'footnote') {
      const used = new Set();
      const walk = l => l.forEach(x => { if (x.type === 'footnote') used.add(x.ref); childLists(x).forEach(walk); });
      walk(this.doc);
      let n = 1; while (used.has(String(n))) n++;
      this.insertInline({ block: b, offset }, toEditHtml(`[^${n}]`), true);
      const fn = { id: bid(), type: 'footnote', ref: String(n), text: '' };
      this.mutate(() => { this.doc.push(fn); });
      this.focusLater(fn.id, 0);
      return;
    }
    // Textblöcke: leeren Block umwandeln, sonst neuen darunter
    const textMap = { p: { type: 'p' }, h1: { type: 'h', level: 1 }, h2: { type: 'h', level: 2 }, h3: { type: 'h', level: 3 }, bullet: { type: 'bullet' }, number: { type: 'number' }, todo: { type: 'todo', done: false }, quote: { type: 'quote' }, callout: { type: 'callout', kind: 'note' } };
    if (textMap[key]) {
      if (empty || b.type === 'p') {
        this.mutate(() => { delete b.level; delete b.done; delete b.kind; Object.assign(b, textMap[key]); });
        this.focusLater(b.id, 'end');
      } else {
        const n = newText(textMap[key].type, { ...textMap[key] });
        this.mutate(() => loc.arr.splice(loc.idx + 1, 0, n));
        this.focusLater(n.id, 0);
      }
      return;
    }
    if (key === 'toggle') {
      const n = { id: bid(), type: 'toggle', text: empty ? '' : '', children: [newText()] };
      if (!empty) { this.mutate(() => { loc.arr.splice(loc.idx + 1, 0, n); }); }
      else this.mutate(() => { loc.arr.splice(loc.idx, 1, n); });
      this.focusLater(n.id, 0);
      return;
    }
    if (key === 'asset') {
      this.setState({ pop: { kind: 'asset', rect, block: b } });
      return;
    }
    if (key === 'synced') {
      this.setState({ pop: { kind: 'synced', rect, block: b } });
      return;
    }
    const make = () => {
      if (/^cols\d$/.test(key)) return { id: bid(), type: 'columns', cols: Array.from({ length: Number(key[4]) }, () => [newText()]) };
      if (key.startsWith('embed:')) return { id: bid(), type: 'embed', url: '', provider: key.slice(6) };
      switch (key) {
        case 'code': return { id: bid(), type: 'code', lang: 'bash', text: '', _new: true };
        case 'table': return { id: bid(), type: 'table', rows: [['Spalte 1', 'Spalte 2', 'Spalte 3'], ['', '', ''], ['', '', '']] };
        case 'hr': return { id: bid(), type: 'hr' };
        case 'pagebreak': return { id: bid(), type: 'pagebreak' };
        case 'image': case 'video': case 'audio': case 'pdf': case 'file': return { id: bid(), type: key, src: '' };
        case 'math': return { id: bid(), type: 'math', text: '', _new: true };
        case 'mermaid': return { id: bid(), type: 'mermaid', text: 'graph LR\n  A[Internet] --> B[Router]\n  B --> C[Server]', _new: true };
        case 'drawio': case 'excalidraw': return { id: bid(), type: key, src: '' };
        case 'subpages': return { id: bid(), type: 'subpages' };
        case 'kanban': return { id: bid(), type: 'kanban', data: { columns: [
          { id: bid(), title: 'Offen', color: 'gray', cards: [{ id: bid(), title: 'Erste Aufgabe', note: '' }] },
          { id: bid(), title: 'In Arbeit', color: 'blue', cards: [] },
          { id: bid(), title: 'Erledigt', color: 'green', cards: [] }] } };
        case 'base': {
          const c1 = bid(), c2 = bid(), c3 = bid();
          return { id: bid(), type: 'base', data: { title: '', columns: [
            { id: c1, name: 'Name', type: 'text', options: [] },
            { id: c2, name: 'Status', type: 'select', options: [{ label: 'Offen', color: 'gray' }, { label: 'In Arbeit', color: 'blue' }, { label: 'Fertig', color: 'green' }] },
            { id: c3, name: 'Datum', type: 'date', options: [] }], rows: [{ id: bid(), cells: {} }, { id: bid(), cells: {} }] } };
        }
        default: return null;
      }
    };
    const nb = make();
    if (!nb) return;
    this.mutate(() => {
      if (empty) loc.arr.splice(loc.idx, 1, nb);
      else loc.arr.splice(loc.idx + 1, 0, nb);
      if (nb.type === 'hr' || nb.type === 'pagebreak') {
        const k = loc.arr.indexOf(nb);
        if (!loc.arr[k + 1] || !isText(loc.arr[k + 1])) loc.arr.splice(k + 1, 0, newText());
      }
    });
    if (nb.type === 'columns') this.focusLater(nb.cols[0][0].id, 0);
    else if (nb.type === 'hr' || nb.type === 'pagebreak') { const l = locate(root, nb.id); if (l && l.arr[l.idx + 1]) this.focusLater(l.arr[l.idx + 1].id, 0); }
    else if (nb.type === 'drawio' || nb.type === 'excalidraw') { if (nb.type === 'excalidraw' || (this.env.meta || {}).drawioUrl) this.openDiagram(nb); }
    else this.focusLater(nb.id);
  }

  // ----- Synchronisierte Blöcke -----
  syncedTree(ref) {
    if (this.synced[ref]) return this.synced[ref].tree;
    const content = this.env.synced.get(ref);
    if (content === undefined) return undefined;
    const tree = parse(content);
    if (!tree.length) tree.push(newText());
    this.synced[ref] = { tree, saved: content, owner: null };
    return tree;
  }
  syncedOwner(ref) {
    // Erste Verwendung im Dokument ist bearbeitbar, weitere werden nur angezeigt.
    let owner = null;
    const walk = l => l.forEach(x => { if (!owner && x.type === 'synced' && x.ref === ref) owner = x.id; childLists(x).forEach(walk); });
    walk(this.doc);
    return owner;
  }
  async createSynced(fromBlock) {
    const p = this.state.pop;
    this.setState({ pop: null });
    try {
      const ref = await this.env.synced.create('');
      const loc = locate(this.root(p.block), p.block.id);
      const nb = { id: bid(), type: 'synced', ref };
      const first = newText();
      this.synced[ref] = { tree: [first], saved: '' };
      this.mutate(() => { if (!p.block.text) loc.arr.splice(loc.idx, 1, nb); else loc.arr.splice(loc.idx + 1, 0, nb); });
      this.focusLater(first.id, 0);
    } catch (e) { this.env.flash(e.message || 'Fehler', true); }
    return fromBlock;
  }
  pickAsset(a) {
    const p = this.state.pop;
    this.setState({ pop: null });
    if (p.replace) { this.mutate(() => { p.block.ref = a.id; }); return; }
    const loc = locate(this.root(p.block), p.block.id);
    const nb = { id: bid(), type: 'asset', ref: a.id };
    this.mutate(() => { if (!p.block.text) loc.arr.splice(loc.idx, 1, nb); else loc.arr.splice(loc.idx + 1, 0, nb); });
  }
  useSynced(ref) {
    const p = this.state.pop;
    this.setState({ pop: null });
    const loc = locate(this.root(p.block), p.block.id);
    const nb = { id: bid(), type: 'synced', ref };
    this.mutate(() => { if (!p.block.text) loc.arr.splice(loc.idx, 1, nb); else loc.arr.splice(loc.idx + 1, 0, nb); });
  }
  unsync(b) {
    const tree = this.syncedTree(b.ref) || [];
    const loc = locate(this.doc, b.id);
    if (!loc) return;
    this.mutate(() => loc.arr.splice(loc.idx, 1, ...tree.filter(x => !(x.type === 'p' && !x.text)).map(fresh)));
  }

  // ----- Block-Menü, Drag & Drop -----
  openMenu(b, e, mode) {
    const rect = e.currentTarget.getBoundingClientRect();
    this.setState({ menu: { id: b.id, rect, mode } });
  }
  menuAction(act, arg) {
    const m = this.state.menu;
    this.setState({ menu: null });
    const b = m && (locate(this.doc, m.id) || Object.values(this.synced).map(s => locate(s.tree, m.id)).find(Boolean));
    if (!b) return;
    const { arr, idx } = b;
    const blk = b.b;
    switch (act) {
      case 'delete': this.remove(blk); break;
      case 'duplicate': { const c = fresh(blk); if (c.type === 'synced') c.ref = blk.ref; this.mutate(() => arr.splice(idx + 1, 0, c)); break; }
      case 'up': if (idx > 0) this.mutate(() => { arr.splice(idx, 1); arr.splice(idx - 1, 0, blk); }); break;
      case 'down': if (idx < arr.length - 1) this.mutate(() => { arr.splice(idx, 1); arr.splice(idx + 1, 0, blk); }); break;
      case 'turn': {
        const map = { p: { type: 'p' }, h1: { type: 'h', level: 1 }, h2: { type: 'h', level: 2 }, h3: { type: 'h', level: 3 }, bullet: { type: 'bullet' }, number: { type: 'number' }, todo: { type: 'todo', done: false }, quote: { type: 'quote' }, callout: { type: 'callout', kind: 'note' }, toggle: { type: 'toggle' } };
        this.mutate(() => {
          if (blk.type === 'toggle' && arg !== 'toggle') { arr.splice(idx + 1, 0, ...(blk.children || []).filter(c => !(c.type === 'p' && !c.text))); delete blk.children; }
          delete blk.level; delete blk.done; delete blk.kind; delete blk._closed;
          Object.assign(blk, map[arg]);
          if (arg === 'toggle') blk.children = [newText()];
        });
        this.focusLater(blk.id, 'end');
        break;
      }
      case 'kind': this.mutate(() => { blk.kind = arg; }); break;
      case 'addcol': if ((blk.cols || []).length < 5) this.mutate(() => blk.cols.push([newText()])); break;
      case 'delcol': if ((blk.cols || []).length > 2) this.mutate(() => { const last = blk.cols.pop(); blk.cols[blk.cols.length - 1].push(...last.filter(x => !(x.type === 'p' && !x.text))); }); break;
      default:
    }
  }
  remove(blk) {
    const r = locate(this.root(blk), blk.id);
    if (!r) return;
    const prev = this.neighbor(blk, -1);
    this.mutate(() => r.arr.splice(r.idx, 1));
    if (prev) this.focusLater(prev, 'end');
  }
  onDragStart(b, e) {
    this.dragId = b.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-rackbook-block', b.id);
    const row = e.currentTarget.closest('.ed-row');
    if (row && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(row, 20, 14);
  }
  onDragEnd() { this.dragId = null; if (this.state.drop) this.setState({ drop: null }); }
  onRowDragOver(b, e) {
    if (!this.dragId || this.dragId === b.id) return;
    const dragged = locate(this.doc, this.dragId);
    if (dragged && contains(dragged.b, b.id)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (!this.state.drop || this.state.drop.id !== b.id || this.state.drop.pos !== pos) this.setState({ drop: { id: b.id, pos } });
  }
  onRowDrop(b, e) {
    if (!this.dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const drop = this.state.drop;
    const id = this.dragId;
    this.dragId = null;
    this.setState({ drop: null });
    if (!drop || id === b.id) return;
    const root = this.root(b);
    const src = locate(root, id);
    if (!src || contains(src.b, b.id)) return;
    this.mutate(() => {
      src.arr.splice(src.idx, 1);
      const dst = locate(root, b.id);
      dst.arr.splice(dst.idx + (drop.pos === 'after' ? 1 : 0), 0, src.b);
    });
  }
  openDiagram(b) { this.setState({ diagram: b }); }

  // ---------- Darstellung ----------
  render() {
    const s = this.state;
    const slashItems = s.slash ? filterItems(s.slash.query) : [];
    const menuBlock = s.menu && (locate(this.doc, s.menu.id) || Object.values(this.synced).map(x => locate(x.tree, s.menu.id)).find(Boolean));
    return html`
      <div class=${'ed-root md-body' + (this.readOnly ? ' ro' : '')} ref=${this.rootRef}
        onDragOver=${e => { if (!this.dragId && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); }}
        onDrop=${this.onRootDrop}>
        <${BlockList} list=${this.doc} ed=${this} />
        <div class="ed-tail" onClick=${() => this.focusEnd()}></div>
      </div>
      ${s.slash && html`
        <${Pop} rect=${s.slash.rect} cls="ed-slash" onClose=${() => this.setState({ slash: null })}>
          ${slashItems.length ? GROUPS.map(g => {
            const items = slashItems.filter(i => i.group === g);
            if (!items.length) return null;
            return html`<div class="menu-label">${g.toUpperCase()}</div>${items.map(it => {
              const k = slashItems.indexOf(it);
              return html`<button type="button" class=${'menu-item slash-item' + (k === s.slash.sel ? ' sel' : '')} onMouseDown=${e => e.preventDefault()}
                onMouseEnter=${() => { if (s.slash.sel !== k) this.setState({ slash: { ...s.slash, sel: k } }); }} onClick=${() => this.applySlash(it)}>
                <span class="slash-ic"><span class="ms">${it.icon}</span></span><span class="slash-tx"><span class="slash-l">${it.label}</span><span class="slash-d">${it.desc}</span></span></button>`;
            })}`;
          }) : html`<div class="md-empty slash-none">Kein Treffer für „${s.slash.query}“</div>`}
        <//>`}
      ${s.pop && s.pop.kind === 'emoji' && html`<${Pop} rect=${s.pop.rect} cls="ed-emoji-pop" onClose=${() => this.setState({ pop: null })}>
        <${EmojiPicker} onPick=${e => { const p = this.state.pop; this.setState({ pop: null }); this.insertInline(p, e, false); }} /><//>`}
      ${s.pop && ['date', 'time', 'status', 'math', 'link'].includes(s.pop.kind) && html`<${Pop} rect=${s.pop.rect} onClose=${() => this.setState({ pop: null })}>
        <${ValuePop} kind=${s.pop.kind} value=${s.pop.value} color=${s.pop.color} onDone=${v => this.atomDone(v)} onRemove=${s.pop.atom ? () => this.atomRemove() : (s.pop.kind === 'link' && s.pop.anchor ? () => { this.setState({ pop: null }); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(s.pop.range); document.execCommand('unlink'); } : null)} /><//>`}
      ${s.link && html`<${Pop} rect=${s.link.rect} cls="ed-slash ed-link" onClose=${() => this.setState({ link: null })}>
        <div class="menu-label">SEITE VERLINKEN${s.link.query ? ` – „${s.link.query}“` : ''}</div>
        ${this.linkItems().map((d, k) => html`<button type="button" class=${'menu-item slash-item' + (k === s.link.sel ? ' sel' : '')} onMouseDown=${e => e.preventDefault()}
          onMouseEnter=${() => { if (s.link.sel !== k) this.setState({ link: { ...s.link, sel: k } }); }} onClick=${() => this.applyLink(d)}>
          <span class="slash-ic"><span class="ms">description</span></span><span class="slash-tx"><span class="slash-l">${d.title}</span><span class="slash-d">${this.env.folderPath ? this.env.folderPath(d.folder) : ''}</span></span></button>`)}
        ${this.linkItems().length === 0 && html`<div class="md-empty slash-none">Keine Seite gefunden.</div>`}
      <//>`}
      ${s.pop && s.pop.kind === 'asset' && html`<${Pop} rect=${s.pop.rect} cls="ed-synced-pop" onClose=${() => this.setState({ pop: null })}>
        <${AssetPicker} assets=${this.env.assets ? this.env.assets() : []} onPick=${a => this.pickAsset(a)} />
      <//>`}
      ${s.pop && s.pop.kind === 'synced' && html`<${Pop} rect=${s.pop.rect} cls="ed-synced-pop" onClose=${() => this.setState({ pop: null })}>
        <button type="button" class="menu-item" onClick=${() => this.createSynced()}><span class="ms">add</span>Neuen synchronisierten Block erstellen</button>
        ${this.env.synced.all().length > 0 && html`<div class="menu-sep"></div><div class="menu-label">VORHANDENEN EINFÜGEN</div>
          <div class="ed-synced-list">${this.env.synced.all().map(x => html`<button type="button" class="menu-item" onClick=${() => this.useSynced(x.id)}>
            <span class="ms">sync</span><span class="grow ell">${x.preview || 'Leerer Block'}</span><span class="faint small">${x.uses}×</span></button>`)}</div>`}
      <//>`}
      ${s.menu && menuBlock && html`<${Pop} rect=${s.menu.rect} cls="ed-menu" onClose=${() => this.setState({ menu: null })}>
        ${s.menu.mode === 'callout' ? html`<div class="menu-label">ART</div>${Object.entries(CALLOUTS).map(([k, c]) => html`<button type="button" class=${'menu-item' + (menuBlock.b.kind === k ? ' sel' : '')} onClick=${() => this.menuAction('kind', k)}><span class="ms">${c.icon}</span>${c.label}</button>`)}` : html`
          ${isText(menuBlock.b) && menuBlock.b.type !== 'footnote' && html`<div class="menu-label">UMWANDELN IN</div>
            ${TURN_INTO.map(([k, l, i]) => html`<button type="button" class="menu-item" onClick=${() => this.menuAction('turn', k)}><span class="ms">${i}</span>${l}</button>`)}<div class="menu-sep"></div>`}
          ${menuBlock.b.type === 'callout' && html`<div class="menu-label">ART</div><div class="ed-kinds">${Object.entries(CALLOUTS).map(([k, c]) => html`<button type="button" class=${'w-icon' + (menuBlock.b.kind === k ? ' sel' : '')} title=${c.label} onClick=${() => this.menuAction('kind', k)}><span class="ms">${c.icon}</span></button>`)}</div><div class="menu-sep"></div>`}
          ${menuBlock.b.type === 'columns' && html`
            <button type="button" class="menu-item" disabled=${menuBlock.b.cols.length >= 5} onClick=${() => this.menuAction('addcol')}><span class="ms">view_column</span>Spalte hinzufügen</button>
            <button type="button" class="menu-item" disabled=${menuBlock.b.cols.length <= 2} onClick=${() => this.menuAction('delcol')}><span class="ms">view_agenda</span>Letzte Spalte entfernen</button><div class="menu-sep"></div>`}
          <button type="button" class="menu-item" onClick=${() => this.menuAction('duplicate')}><span class="ms">content_copy</span>Duplizieren</button>
          <button type="button" class="menu-item" onClick=${() => this.menuAction('up')}><span class="ms">arrow_upward</span>Nach oben</button>
          <button type="button" class="menu-item" onClick=${() => this.menuAction('down')}><span class="ms">arrow_downward</span>Nach unten</button>
          <button type="button" class="menu-item danger" onClick=${() => this.menuAction('delete')}><span class="ms">delete</span>Löschen</button>`}
      <//>`}
      ${s.tb && html`<div class="ed-toolbar" style=${{ top: Math.max(8, s.tb.top - 44) + 'px', left: s.tb.left + 'px' }} onMouseDown=${e => e.preventDefault()}>
        <button type="button" title="Fett (Strg+B)" onClick=${() => this.fmt('bold')}><span class="ms">format_bold</span></button>
        <button type="button" title="Kursiv (Strg+I)" onClick=${() => this.fmt('italic')}><span class="ms">format_italic</span></button>
        <button type="button" title="Durchgestrichen (Strg+Umschalt+X)" onClick=${() => this.fmt('strikeThrough')}><span class="ms">strikethrough_s</span></button>
        <button type="button" title="Inline-Code (Strg+E)" onClick=${() => this.fmt('code')}><span class="ms">code</span></button>
        <button type="button" title="Link (Strg+K)" onClick=${() => this.fmt('link')}><span class="ms">link</span></button>
      </div>`}
      ${s.diagram && html`<${DiagramModal} b=${s.diagram} ed=${this} drawioUrl=${(this.env.meta || {}).drawioUrl} onClose=${() => this.setState({ diagram: null })} />`}`;
  }
}

