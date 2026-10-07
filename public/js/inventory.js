// Inventar: Hosts, VMs, Container, Geräte, Dienste und Netzwerke mit IP-Belegung
import { html, Component } from '/vendor/preact-htm.js';
import { api } from './api.js';
import { ASSET_KINDS, ASSET_ICONS, ASSET_STATUS } from './md.js';
import { fmtDate } from './util.js';
import { applyPlaceholders } from './templates-views.js';

const FIELD_LABELS = {
  description: 'Beschreibung', os: 'Betriebssystem', hardware: 'Hardware / Ressourcen', vendor: 'Hersteller', model: 'Modell', serial: 'Seriennummer',
  location: 'Standort', url: 'URL', ports: 'Ports', cidr: 'Netz (CIDR)', vlan: 'VLAN', gateway: 'Gateway', dhcp: 'DHCP-Bereich', dns: 'DNS-Server', notes: 'Notizen',
};
const FIELD_PH = {
  description: 'Wofür wird der Eintrag genutzt?', os: 'z. B. Debian 13', hardware: 'z. B. 4 vCPU, 8 GB RAM, 64 GB', location: 'z. B. Rack 1 / HE 12', url: 'https://…',
  ports: 'z. B. 443/tcp, 8006/tcp', cidr: '10.0.20.0/24', vlan: '20', gateway: '10.0.20.1', dhcp: '10.0.20.100-10.0.20.199', dns: '10.0.20.53', notes: 'Keine Passwörter – Verweis auf den Passwortmanager',
};
const FIELDS_BY_KIND = {
  network: ['description', 'cidr', 'vlan', 'gateway', 'dhcp', 'dns', 'location', 'notes'],
  host: ['description', 'os', 'hardware', 'vendor', 'model', 'serial', 'location', 'url', 'ports', 'notes'],
  device: ['description', 'vendor', 'model', 'serial', 'os', 'location', 'url', 'ports', 'notes'],
  default: ['description', 'os', 'hardware', 'location', 'url', 'ports', 'notes'],
};
const TEMPLATE_FOR = { host: 'builtin-host', vm: 'builtin-host', device: 'builtin-host', container: 'builtin-dienst', service: 'builtin-dienst', network: 'builtin-netzwerk' };
const kindIcon = k => ASSET_ICONS[k] || 'inventory_2';
const statusPill = s => { const v = ASSET_STATUS[s] || ASSET_STATUS.active; return html`<span class=${'md-status c-' + v[1]}>${v[0]}</span>`; };

function descendants(list, id) {
  const out = new Set();
  const walk = p => list.filter(a => a.parent === p).forEach(a => { if (!out.has(a.id)) { out.add(a.id); walk(a.id); } });
  walk(id);
  return out;
}

export class InventoryPage extends Component {
  state = { q: '', kind: '', overview: null, form: null, formFor: null, busy: false };
  componentDidMount() { this.loadOverview(); }
  async loadOverview() {
    try { this.setState({ overview: await api('/assets/ip-overview') }); } catch { /* still */ }
  }
  async reload() {
    await this.props.app.loadAssets();
    this.loadOverview();
  }
  render({ app }) {
    const s = app.state;
    if (s.assetId) return this.renderDetail(s.assetId === 'new' ? null : s.assets.find(a => a.id === s.assetId), s.assetId === 'new');
    const tab = s.invTab === 'ips' ? 'ips' : 'list';
    const conflicts = this.state.overview ? this.state.overview.conflicts : [];
    return html`
      <div class="page g18" data-screen-label="Inventar">
        <div class="page-head">
          <div><h1 class="h1">Inventar</h1><p class="sub">Hosts, VMs, Container, Geräte, Dienste und Netzwerke – strukturiert und mit Dokumentation verknüpft.</p></div>
          <div class="row g8">${app.headIcons()}
            ${app.canEdit() && html`<button type="button" class="btn btn-primary" onClick=${() => app.go('inventory', { assetId: 'new', newAssetParent: null, newKind: null })}><span class="ms">add</span>Neuer Eintrag</button>`}</div>
        </div>
        ${conflicts.length > 0 && html`<div class="banner warn"><span class="ms">warning</span><div class="grow"><b>Doppelt vergebene IP-Adressen:</b> ${conflicts.map(c => html`<span class="inv-conf"><code class="md-code">${c.address}</code> ${c.assets.map((a, k) => html`${k ? ', ' : ''}<button type="button" class="link-acc" onClick=${() => app.go('inventory', { assetId: a.id })}>${a.name}</button>`)}</span>`)}</div></div>`}
        <div class="tabs">
          <button type="button" class=${tab === 'list' ? 'on' : ''} onClick=${() => app.go('inventory', { assetId: null, invTab: 'list' })}>Einträge (${s.assets.length})</button>
          <button type="button" class=${tab === 'ips' ? 'on' : ''} onClick=${() => app.go('inventory', { assetId: null, invTab: 'ips' })}>IP-Belegung</button>
        </div>
        ${tab === 'list' ? this.renderList() : this.renderIps()}
      </div>`;
  }

  // ---------- Liste ----------
  renderList() {
    const { app } = this.props;
    const all = app.state.assets;
    const { q, kind } = this.state;
    const t = q.trim().toLowerCase();
    const match = a => (!kind || a.kind === kind) && (!t || [a.name, ...a.ips.map(i => i.address), ...a.tags, ...Object.values(a.data)].join(' ').toLowerCase().includes(t));
    const ids = new Set(all.map(a => a.id));
    const rows = [];
    // Baum: Einträge ohne (bekannten) übergeordneten Eintrag oben, Untereinträge eingerückt
    const visible = new Set(all.filter(match).map(a => a.id));
    // Vorfahren von Treffern mit anzeigen, damit die Struktur erhalten bleibt
    for (const id of [...visible]) { let p = all.find(a => a.id === id).parent, g = 0; while (p && ids.has(p) && g++ < 10) { visible.add(p); p = all.find(a => a.id === p).parent; } }
    const walk = (parent, depth) => all.filter(a => (a.parent && ids.has(a.parent) ? a.parent : null) === parent && visible.has(a.id))
      .sort((a, b) => (a.kind === 'network') - (b.kind === 'network') || a.name.localeCompare(b.name, 'de', { numeric: true }))
      .forEach(a => { rows.push({ a, depth, dim: !match(a) }); walk(a.id, depth + 1); });
    walk(null, 0);
    const counts = Object.fromEntries(Object.keys(ASSET_KINDS).map(k => [k, all.filter(a => a.kind === k).length]));
    const docTitle = id => (app.doc(id) || {}).title;
    return html`
      <div class="inv-tools">
        <label class="search-box inv-search"><span class="ms">search</span><input value=${q} placeholder="Name, IP, Tag, Betriebssystem …" onInput=${e => this.setState({ q: e.target.value })} /></label>
        <div class="chips">
          <button type="button" class=${'chip' + (!kind ? ' on' : '')} onClick=${() => this.setState({ kind: '' })}>Alle</button>
          ${Object.entries(ASSET_KINDS).filter(([k]) => counts[k]).map(([k, l]) => html`<button type="button" class=${'chip' + (kind === k ? ' on' : '')} onClick=${() => this.setState({ kind: kind === k ? '' : k })}><span class="ms">${kindIcon(k)}</span>${l} <span class="faint">${counts[k]}</span></button>`)}
        </div>
      </div>
      ${all.length === 0 ? html`
        <div class="card empty-big"><div class="t">Noch kein Inventar</div>
          <div class="s">Lege Netzwerke, Server, VMs, Container und Geräte an – mit IPs, Hardware und „läuft auf“. Daraus entsteht automatisch die IP-Belegung.</div>
          ${app.canEdit() && html`<div class="btn-row center"><button type="button" class="btn btn-primary md" onClick=${() => app.go('inventory', { assetId: 'new', newKind: 'network', newAssetParent: null })}><span class="ms">lan</span>Netzwerk anlegen</button>
            <button type="button" class="btn btn-ghost md" onClick=${() => app.go('inventory', { assetId: 'new', newKind: 'host', newAssetParent: null })}><span class="ms">dns</span>Server anlegen</button></div>`}
        </div>` : html`
        <div class="card inv-table">
          <div class="inv-head"><span>Name</span><span>Typ</span><span>IP / Netz</span><span>Status</span><span>Dokumentation</span></div>
          ${rows.map(({ a, depth, dim }) => html`
            <button type="button" class=${'inv-row' + (dim ? ' dim' : '')} onClick=${() => app.go('inventory', { assetId: a.id })}>
              <span class="inv-name" style=${{ paddingLeft: (depth * 20) + 'px' }}>${depth > 0 && html`<span class="inv-branch">└</span>`}<span class="ms">${kindIcon(a.kind)}</span><span class="ell">${a.name}</span>${a.tags.slice(0, 3).map(t => html`<span class="tag-chip sm">#${t}</span>`)}</span>
              <span class="inv-kind">${ASSET_KINDS[a.kind]}</span>
              <span class="inv-ips mono">${a.kind === 'network' ? [a.data.cidr, a.data.vlan && 'VLAN ' + a.data.vlan].filter(Boolean).join(' · ') : a.ips.map(i => i.address).join(', ')}</span>
              <span>${statusPill(a.status)}</span>
              <span class="inv-doc">${a.doc && docTitle(a.doc) ? html`<span class="ms">description</span><span class="ell">${docTitle(a.doc)}</span>` : html`<span class="faint">–</span>`}</span>
            </button>`)}
          ${rows.length === 0 && html`<div class="table-empty"><div class="t">Keine Treffer</div></div>`}
        </div>`}`;
  }

  // ---------- IP-Belegung ----------
  renderIps() {
    const { app } = this.props;
    const o = this.state.overview;
    if (!o) return html`<div class="md-empty">Wird geladen …</div>`;
    const copy = ip => { if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(ip).then(() => app.flash(`${ip} kopiert`)); };
    return html`
      ${o.networks.length === 0 && html`<div class="card empty-big"><div class="t">Noch keine Netzwerke erfasst</div><div class="s">Lege ein Netzwerk mit Adressbereich (z. B. 10.0.20.0/24) an – dann siehst du hier Belegung, freie Adressen und Doppelvergaben.</div>
        ${app.canEdit() && html`<div class="btn-row center"><button type="button" class="btn btn-primary md" onClick=${() => app.go('inventory', { assetId: 'new', newKind: 'network', newAssetParent: null })}><span class="ms">lan</span>Netzwerk anlegen</button></div>`}</div>`}
      <div class="inv-nets">
        ${o.networks.map(n => {
          const pct = n.usable ? Math.round(((n.used + n.reserved) / n.usable) * 100) : 0;
          return html`
            <div class="card inv-net">
              <div class="row-between"><button type="button" class="inv-net-t" onClick=${() => app.go('inventory', { assetId: n.id })}><span class="ms">lan</span>${n.name}</button>
                <span class="mono small">${n.cidr}${n.vlan ? ` · VLAN ${n.vlan}` : ''}</span></div>
              <div class="inv-bar" title=${`${n.used} belegt, ${n.reserved} reserviert, ${n.available} frei`}><div class=${'inv-bar-f' + (pct > 85 ? ' hot' : '')} style=${{ width: Math.min(100, pct) + '%' }}></div></div>
              <div class="small muted">${n.used} belegt · ${n.available} frei von ${n.usable}${n.gateway ? ` · Gateway ${n.gateway}` : ''}${n.dhcp ? ` · DHCP ${n.dhcp}` : ''}</div>
              ${n.nextFree.length > 0 && html`<div class="inv-free"><span class="small muted">Nächste freie:</span>${n.nextFree.slice(0, 6).map(ip => html`<button type="button" class="tag-chip mono" title="Kopieren" onClick=${() => copy(ip)}>${ip}</button>`)}</div>`}
              <div class="inv-addrs">
                ${n.addresses.map(u => html`<button type="button" class=${'inv-addr' + (o.conflicts.some(c => c.address === u.address) ? ' conflict' : '')} onClick=${() => app.go('inventory', { assetId: u.asset })}>
                  <span class="mono">${u.address}</span><span class="ms">${kindIcon(u.kind)}</span><span class="ell">${u.name}</span>${u.note && html`<span class="faint ell">${u.note}</span>`}</button>`)}
                ${n.addresses.length === 0 && html`<div class="md-empty">Noch keine Adressen vergeben.</div>`}
              </div>
            </div>`;
        })}
      </div>
      ${o.unassigned.length > 0 && html`<div class="card inv-net"><div class="inv-net-t"><span class="ms">help</span>Adressen ohne erfasstes Netz</div>
        <div class="inv-addrs">${o.unassigned.map(u => html`<button type="button" class="inv-addr" onClick=${() => app.go('inventory', { assetId: u.asset })}><span class="mono">${u.address}</span><span class="ms">${kindIcon(u.kind)}</span><span class="ell">${u.name}</span></button>`)}</div></div>`}`;
  }

  // ---------- Detail / Bearbeiten ----------
  formFrom(a) {
    const s = this.props.app.state;
    return a
      ? { kind: a.kind, name: a.name, status: a.status, parent: a.parent || '', tags: a.tags.join(', '), doc: a.doc || '', data: { ...a.data }, ips: a.ips.map(i => ({ address: i.address, mac: i.mac || '', note: i.note || '' })) }
      : { kind: s.newKind || 'host', name: '', status: 'active', parent: s.newAssetParent || '', tags: '', doc: '', data: {}, ips: [] };
  }
  renderDetail(a, isNew) {
    const { app } = this.props;
    if (!a && !isNew) return html`<div class="page g18"><div class="card empty-big"><div class="t">Eintrag nicht gefunden</div><div class="btn-row center"><button type="button" class="btn btn-ghost md" onClick=${() => app.go('inventory', { assetId: null })}>Zum Inventar</button></div></div></div>`;
    const key = isNew ? 'new:' + (app.state.newKind || '') + (app.state.newAssetParent || '') : a.id + ':' + a.updated;
    if (this.state.formFor !== key) { this.state.formFor = key; this.state.form = this.formFrom(a); }
    const f = this.state.form;
    const canEdit = app.canEdit();
    const all = app.state.assets;
    const set = patch => this.setState({ form: { ...f, ...patch } });
    const setData = (k, v) => set({ data: { ...f.data, [k]: v } });
    const blocked = a ? descendants(all, a.id) : new Set();
    const parents = all.filter(x => (!a || (x.id !== a.id && !blocked.has(x.id))) && x.kind !== 'network').sort((x, y) => x.name.localeCompare(y.name, 'de'));
    const kids = a ? all.filter(x => x.parent === a.id) : [];
    const chain = [];
    for (let p = a && a.parent && all.find(x => x.id === a.parent), g = 0; p && g < 10; p = p.parent && all.find(x => x.id === p.parent), g++) chain.unshift(p);
    const fields = FIELDS_BY_KIND[f.kind] || FIELDS_BY_KIND.default;
    const net = a && a.kind === 'network' && this.state.overview && this.state.overview.networks.find(n => n.id === a.id);
    const conflicts = a && this.state.overview ? this.state.overview.conflicts.filter(c => c.assets.some(x => x.id === a.id)) : [];
    const doc = f.doc && app.doc(f.doc);
    const save = async () => {
      this.setState({ busy: true });
      const body = { kind: f.kind, name: f.name, status: f.status, parent: f.parent || null, tags: f.tags, doc: f.doc || null, data: Object.fromEntries(Object.entries(f.data).map(([k, v]) => [k, v ?? ''])), ips: f.ips.filter(i => i.address.trim()) };
      try {
        const r = isNew ? await api('/assets', { method: 'POST', body }) : await api('/assets/' + encodeURIComponent(a.id), { method: 'PUT', body });
        await this.reload();
        app.flash(isNew ? 'Eintrag angelegt' : 'Gespeichert');
        if (isNew) app.go('inventory', { assetId: r.asset.id }, true);
      } catch (e) { app.fail(e); }
      this.setState({ busy: false });
    };
    const remove = async () => {
      if (!confirm(`„${a.name}“ aus dem Inventar löschen?${kids.length ? `\n${kids.length} Untereintrag/-einträge rücken eine Ebene nach oben.` : ''}`)) return;
      try { await api('/assets/' + encodeURIComponent(a.id), { method: 'DELETE' }); await this.reload(); app.flash('Gelöscht'); app.go('inventory', { assetId: null }); } catch (e) { app.fail(e); }
    };
    const createDoc = async () => {
      const tpl = app.state.templates.find(t => t.id === TEMPLATE_FOR[a.kind]);
      const folder = a.kind === 'network' ? 'netzwerk' : ['container', 'service'].includes(a.kind) ? 'dienste' : 'server';
      try {
        const r = await api('/docs', { method: 'POST', body: { title: a.name, folder: app.state.folders.some(x => x.id === folder) ? folder : undefined, tags: tpl ? tpl.tags : [], content: `::asset {"id":"${a.id}"}\n\n${tpl ? applyPlaceholders(tpl.content).replace(/^(\|.*\n)+\n?/m, '') : ''}` } });
        app.upsertDoc(r.doc);
        await api('/assets/' + encodeURIComponent(a.id), { method: 'PUT', body: { doc: r.doc.id } });
        await this.reload();
        app.openEditor(r.doc);
      } catch (e) { app.fail(e); }
    };
    const copySnippet = () => { const t = `::asset {"id":"${a.id}"}`; if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(() => app.flash('Kopiert – im Dokument als eigene Zeile einfügen')); };
    const input = (k, ph, multiline) => (multiline
      ? html`<textarea class="input" rows="4" value=${f.data[k] || ''} placeholder=${ph || ''} disabled=${!canEdit} onInput=${e => setData(k, e.target.value)}></textarea>`
      : html`<input class=${'input' + (['cidr', 'gateway', 'dhcp', 'dns', 'ports', 'serial'].includes(k) ? ' mono' : '')} value=${f.data[k] || ''} placeholder=${ph || ''} disabled=${!canEdit} onInput=${e => setData(k, e.target.value)} />`);
    return html`
      <div class="page g18" data-screen-label="Inventar-Eintrag">
        <div class="row-between">
          <div class="crumbs">
            <button type="button" class="c" onClick=${() => app.go('inventory', { assetId: null })}>Inventar</button><span class="ms">chevron_right</span>
            ${chain.map(x => html`<button type="button" class="c" onClick=${() => app.go('inventory', { assetId: x.id })}>${x.name}</button><span class="ms">chevron_right</span>`)}
            <span class="cur">${isNew ? 'Neuer Eintrag' : a.name}</span>
          </div>
          ${app.headIcons()}
        </div>
        <div class="inv-detail-head">
          <span class="inv-big-ic"><span class="ms">${kindIcon(f.kind)}</span></span>
          <div class="grow">
            <input class="title-edit inv-title" value=${f.name} placeholder="Name, z. B. Hostname" disabled=${!canEdit} onInput=${e => set({ name: e.target.value })} />
            <div class="doc-meta">${statusPill(f.status)}<span class="small muted">${ASSET_KINDS[f.kind]}${a ? ` · geändert ${fmtDate(a.updated)}${a.updatedBy ? ` von ${a.updatedBy}` : ''}` : ''}</span></div>
          </div>
          ${canEdit && html`<div class="btn-row">
            ${!isNew && html`<button type="button" class="btn btn-ghost" onClick=${remove}><span class="ms">delete</span>Löschen</button>`}
            <button type="button" class="btn btn-primary" disabled=${this.state.busy || !f.name.trim()} onClick=${save}><span class="ms">check</span>${isNew ? 'Anlegen' : 'Speichern'}</button></div>`}
        </div>
        ${conflicts.length > 0 && html`<div class="banner warn"><span class="ms">warning</span><div class="grow">Doppelt vergeben: ${conflicts.map(c => `${c.address} (auch bei ${c.assets.filter(x => x.id !== a.id).map(x => x.name).join(', ')})`).join('; ')}</div></div>`}
        <div class="inv-grid">
          <div class="card inv-card">
            <div class="inv-form">
              <label class="field"><span>Typ</span><select class="input" value=${f.kind} disabled=${!canEdit} onChange=${e => set({ kind: e.target.value })}>${Object.entries(ASSET_KINDS).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
              <label class="field"><span>Status</span><select class="input" value=${f.status} disabled=${!canEdit} onChange=${e => set({ status: e.target.value })}>${Object.entries(ASSET_STATUS).map(([k, v]) => html`<option value=${k}>${v[0]}</option>`)}</select></label>
              ${f.kind !== 'network' && html`<label class="field"><span>Läuft auf</span><select class="input" value=${f.parent} disabled=${!canEdit} onChange=${e => set({ parent: e.target.value })}>
                <option value="">— (eigenständig)</option>${parents.map(x => html`<option value=${x.id}>${x.name} (${ASSET_KINDS[x.kind]})</option>`)}</select></label>`}
              <label class="field"><span>Tags</span><input class="input" value=${f.tags} placeholder="kommagetrennt" disabled=${!canEdit} onInput=${e => set({ tags: e.target.value })} /></label>
              ${fields.map(k => html`<label class=${'field' + (['description', 'notes'].includes(k) ? ' wide' : '')}><span>${FIELD_LABELS[k]}</span>${input(k, FIELD_PH[k], k === 'notes')}</label>`)}
            </div>
          </div>
          <div class="inv-side">
            ${f.kind !== 'network' && html`
              <div class="card inv-card">
                <div class="row-between"><h2 class="h2 s15">IP-Adressen</h2>${canEdit && html`<button type="button" class="w-btn" onClick=${() => set({ ips: [...f.ips, { address: '', mac: '', note: '' }] })}><span class="ms">add</span>IP</button>`}</div>
                ${f.ips.map((ip, k) => html`<div class="inv-ip-row">
                  <input class="input mono" value=${ip.address} placeholder="10.0.20.10" disabled=${!canEdit} onInput=${e => set({ ips: f.ips.map((x, j) => (j === k ? { ...x, address: e.target.value } : x)) })} />
                  <input class="input mono" value=${ip.mac} placeholder="MAC (optional)" disabled=${!canEdit} onInput=${e => set({ ips: f.ips.map((x, j) => (j === k ? { ...x, mac: e.target.value } : x)) })} />
                  <input class="input" value=${ip.note} placeholder="Notiz" disabled=${!canEdit} onInput=${e => set({ ips: f.ips.map((x, j) => (j === k ? { ...x, note: e.target.value } : x)) })} />
                  ${canEdit && html`<button type="button" class="w-icon" title="Entfernen" onClick=${() => set({ ips: f.ips.filter((x, j) => j !== k) })}><span class="ms">close</span></button>`}
                </div>`)}
                ${f.ips.length === 0 && html`<div class="md-empty">Keine IP-Adresse erfasst.</div>`}
                ${canEdit && this.state.overview && this.state.overview.networks.length > 0 && html`<div class="small muted inv-hint">Freie Adressen: ${this.state.overview.networks.map(n => html`<span class="inv-free-n">${n.name}: ${n.nextFree.slice(0, 2).map(ip => html`<button type="button" class="tag-chip mono" onClick=${() => set({ ips: [...f.ips.filter(i => i.address), { address: ip, mac: '', note: '' }] })}>${ip}</button>`)}</span>`)}</div>`}
              </div>`}
            <div class="card inv-card">
              <h2 class="h2 s15">Dokumentation</h2>
              ${doc ? html`<button type="button" class="list-row" onClick=${() => app.go('doc', { docId: doc.id })}><span class="ms">description</span><div class="grow"><div class="t">${doc.title}</div><div class="m">${app.folderPath(doc.folder)}</div></div></button>` : html`<div class="md-empty">Noch kein Dokument verknüpft.</div>`}
              ${canEdit && html`<label class="field"><span>Verknüpftes Dokument</span><select class="input" value=${f.doc} onChange=${e => set({ doc: e.target.value })}>
                <option value="">— keines —</option>${app.state.docs.slice().sort((x, y) => x.title.localeCompare(y.title, 'de')).map(d => html`<option value=${d.id}>${d.title}</option>`)}</select></label>`}
              ${canEdit && !isNew && html`<div class="btn-row">
                ${!a.doc && html`<button type="button" class="btn btn-ghost sm" onClick=${createDoc}><span class="ms">note_add</span>Dokument aus Vorlage anlegen</button>`}
                <button type="button" class="btn btn-ghost sm" onClick=${copySnippet} title="Karte mit den Angaben dieses Eintrags in ein Dokument einbinden"><span class="ms">content_copy</span>Als Karte einbinden</button></div>`}
            </div>
            ${!isNew && f.kind !== 'network' && html`
              <div class="card inv-card">
                <div class="row-between"><h2 class="h2 s15">Läuft darauf (${kids.length})</h2>${canEdit && html`<button type="button" class="w-btn" onClick=${() => app.go('inventory', { assetId: 'new', newAssetParent: a.id, newKind: a.kind === 'host' ? 'vm' : 'container' })}><span class="ms">add</span>Untereintrag</button>`}</div>
                ${kids.map(k => html`<button type="button" class="inv-addr" onClick=${() => app.go('inventory', { assetId: k.id })}><span class="ms">${kindIcon(k.kind)}</span><span class="ell">${k.name}</span><span class="faint mono">${k.ips.map(i => i.address).join(', ')}</span></button>`)}
                ${kids.length === 0 && html`<div class="md-empty">Nichts erfasst.</div>`}
              </div>`}
            ${net && html`
              <div class="card inv-card">
                <h2 class="h2 s15">Belegung (${net.used} von ${net.usable})</h2>
                ${net.nextFree.length > 0 && html`<div class="inv-free"><span class="small muted">Nächste freie:</span>${net.nextFree.slice(0, 6).map(ip => html`<span class="tag-chip mono">${ip}</span>`)}</div>`}
                <div class="inv-addrs">${net.addresses.map(u => html`<button type="button" class="inv-addr" onClick=${() => app.go('inventory', { assetId: u.asset })}><span class="mono">${u.address}</span><span class="ms">${kindIcon(u.kind)}</span><span class="ell">${u.name}</span></button>`)}</div>
              </div>`}
          </div>
        </div>
      </div>`;
  }
}

