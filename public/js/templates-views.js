// Vorlagen: Auswahl beim Anlegen eines Dokuments und Verwaltung in den Einstellungen
import { html, Component, useState } from '/vendor/preact-htm.js';
import { api } from './api.js';
import { Icon, stop } from './util.js';

// {{heute}} → Datums-Chip (wie auf dem Server)
export function applyPlaceholders(text) {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(text || '').replace(/\{\{heute\}\}/g, `{{date:${iso}}}`);
}

export class TemplatePicker extends Component {
  state = { q: '', sel: 0 };
  ref = { current: null };
  componentDidMount() { setTimeout(() => this.ref.current && this.ref.current.focus(), 0); }
  list() {
    const q = this.state.q.trim().toLowerCase();
    const all = [{ id: '', name: 'Leere Seite', description: 'Ohne Vorlage beginnen', icon: 'draft', builtin: true }, ...this.props.app.state.templates];
    return q ? all.filter(t => `${t.name} ${t.description}`.toLowerCase().includes(q)) : all;
  }
  pick(t) {
    const { app, folder, parent, onClose } = this.props;
    onClose();
    app.openEditor(null, folder, false, parent, t && t.id ? t : null);
  }
  render({ app, parent, onClose }, { q, sel }) {
    const list = this.list();
    const p = parent && app.doc(parent);
    return html`
      <div class="overlay" onMouseDown=${e => { if (e.target === e.currentTarget) onClose(); }}>
        <div class="modal wide tpl-modal" role="dialog" aria-modal="true" aria-label="Vorlage wählen" onClick=${stop}>
          <div class="modal-head"><h2 class="h2">${p ? `Neue Unterseite von „${p.title}“` : 'Neues Dokument'}</h2><button type="button" class="ms close-btn" aria-label="Schließen" onClick=${onClose}>close</button></div>
          <label class="search-box tpl-search"><span class="ms">search</span>
            <input ref=${this.ref} value=${q} placeholder="Vorlage suchen …" onInput=${e => this.setState({ q: e.target.value, sel: 0 })}
              onKeyDown=${e => {
                if (e.key === 'Enter') { e.preventDefault(); this.pick(list[sel]); }
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); this.setState({ sel: Math.min(list.length - 1, sel + 1) }); }
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); this.setState({ sel: Math.max(0, sel - 1) }); }
              }} /></label>
          <div class="tpl-grid">
            ${list.map((t, k) => html`
              <button type="button" class=${'tpl-card' + (k === sel ? ' sel' : '')} onClick=${() => this.pick(t)} onMouseEnter=${() => this.setState({ sel: k })}>
                <span class="tpl-ic"><span class="ms">${t.icon}</span></span>
                <span class="tpl-tx"><span class="tpl-n">${t.name}${!t.builtin && html`<span class="pill editor tpl-own">eigene</span>`}</span><span class="tpl-d">${t.description || '—'}</span></span>
              </button>`)}
            ${!list.length && html`<div class="md-empty">Keine passende Vorlage.</div>`}
          </div>
          <div class="hint">Eigene Vorlagen: im Dokument über <b>⋯ → Als Vorlage speichern</b> oder unter Einstellungen → Vorlagen.</div>
        </div>
      </div>`;
  }
}

function TemplateEditor({ app, tpl, onDone }) {
  const [f, setF] = useState({ name: tpl.name || '', description: tpl.description || '', icon: tpl.icon || 'description', title: tpl.title || '', tags: (tpl.tags || []).join(', '), content: tpl.content || '' });
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const save = async e => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, tags: f.tags };
      const r = tpl.id && !tpl.builtin ? await api('/templates/' + encodeURIComponent(tpl.id), { method: 'PUT', body }) : await api('/templates', { method: 'POST', body });
      await app.loadTemplates();
      app.flash('Vorlage gespeichert');
      onDone(r.template);
    } catch (x) { app.flash(x.message, null, true); }
    setBusy(false);
  };
  return html`
    <form class="tpl-form" onSubmit=${save}>
      <div class="tpl-form-row">
        <label class="field"><span>Name</span><input class="input" value=${f.name} onInput=${set('name')} required maxlength="80" /></label>
        <label class="field"><span>Icon (Material Symbols)</span><input class="input mono" value=${f.icon} onInput=${set('icon')} maxlength="40" /></label>
      </div>
      <label class="field"><span>Beschreibung</span><input class="input" value=${f.description} onInput=${set('description')} maxlength="200" /></label>
      <div class="tpl-form-row">
        <label class="field"><span>Titelvorschlag</span><input class="input" value=${f.title} onInput=${set('title')} maxlength="200" /></label>
        <label class="field"><span>Tags</span><input class="input" value=${f.tags} onInput=${set('tags')} placeholder="kommagetrennt" /></label>
      </div>
      <label class="field"><span>Inhalt (Markdown – <span class="mono">{{heute}}</span> wird zum aktuellen Datum)</span>
        <textarea class="input mono tpl-ta" value=${f.content} onInput=${set('content')} spellcheck="false"></textarea></label>
      <div class="btn-row"><button class="btn btn-primary md" disabled=${busy}>${tpl.builtin ? 'Als eigene Vorlage speichern' : 'Speichern'}</button>
        <button type="button" class="btn btn-ghost md" onClick=${() => onDone(null)}>Abbrechen</button></div>
    </form>`;
}

export function TemplatesPanel({ app }) {
  const [edit, setEdit] = useState(null);
  const list = app.state.templates;
  const me = app.state.user;
  const del = async t => {
    if (!confirm(`Vorlage „${t.name}“ löschen?`)) return;
    try { await api('/templates/' + encodeURIComponent(t.id), { method: 'DELETE' }); await app.loadTemplates(); app.flash('Vorlage gelöscht'); } catch (e) { app.flash(e.message, null, true); }
  };
  return html`
    <div class="panel" id="panel-templates">
      <div class="row-between"><div><h2 class="h2 s16">Vorlagen</h2><p class="desc">Vorlagen erscheinen beim Anlegen eines Dokuments. Mitgelieferte Vorlagen lassen sich als eigene Kopie anpassen.</p></div>
        ${!edit && html`<button type="button" class="btn btn-primary sm" onClick=${() => setEdit({})}><${Icon} name="add" />Neue Vorlage</button>`}</div>
      ${edit ? html`<${TemplateEditor} app=${app} tpl=${edit} onDone=${() => setEdit(null)} />` : html`
        <div class="list-plain">
          ${list.map(t => html`
            <div class="tpl-row">
              <span class="tpl-ic sm"><span class="ms">${t.icon}</span></span>
              <div class="grow"><div class="t">${t.name} ${t.builtin ? html`<span class="pill">mitgeliefert</span>` : html`<span class="pill editor">eigene</span>`}</div><div class="s">${t.description || '—'}${t.createdBy ? ` · von ${t.createdBy}` : ''}</div></div>
              <button type="button" class="btn btn-ghost sm" onClick=${() => setEdit(t.builtin ? { ...t, id: null, builtin: true, name: t.name + ' (Kopie)' } : t)}>${t.builtin ? 'Anpassen' : 'Bearbeiten'}</button>
              ${!t.builtin && (me.role === 'admin' || t.createdById === me.id) && html`<button type="button" class="btn btn-ghost sm" onClick=${() => del(t)}>Löschen</button>`}
            </div>`)}
        </div>`}
    </div>`;
}
