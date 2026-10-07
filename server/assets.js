// Inventar: strukturierte Einträge für Hosts, VMs, Container, Geräte, Dienste und Netzwerke.
// Daraus entstehen IP-Übersichten (Belegung, freie Adressen, Doppelvergaben) und „Was läuft wo?“.
import { Router } from 'express';
import { db, tx } from './db.js';
import { HttpError, randomToken } from './security.js';
import { requireRole, audit } from './auth.js';
import { normTags, ctrlStrip } from './routes/docs.js';

export const KINDS = {
  host: 'Server', vm: 'VM', container: 'Container', device: 'Gerät', service: 'Dienst', network: 'Netzwerk',
};
export const STATUSES = { active: 'Aktiv', planned: 'Geplant', maintenance: 'Wartung', retired: 'Außer Betrieb' };
// Freitextfelder je Eintrag (alle optional)
export const FIELDS = ['description', 'location', 'os', 'hardware', 'vendor', 'model', 'serial', 'url', 'ports', 'notes', 'cidr', 'vlan', 'gateway', 'dhcp', 'dns'];
const FIELD_MAX = { description: 500, notes: 4000 };

// ---------- IP-Hilfen ----------
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
export const isIp = s => IPV4.test(s) || (IPV6.test(s) && s.includes(':') && s.length <= 39);
export const ipToInt = ip => ip.split('.').reduce((a, b) => (a * 256) + Number(b), 0);
export const intToIp = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
export function parseCidr(c) {
  const m = String(c || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!m || !IPV4.test(m[1]) || Number(m[2]) > 32) return null;
  const prefix = Number(m[2]);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipToInt(m[1]) / size) * size;
  return { start, end: start + size - 1, prefix, size, text: `${intToIp(start)}/${prefix}` };
}
function parseRange(r, net) {
  const m = String(r || '').match(/(\d+\.\d+\.\d+\.\d+)\s*[-–]\s*(\d+\.\d+\.\d+\.\d+)/);
  if (!m || !IPV4.test(m[1]) || !IPV4.test(m[2])) return null;
  const a = ipToInt(m[1]), b = ipToInt(m[2]);
  return a <= b && (!net || (a >= net.start && b <= net.end)) ? [a, b] : null;
}

// ---------- Darstellung ----------
export function assetDto(a) {
  return {
    id: a.id, kind: a.kind, name: a.name, parent: a.parent_id ?? null, status: a.status,
    data: JSON.parse(a.data || '{}'), ips: JSON.parse(a.ips || '[]'), tags: JSON.parse(a.tags || '[]'), doc: a.doc_id ?? null,
    created: a.created_at, updated: a.updated_at, updatedBy: a.updated_by_name ?? null,
  };
}
const SELECT = 'SELECT a.*, u.display_name AS updated_by_name FROM assets a LEFT JOIN users u ON u.id = a.updated_by';
export const listAssets = () => db.prepare(`${SELECT} ORDER BY a.kind, lower(a.name)`).all().map(assetDto);
export const getAsset = id => { const a = db.prepare(`${SELECT} WHERE a.id = ?`).get(String(id || '')); return a ? assetDto(a) : null; };

// ---------- Eingaben prüfen ----------
function ancestors(id) {
  const out = [];
  let cur = id, guard = 0;
  while (cur && guard++ < 50) {
    const p = db.prepare('SELECT parent_id FROM assets WHERE id = ?').get(cur)?.parent_id;
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}
export function normalizeAsset(b, cur) {
  const out = {};
  const kind = b.kind !== undefined ? String(b.kind) : cur?.kind;
  if (!KINDS[kind]) throw new HttpError(400, `Unbekannter Typ. Erlaubt: ${Object.keys(KINDS).join(', ')}.`);
  out.kind = kind;
  if (b.name !== undefined || !cur) {
    out.name = ctrlStrip(b.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!out.name) throw new HttpError(400, 'Bitte einen Namen angeben.');
  }
  if (b.status !== undefined) {
    if (!STATUSES[b.status]) throw new HttpError(400, `Unbekannter Status. Erlaubt: ${Object.keys(STATUSES).join(', ')}.`);
    out.status = b.status;
  }
  if (b.parent !== undefined) {
    const p = b.parent ? String(b.parent) : null;
    if (p) {
      if (!db.prepare('SELECT 1 FROM assets WHERE id = ?').get(p)) throw new HttpError(400, 'Der übergeordnete Eintrag existiert nicht.');
      if (cur && (p === cur.id || ancestors(p).includes(cur.id))) throw new HttpError(400, 'Ein Eintrag kann nicht auf sich selbst oder einem eigenen Untereintrag laufen.');
      if (ancestors(p).length >= 6) throw new HttpError(400, 'Zu viele Ebenen (max. 7).');
    }
    out.parent_id = p;
  }
  if (b.data !== undefined) {
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new HttpError(400, 'Ungültige Felder.');
    const base = cur ? { ...cur.data } : {};
    for (const k of FIELDS) {
      if (b.data[k] === undefined) continue;
      const v = ctrlStrip(String(b.data[k] ?? '')).replace(k === 'notes' ? /\r/g : /\s+/g, k === 'notes' ? '' : ' ').trim().slice(0, FIELD_MAX[k] || 200);
      if (v) base[k] = v; else delete base[k];
    }
    if (base.cidr && !parseCidr(base.cidr)) throw new HttpError(400, `Ungültiges Netz „${base.cidr}“ – Format z. B. 10.0.20.0/24.`);
    if (base.cidr) base.cidr = parseCidr(base.cidr).text;
    if (base.gateway && !isIp(base.gateway)) throw new HttpError(400, `Ungültiges Gateway „${base.gateway}“.`);
    if (base.url && !/^https?:\/\//i.test(base.url)) throw new HttpError(400, 'Die URL muss mit http:// oder https:// beginnen.');
    out.data = JSON.stringify(base);
  }
  if (b.ips !== undefined) {
    if (!Array.isArray(b.ips)) throw new HttpError(400, 'IPs müssen eine Liste sein.');
    const ips = [];
    for (const x of b.ips.slice(0, 50)) {
      const o = typeof x === 'string' ? { address: x } : (x || {});
      const address = String(o.address || '').trim();
      if (!address) continue;
      if (!isIp(address)) throw new HttpError(400, `Ungültige IP-Adresse „${address}“.`);
      const mac = String(o.mac || '').trim();
      if (mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) throw new HttpError(400, `Ungültige MAC-Adresse „${mac}“.`);
      ips.push({ address, ...(mac ? { mac: mac.toLowerCase().replace(/-/g, ':') } : {}), ...(o.note ? { note: ctrlStrip(o.note).trim().slice(0, 80) } : {}) });
    }
    out.ips = JSON.stringify(ips);
  }
  if (b.tags !== undefined) out.tags = JSON.stringify(normTags(b.tags));
  if (b.doc !== undefined) {
    const d = b.doc ? String(b.doc) : null;
    if (d && !db.prepare('SELECT 1 FROM documents WHERE id = ? AND deleted_at IS NULL').get(d)) throw new HttpError(400, 'Das verknüpfte Dokument existiert nicht.');
    out.doc_id = d;
  }
  return out;
}

export function createAsset(b, userId) {
  const v = normalizeAsset(b, null);
  const id = 'as_' + randomToken(9);
  const now = Date.now();
  db.prepare(`INSERT INTO assets (id, kind, name, parent_id, status, data, ips, tags, doc_id, created_by, created_at, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, v.kind, v.name, v.parent_id ?? null, v.status || 'active', v.data || '{}', v.ips || '[]', v.tags || '[]', v.doc_id ?? null, userId, now, userId, now);
  return getAsset(id);
}
export function updateAsset(id, b, userId) {
  const cur = getAsset(id);
  if (!cur) throw new HttpError(404, 'Eintrag nicht gefunden.');
  const v = normalizeAsset(b, cur);
  if (v.kind === cur.kind) delete v.kind;
  const keys = Object.keys(v);
  if (keys.length) db.prepare(`UPDATE assets SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...keys.map(k => v[k]), userId, Date.now(), cur.id);
  return getAsset(cur.id);
}
export function deleteAsset(id) {
  const cur = getAsset(id);
  if (!cur) throw new HttpError(404, 'Eintrag nicht gefunden.');
  tx(() => {
    // Untereinträge rücken eine Ebene nach oben
    db.prepare('UPDATE assets SET parent_id = ? WHERE parent_id = ?').run(cur.parent, cur.id);
    db.prepare('DELETE FROM assets WHERE id = ?').run(cur.id);
  });
  return cur;
}

// ---------- IP-Übersicht ----------
export function ipOverview(assets = listAssets()) {
  const live = assets.filter(a => a.status !== 'retired');
  const uses = [];
  for (const a of live) for (const ip of a.ips) uses.push({ address: ip.address, asset: a.id, name: a.name, kind: a.kind, mac: ip.mac, note: ip.note });
  const byAddr = new Map();
  for (const u of uses) { if (!byAddr.has(u.address)) byAddr.set(u.address, []); byAddr.get(u.address).push(u); }
  const conflicts = [...byAddr.entries()].filter(([, l]) => new Set(l.map(x => x.asset)).size > 1).map(([address, l]) => ({ address, assets: l.map(x => ({ id: x.asset, name: x.name })) }));
  const networks = live.filter(a => a.kind === 'network' && parseCidr(a.data.cidr)).map(n => {
    const net = parseCidr(n.data.cidr);
    const inNet = uses.filter(u => IPV4.test(u.address) && ipToInt(u.address) >= net.start && ipToInt(u.address) <= net.end);
    const taken = new Set(inNet.map(u => ipToInt(u.address)));
    const gw = n.data.gateway && IPV4.test(n.data.gateway) ? ipToInt(n.data.gateway) : null;
    const dhcp = parseRange(n.data.dhcp, net);
    const first = net.prefix >= 31 ? net.start : net.start + 1;
    const last = net.prefix >= 31 ? net.end : net.end - 1;
    const usable = Math.max(0, last - first + 1);
    const free = [];
    for (let i = first; i <= last && free.length < 10 && i - first < 70000; i++) {
      if (taken.has(i) || i === gw || (dhcp && i >= dhcp[0] && i <= dhcp[1])) continue;
      free.push(intToIp(i));
    }
    const reserved = (gw !== null && gw >= first && gw <= last && !taken.has(gw) ? 1 : 0) + (dhcp ? dhcp[1] - dhcp[0] + 1 : 0);
    return {
      id: n.id, name: n.name, cidr: net.text, vlan: n.data.vlan || null, gateway: n.data.gateway || null, dhcp: dhcp ? `${intToIp(dhcp[0])}–${intToIp(dhcp[1])}` : null,
      usable, used: taken.size, reserved, available: Math.max(0, usable - taken.size - reserved),
      addresses: inNet.sort((x, y) => ipToInt(x.address) - ipToInt(y.address)), nextFree: free,
    };
  });
  const covered = u => networks.some(n => n.addresses.includes(u));
  return { networks, conflicts, unassigned: uses.filter(u => !covered(u)) };
}

// Kurztext einer IP-Übersicht (für MCP)
export function ipOverviewText(o, only) {
  const nets = only ? o.networks.filter(n => n.id === only || n.cidr === only || n.name.toLowerCase() === String(only).toLowerCase()) : o.networks;
  const parts = nets.map(n => `### ${n.name} (${n.cidr}${n.vlan ? `, VLAN ${n.vlan}` : ''})\nBelegt: ${n.used} von ${n.usable}${n.dhcp ? ` · DHCP ${n.dhcp}` : ''}${n.gateway ? ` · Gateway ${n.gateway}` : ''}\nNächste freie Adressen: ${n.nextFree.join(', ') || '–'}\n${n.addresses.map(u => `- ${u.address} → ${u.name} (\`${u.asset}\`)${u.note ? ` – ${u.note}` : ''}`).join('\n')}`);
  if (!only && o.conflicts.length) parts.unshift(`**Doppelt vergebene IPs:**\n${o.conflicts.map(c => `- ${c.address}: ${c.assets.map(a => a.name).join(', ')}`).join('\n')}`);
  if (!only && o.unassigned.length) parts.push(`### Ohne erfasstes Netz\n${o.unassigned.map(u => `- ${u.address} → ${u.name}`).join('\n')}`);
  return parts.join('\n\n') || 'Noch keine Netzwerke mit Adressbereich erfasst.';
}

// ---------- Routen ----------
export const assetApi = Router();
const editor = requireRole('editor');

assetApi.get('/', (req, res) => res.json({ assets: listAssets(), kinds: KINDS, statuses: STATUSES }));
assetApi.get('/ip-overview', (req, res) => res.json(ipOverview()));
assetApi.get('/:id', (req, res) => {
  const a = getAsset(req.params.id);
  if (!a) throw new HttpError(404, 'Eintrag nicht gefunden.');
  res.json({ asset: a });
});
assetApi.post('/', editor, (req, res) => {
  const a = createAsset(req.body || {}, req.user.id);
  audit(req, 'asset.created', a.id, { name: a.name, kind: a.kind });
  res.status(201).json({ asset: a });
});
assetApi.put('/:id', editor, (req, res) => {
  const a = updateAsset(req.params.id, req.body || {}, req.user.id);
  audit(req, 'asset.updated', a.id, { name: a.name });
  res.json({ asset: a });
});
assetApi.delete('/:id', editor, (req, res) => {
  const a = deleteAsset(req.params.id);
  audit(req, 'asset.deleted', a.id, { name: a.name, kind: a.kind });
  res.json({ ok: true });
});

// Für Backups
export function exportAssets() { return db.prepare('SELECT * FROM assets').all().map(assetDto); }
export function importAssets(list, userId) {
  let n = 0;
  const valid = (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(a.id) && KINDS[a.kind]);
  for (const a of valid) {
    const now = Date.now();
    db.prepare(`INSERT INTO assets (id, kind, name, status, data, ips, tags, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, '{}', '[]', '[]', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING`).run(a.id, a.kind, String(a.name || a.id).slice(0, 120), STATUSES[a.status] ? a.status : 'active', userId, Number(a.created) || now, userId, now);
  }
  for (const a of valid) {
    try { updateAsset(a.id, { kind: a.kind, name: a.name, status: STATUSES[a.status] ? a.status : 'active', data: a.data || {}, ips: a.ips || [], tags: a.tags || [] }, userId); n++; } catch { /* ungültige Felder überspringen */ }
  }
  for (const a of valid) {
    try { updateAsset(a.id, { parent: a.parent || null }, userId); } catch { /* ignorieren */ }
    try { updateAsset(a.id, { doc: a.doc || null }, userId); } catch { /* ignorieren */ }
  }
  return n;
}
