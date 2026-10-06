// Dokument bearbeiten (Block-Editor mit automatischem Speichern) und Lese-Darstellung mit Anreicherung.
import { html, Component } from '/vendor/preact-htm.js';
import { api, getCsrf, ApiError } from './api.js';
import { renderMd, plain } from './md.js';
import { hydrate, baseSortClick } from './hydrate.js';
import { BlockEditor } from './editor/editor.js';
import { fmtDate, wordsOf, fmtWords, initials } from './util.js';

// Gerendertes Markdown (Lesen): Mathe/Mermaid nachladen, Datenbanken sortierbar
export class MdView extends Component {
  ref = { current: null };
  componentDidMount() { hydrate(this.ref.current); }
  componentDidUpdate(prev) { if (prev.html !== this.props.html) hydrate(this.ref.current); }
  shouldComponentUpdate(np) { return np.html !== this.props.html; }
  render({ html: h, onClick, onKeyDown, cls }) {
    return html`<div class=${'md-body ' + (cls || '')} ref=${this.ref} onClick=${e => { if (baseSortClick(e)) return; if (onClick) onClick(e); }}
      onKeyDown=${e => { if ((e.key === 'Enter' || e.key === ' ') && baseSortClick(e)) { e.preventDefault(); return; } if (onKeyDown) onKeyDown(e); }}
      dangerouslySetInnerHTML=${{ __html: h }}></div>`;
  }
}

// Datei hochladen (Rohdaten, CSRF-Header)
export async function uploadFile(file, docId) {
  const qs = new URLSearchParams({ name: file.name || 'datei' });
  if (docId) qs.set('doc', docId);
  let res;
  try {
    res = await fetch('/api/files?' + qs, {
      method: 'POST', body: file, credentials: 'same-origin',
      headers: { 'Content-Type': file.type && file.type !== 'application/json' ? file.type : 'application/octet-stream', 'X-CSRF-Token': getCsrf() || '', Accept: 'application/json' },
    });
  } catch { throw new ApiError(0, { error: 'Server nicht erreichbar.' }); }
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data.file;
}

// Umgebung für den Editor (Uploads, synchronisierte Blöcke, Unterseiten …)
export function editorEnv(app, getDocId) {
  return {
    get meta() { return app.state.meta.editor || {}; },
    upload: file => uploadFile(file, getDocId()),
    mediaUrl: src => src,
    renderHtml: blocks => renderMd(blocks, app.renderCtx(getDocId())).html,
    subpages: () => (getDocId() ? app.docChildren(getDocId()) : []),
    newSubpage: () => { const id = getDocId(); if (id) app.openEditor(null, null, false, id); },
    flash: (m, err) => app.flash(m, null, err),
    synced: {
      get: ref => (app.state.synced[ref] ? app.state.synced[ref].content : undefined),
      all: () => Object.values(app.state.synced).map(x => ({ id: x.id, preview: plain((x.content || '').split('\n').find(l => l.trim()) || '').slice(0, 60), uses: app.syncedUsage(x.id) })),
      usage: ref => app.syncedUsage(ref),
      create: async content => { const r = await api('/synced', { method: 'POST', body: { content } }); app.setSynced(r.block); return r.block.id; },
      save: (ref, content) => app.saveSynced(ref, content),
    },
  };
}

export class DocEditor extends Component {
  constructor(props) {
    super(props);
    const d = props.doc;
    const p = props.parent && props.app.doc(props.parent);
    const firstFolder = props.app.state.folders[0] ? props.app.state.folders[0].id : '';
    this.state = d
      ? { id: d.id, version: d.version, title: d.title, folder: d.folder, parent: d.parent || '', tags: d.tags.join(', '), content: d.content, status: 'saved', key: 1, raw: false, conflict: null }
      : { id: null, version: 0, title: '', folder: p ? p.folder : (props.folder && props.app.state.folders.some(f => f.id === props.folder) ? props.folder : firstFolder), parent: p ? p.id : '', tags: p ? p.tags.join(', ') : '', content: '', status: 'saved', key: 1, raw: false, conflict: null };
    this.env = editorEnv(props.app, () => this.state.id);
    this.titleRef = { current: null };
    this.edRef = { current: null };
  }
  componentDidMount() {
    this.props.app.docEditor = this;
    if (!this.state.id && this.titleRef.current) this.titleRef.current.focus();
  }
  componentWillUnmount() {
    if (this.props.app.docEditor === this) this.props.app.docEditor = null;
    clearTimeout(this.t);
    if (this.edRef.current) this.edRef.current.flush();
    if (this.state.status === 'dirty') this.save();
  }
  isPending() { return this.state.status === 'dirty' || this.state.status === 'saving' || this.state.status === 'error'; }
  async flushNow() {
    if (this.edRef.current) this.edRef.current.flush();
    clearTimeout(this.t);
    if (this.state.status === 'dirty' || this.state.status === 'error') await this.save();
    while (this.state.status === 'saving') await new Promise(r => setTimeout(r, 50));
    return this.state.status === 'saved';
  }
  set(patch) {
    this.setState({ ...patch, status: this.state.status === 'conflict' ? 'conflict' : 'dirty' });
    clearTimeout(this.t);
    this.t = setTimeout(() => this.save(), 900);
  }
  async save(force) {
    const s = this.state;
    if (s.status === 'conflict' && !force) return;
    if (this.saving) { this.again = true; return; }
    if (!s.id && !s.title.trim() && !s.content.trim()) { this.setState({ status: 'saved' }); return; }
    this.saving = true;
    this.setState({ status: 'saving' });
    const body = { title: s.title || 'Unbenanntes Dokument', folder: s.folder, parent: s.parent || '', tags: s.tags, content: s.content };
    const { app } = this.props;
    try {
      let r;
      if (s.id) r = await api('/docs/' + encodeURIComponent(s.id), { method: 'PUT', body: { ...body, version: force ? undefined : s.version, autosave: true } });
      else {
        r = await api('/docs', { method: 'POST', body });
        history.replaceState(null, '', `/doc/${encodeURIComponent(r.doc.id)}/edit`);
        app.setState({ docId: r.doc.id });
      }
      const moved = s.id && (app.doc(s.id) || {}).folder !== r.doc.folder;
      app.upsertDoc(r.doc);
      if (moved) app.refresh();
      this.saving = false;
      // Während des Speicherns weitergetippt? Dann bleibt der Stand „ungespeichert“.
      const changed = this.state.title !== s.title || this.state.content !== s.content || this.state.tags !== s.tags || this.state.folder !== s.folder || this.state.parent !== s.parent;
      this.setState({ id: r.doc.id, version: r.doc.version, status: changed ? 'dirty' : 'saved', conflict: null, folder: r.doc.folder, parent: r.doc.parent || '' });
      if (changed || this.again) { this.again = false; clearTimeout(this.t); this.t = setTimeout(() => this.save(), 300); }
    } catch (e) {
      this.saving = false;
      if (e.status === 409 && e.data && e.data.doc) { this.setState({ status: 'conflict', conflict: e.data.doc }); app.upsertDoc(e.data.doc); return; }
      this.setState({ status: 'error' });
      app.fail(e);
    }
  }
  takeTheirs() {
    const o = this.state.conflict;
    this.setState({ title: o.title, folder: o.folder, parent: o.parent || '', tags: o.tags.join(', '), content: o.content, version: o.version, status: 'saved', conflict: null, key: this.state.key + 1 });
  }
  keepMine() { this.setState({ status: 'dirty', conflict: null }, () => this.save(true)); }
  toggleRaw() {
    if (this.edRef.current) this.edRef.current.flush();
    this.setState({ raw: !this.state.raw, key: this.state.key + 1 });
  }
  render({ app }, s) {
    const statusLabel = { saved: s.id ? 'Gespeichert' : 'Entwurf', dirty: 'Ungespeichert …', saving: 'Speichert …', error: 'Nicht gespeichert', conflict: 'Konflikt' }[s.status];
    const doc = s.id && app.doc(s.id);
    return html`
      <div class="doc-edit">
        ${s.conflict && html`
          <div class="banner warn"><span class="ms">warning</span>
            <div class="grow">„${s.conflict.title}“ wurde inzwischen von ${s.conflict.updatedBy || 'jemand anderem'} geändert (${fmtDate(s.conflict.updated)}).</div>
            <button type="button" class="btn btn-ghost sm" onClick=${() => this.takeTheirs()}>Deren Version laden</button>
            <button type="button" class="btn btn-primary sm" onClick=${() => this.keepMine()}>Meine Version speichern</button>
          </div>`}
        <textarea ref=${this.titleRef} class="title-edit" rows="1" value=${s.title} placeholder="Neue Seite" maxlength="200" aria-label="Titel"
          onInput=${e => { this.set({ title: e.target.value.replace(/\n/g, ' ') }); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
          onKeyDown=${e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); const first = document.querySelector('.ed-root .ed-text'); if (first) first.focus(); } }}></textarea>
        <div class="doc-byline">
          <span class="avatar xs">${initials((doc && doc.createdBy) || app.state.user.displayName)}</span>
          <span>Von ${(doc && doc.createdBy) || app.state.user.displayName}</span>
          <span class=${'save-state s-' + s.status}><span class="ms">${s.status === 'saved' ? 'cloud_done' : s.status === 'saving' ? 'cloud_sync' : s.status === 'dirty' ? 'edit' : 'cloud_off'}</span>${statusLabel}</span>
          <span class="faint">${fmtWords(wordsOf(plain(s.content)))}</span>
        </div>
        <div class="doc-props">
          <label class="field-chip" title=${s.parent ? 'Unterseiten liegen im Ordner ihrer Elternseite' : 'Ordner'}><span class="ms">folder</span>
            <select value=${s.folder} disabled=${!!s.parent} aria-label="Ordner" onChange=${e => {
              const folder = e.target.value;
              const p = s.parent && app.doc(s.parent);
              this.set({ folder, parent: p && p.folder === folder ? s.parent : '' });
            }}>
              ${app.folderTreeList().map(({ f, depth }) => html`<option value=${f.id}>${'   '.repeat(depth)}${depth ? '└ ' : ''}${f.name}</option>`)}
            </select>
          </label>
          <label class="field-chip"><span class="ms">account_tree</span>
            <select value=${s.parent || ''} aria-label="Übergeordnete Seite" onChange=${e => {
              const parent = e.target.value;
              const p = parent && app.doc(parent);
              this.set({ parent, folder: p ? p.folder : s.folder });
            }}>
              <option value="">Oberste Ebene (keine Elternseite)</option>
              ${app.docTreeList(s.folder, s.id ? [s.id, ...app.docDescendantIds(s.id)] : []).map(({ d: x, depth }) => html`<option value=${x.id}>${'   '.repeat(depth)}${depth ? '└ ' : ''}Unterseite von: ${x.title}</option>`)}
            </select>
          </label>
          <label class="field-chip tags"><span class="ms">sell</span>
            <input value=${s.tags} placeholder="Tags, kommagetrennt" aria-label="Tags" onInput=${e => this.set({ tags: e.target.value })} />
          </label>
          <button type="button" class=${'field-chip btn-chip' + (s.raw ? ' on' : '')} title="Markdown-Quelltext bearbeiten" onClick=${() => this.toggleRaw()}><span class="ms">code</span>Markdown</button>
        </div>
        <div class="article editor-article">
          ${s.raw
            ? html`<textarea class="editor-ta raw" value=${s.content} spellcheck="false" aria-label="Inhalt (Markdown)" placeholder="Markdown …"
                onInput=${e => this.set({ content: e.target.value })}
                onKeyDown=${e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.flushNow(); } }}></textarea>`
            : html`<${BlockEditor} ref=${this.edRef} key=${'k' + s.key} docKey=${s.key} value=${s.content} env=${this.env}
                onChange=${content => this.set({ content })} onSave=${() => this.flushNow()} />`}
        </div>
      </div>`;
  }
}
