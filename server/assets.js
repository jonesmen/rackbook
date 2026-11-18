// Inventar: strukturierte Einträge für Hosts, VMs, Container, Geräte, Dienste und Netzwerke.
// Daraus entstehen IP-Übersichten (Belegung, freie Adressen, Doppelvergaben) und „Was läuft wo?“.
import { Router } from 'express';
import { isIPv4, isIPv6 } from 'node:net';
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
// Adressen werden in einer einheitlichen Schreibweise gespeichert (IPv6 klein und gekürzt),
// damit „FE80::1“ und „fe80:0::1“ als dieselbe Adresse erkannt werden.
export function normIp(v) {
  const s = String(v || '').trim();
  if (isIPv4(s)) return s;
  if (isIPv6(s) && !s.includes('%')) { try { return new URL(`http://[${s}]`).hostname.slice(1, -1); } catch { return null; } }
  return null;
}
export const isIp = s => normIp(s) !== null;
export const ipToInt = ip => ip.split('.').reduce((a, b) => (a * 256) + Number(b), 0);
export const intToIp = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
// IPv6 ⇄ Zahl (BigInt)
function ip6ToBig(ip) {
  let s = normIp(ip);
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // eingebettete IPv4-Schreibweise
  if (m) { const n = ipToInt(m[2]); s = m[1] + Math.floor(n / 65536).toString(16) + ':' + (n % 65536).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const parts = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return parts.reduce((a, x) => (a << 16n) + BigInt(parseInt(x || '0', 16)), 0n);
}
function bigToIp6(n) {
  const parts = [];
  for (let i = 0; i < 8; i++) { parts.unshift(Number(n & 0xffffn).toString(16)); n >>= 16n; }
  return normIp(parts.join(':'));
}
// Netz in CIDR-Schreibweise. IPv4: Zahlen, IPv6: BigInt (v6: true)
export function parseCidr(c) {
  const m = String(c || '').trim().match(/^([0-9a-f.:]+)\/(\d{1,3})$/i);
  if (!m) return null;
  const prefix = Number(m[2]);
  if (isIPv4(m[1])) {
    if (prefix > 32) return null;
    const size = 2 ** (32 - prefix);
    const start = Math.floor(ipToInt(m[1]) / size) * size;
    return { start, end: start + size - 1, prefix, size, text: `${intToIp(start)}/${prefix}` };
  }
  if (isIPv6(m[1])) {
    if (prefix > 128) return null;
    const size = 1n << BigInt(128 - prefix);
    const start = (ip6ToBig(m[1]) / size) * size;
    return { v6: true, start, end: start + size - 1n, prefix, size, text: `${bigToIp6(start)}/${prefix}` };
  }
  return null;
}
// Liegt die Adresse im Netz?
export function inCidr(net, ip) {
  const a = normIp(ip);
  if (!a || !net) return false;
  if (net.v6) return a.includes(':') && ip6ToBig(a) >= net.start && ip6ToBig(a) <= net.end;
  return !a.includes(':') && ipToInt(a) >= net.start && ipToInt(a) <= net.end;
}
function parseRange(r, net) {
  const m = String(r || '').match(/(\d+\.\d+\.\d+\.\d+)\s*[-–]\s*(\d+\.\d+\.\d+\.\d+)/);
  if (!m || !isIPv4(m[1]) || !isIPv4(m[2])) return null;
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
function height(id, guard = 0) {
  if (guard > 20) return 0;
  const kids = db.prepare('SELECT id FROM assets WHERE parent_id = ?').all(id);
  return kids.length ? 1 + Math.max(...kids.map(k => height(k.id, guard + 1))) : 0;
}
// Eigene Felder: [{ label, value }] (höchstens 20)
function normCustom(list) {
  const out = [], seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const label = ctrlStrip(String((x && x.label) ?? '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    const value = ctrlStrip(String((x && x.value) ?? '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!label || !value || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, value });
    if (out.length >= 20) break;
  }
  return out;
}
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
      if (kind === 'network') throw new HttpError(400, 'Ein Netzwerk läuft nicht auf einem anderen Eintrag. Geräte werden über ihre IP-Adresse zugeordnet.');
      if (db.prepare('SELECT kind FROM assets WHERE id = ?').get(p).kind === 'network') throw new HttpError(400, 'Ein Eintrag kann nicht „auf“ einem Netzwerk laufen – die Zuordnung zum Netz ergibt sich aus der IP-Adresse.');
      // Tiefe inklusive der eigenen Untereinträge
      if (ancestors(p).length + 1 + (cur ? height(cur.id) : 0) > 6) throw new HttpError(400, 'Zu viele Ebenen (max. 7).');
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
    // Eigene Felder: ausdrücklich als Liste (custom) – oder unbekannte Schlüssel (z. B. von der KI: ram, cpu),
    // die sonst stillschweigend verloren gingen
    let custom = b.data.custom !== undefined ? normCustom(b.data.custom) : (Array.isArray(base.custom) ? base.custom : []);
    const extra = Object.keys(b.data).filter(k => !FIELDS.includes(k) && k !== 'custom' && ['string', 'number', 'boolean'].includes(typeof b.data[k]));
    if (extra.length) custom = normCustom([...custom.filter(c => !extra.some(k => k.toLowerCase() === c.label.toLowerCase())), ...extra.map(k => ({ label: k, value: b.data[k] }))]);
    if (custom.length) base.custom = custom; else delete base.custom;
    const net = base.cidr ? parseCidr(base.cidr) : null;
    if (base.cidr && !net) throw new HttpError(400, `Ungültiges Netz „${base.cidr}“ – Format z. B. 10.0.20.0/24 oder fd00:20::/64.`);
    if (net) base.cidr = net.text;
    if (base.gateway) {
      const gw = normIp(base.gateway);
      if (!gw) throw new HttpError(400, `Ungültiges Gateway „${base.gateway}“.`);
      if (net && !inCidr(net, gw)) throw new HttpError(400, `Das Gateway ${gw} liegt nicht im Netz ${net.text}.`);
      base.gateway = gw;
    }
    if (base.dhcp && net && !net.v6 && !parseRange(base.dhcp, net)) throw new HttpError(400, `Der DHCP-Bereich „${base.dhcp}“ ist ungültig oder liegt nicht im Netz ${net.text}. Format: 10.0.20.100-10.0.20.200`);
    if (base.url && !/^https?:\/\//i.test(base.url)) throw new HttpError(400, 'Die URL muss mit http:// oder https:// beginnen.');
    out.data = JSON.stringify(base);
  }
  if (b.ips !== undefined) {
    if (!Array.isArray(b.ips)) throw new HttpError(400, 'IPs müssen eine Liste sein.');
    const ips = [];
    if (b.ips.length > 50) throw new HttpError(400, 'Höchstens 50 IP-Adressen je Eintrag.');
    for (const x of b.ips) {
      const o = typeof x === 'string' ? { address: x } : (x || {});
      const raw = String(o.address || '').trim();
      if (!raw) continue;
      const address = normIp(raw);
      if (!address) throw new HttpError(400, `Ungültige IP-Adresse „${raw}“.`);
      if (ips.some(i => i.address === address)) continue;
      const mac = String(o.mac || '').trim();
      if (mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) throw new HttpError(400, `Ungültige MAC-Adresse „${mac}“.`);
      ips.push({ address, ...(mac ? { mac: mac.toLowerCase().replace(/-/g, ':') } : {}), ...(o.note ? { note: ctrlStrip(o.note).trim().slice(0, 80) } : {}) });
    }
    out.ips = JSON.stringify(ips);
  }
  if (b.tags !== undefined) out.tags = JSON.stringify(normTags(b.tags));
  if (b.doc !== undefined) {
    const d = b.doc ? String(b.doc) : null;
    // Nur prüfen, wenn sich die Verknüpfung ändert (ein Dokument im Papierkorb blockiert das Speichern sonst)
    if (d && d !== (cur ? cur.doc : null) && !db.prepare('SELECT 1 FROM documents WHERE id = ? AND deleted_at IS NULL').get(d)) throw new HttpError(400, 'Das verknüpfte Dokument existiert nicht.');
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
  for (const a of live) for (const ip of a.ips) uses.push({ address: normIp(ip.address) || ip.address, asset: a.id, name: a.name, kind: a.kind, mac: ip.mac, note: ip.note });
  const group = key => {
    const m = new Map();
    for (const u of uses) { const k = key(u); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(u); }
    return [...m.entries()].filter(([, l]) => new Set(l.map(x => x.asset)).size > 1);
  };
  const conflicts = group(u => u.address).map(([address, l]) => ({ address, assets: l.map(x => ({ id: x.asset, name: x.name })) }));
  const macConflicts = group(u => u.mac).map(([mac, l]) => ({ mac, assets: [...new Map(l.map(x => [x.asset, { id: x.asset, name: x.name }])).values()] }));
  const nets = live.filter(a => a.kind === 'network' && parseCidr(a.data.cidr)).map(n => ({ n, net: parseCidr(n.data.cidr) }));
  // Netze, deren Adressbereiche sich überschneiden
  const overlaps = [];
  for (let i = 0; i < nets.length; i++) for (let k = i + 1; k < nets.length; k++) {
    const a = nets[i], b = nets[k];
    if (!!a.net.v6 === !!b.net.v6 && a.net.start <= b.net.end && b.net.start <= a.net.end) overlaps.push({ a: { id: a.n.id, name: a.n.name, cidr: a.net.text }, b: { id: b.n.id, name: b.n.name, cidr: b.net.text } });
  }
  const networks = nets.map(({ n, net }) => {
    const inNet = uses.filter(u => inCidr(net, u.address));
    const base = { id: n.id, name: n.name, cidr: net.text, vlan: n.data.vlan || null, gateway: n.data.gateway || null };
    if (net.v6) {
      // IPv6: Netze sind zu groß zum Durchzählen – nur Belegung und die nächsten freien Adressen ab ::1
      const taken = new Set(inNet.map(u => u.address));
      const gw = n.data.gateway ? normIp(n.data.gateway) : null;
      const free = [];
      for (let i = net.start + 1n; i <= net.end && free.length < 5 && i - net.start < 4096n; i++) { const ip = bigToIp6(i); if (!taken.has(ip) && ip !== gw) free.push(ip); }
      return { ...base, v6: true, dhcp: n.data.dhcp || null, usable: null, used: taken.size, reserved: 0, available: null, addresses: inNet.sort((x, y) => (ip6ToBig(x.address) < ip6ToBig(y.address) ? -1 : 1)), nextFree: free };
    }
    const taken = new Set(inNet.map(u => ipToInt(u.address)));
    const gw = n.data.gateway && isIPv4(n.data.gateway) ? ipToInt(n.data.gateway) : null;
    const dhcp = parseRange(n.data.dhcp, net);
    const first = net.prefix >= 31 ? net.start : net.start + 1;
    const last = net.prefix >= 31 ? net.end : net.end - 1;
    const usable = Math.max(0, last - first + 1);
    const isReserved = i => i === gw || (dhcp && i >= dhcp[0] && i <= dhcp[1]);
    const free = [];
    for (let i = first; i <= last && free.length < 10 && i - first < 70000; i++) {
      if (taken.has(i) || isReserved(i)) continue;
      free.push(intToIp(i));
    }
    // Reserviert: DHCP-Bereich und Gateway (nicht doppelt zählen). Belegte Adressen innerhalb davon zählen nicht noch einmal.
    const reserved = (dhcp ? Math.max(0, Math.min(dhcp[1], last) - Math.max(dhcp[0], first) + 1) : 0) + (gw !== null && gw >= first && gw <= last && !(dhcp && gw >= dhcp[0] && gw <= dhcp[1]) ? 1 : 0);
    const takenFree = [...taken].filter(i => i >= first && i <= last && !isReserved(i)).length;
    return {
      ...base, dhcp: dhcp ? `${intToIp(dhcp[0])}–${intToIp(dhcp[1])}` : null,
      usable, used: taken.size, reserved, available: Math.max(0, usable - reserved - takenFree),
      addresses: inNet.sort((x, y) => ipToInt(x.address) - ipToInt(y.address)), nextFree: free,
    };
  });
  const covered = u => networks.some(n => n.addresses.includes(u));
  return { networks, conflicts, macConflicts, overlaps, unassigned: uses.filter(u => !covered(u)) };
}

// Kurztext einer IP-Übersicht (für MCP)
export function ipOverviewText(o, only) {
  const nets = only ? o.networks.filter(n => n.id === only || n.cidr === only || n.name.toLowerCase() === String(only).toLowerCase()) : o.networks;
  const parts = nets.map(n => `### ${n.name} (${n.cidr}${n.vlan ? `, VLAN ${n.vlan}` : ''})\nBelegt: ${n.used}${n.usable !== null ? ` von ${n.usable}` : ''}${n.dhcp ? ` · DHCP ${n.dhcp}` : ''}${n.gateway ? ` · Gateway ${n.gateway}` : ''}\nNächste freie Adressen: ${n.nextFree.join(', ') || '–'}\n${n.addresses.map(u => `- ${u.address} → ${u.name} (\`${u.asset}\`)${u.note ? ` – ${u.note}` : ''}`).join('\n')}`);
  if (!only && o.overlaps.length) parts.unshift(`**Netze mit überschneidendem Adressbereich:**\n${o.overlaps.map(x => `- ${x.a.name} (${x.a.cidr}) ↔ ${x.b.name} (${x.b.cidr})`).join('\n')}`);
  if (!only && o.macConflicts.length) parts.unshift(`**Doppelt vergebene MAC-Adressen:**\n${o.macConflicts.map(c => `- ${c.mac}: ${c.assets.map(a => a.name).join(', ')}`).join('\n')}`);
  if (!only && o.conflicts.length) parts.unshift(`**Doppelt vergebene IPs:**\n${o.conflicts.map(c => `- ${c.address}: ${c.assets.map(a => a.name).join(', ')}`).join('\n')}`);
  if (!only && o.unassigned.length) parts.push(`### Ohne erfasstes Netz\n${o.unassigned.map(u => `- ${u.address} → ${u.name}`).join('\n')}`);
  return parts.join('\n\n') || 'Noch keine Netzwerke mit Adressbereich erfasst.';
}

// ---------- Routen ----------
export const assetApi = Router();
const editor = requireRole('editor');

assetApi.get('/', (req, res) => res.json({ assets: listAssets(), kinds: KINDS, statuses: STATUSES }));
assetApi.get('/ip-overview', (req, res) => res.json(ipOverview()));
assetApi.get('/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rackbook-inventar-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + assetsToCsv());
});
assetApi.post('/import', editor, (req, res) => {
  const r = tx(() => importCsv(String(req.body?.csv || ''), req.user.id));
  audit(req, 'asset.imported', null, { created: r.created, updated: r.updated, errors: r.errors.length });
  res.json(r);
});
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

// ---------- CSV (Tabellenkalkulation) ----------
const CSV_COLS = ['typ', 'name', 'status', 'laeuft_auf', 'ips', 'tags', ...FIELDS];
const csvCell = v => { const t = String(v ?? ''); return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
export function assetsToCsv(assets = listAssets()) {
  const byId = new Map(assets.map(a => [a.id, a]));
  const custom = [...new Set(assets.flatMap(a => (a.data.custom || []).map(c => c.label)))];
  const head = [...CSV_COLS, ...custom.map(l => 'feld:' + l)];
  const rows = assets.map(a => [
    a.kind, a.name, a.status, a.parent && byId.get(a.parent) ? byId.get(a.parent).name : '',
    a.ips.map(i => i.address + (i.mac ? ` [${i.mac}]` : '') + (i.note ? ` (${i.note})` : '')).join(', '), a.tags.join(', '),
    ...FIELDS.map(k => a.data[k] || ''), ...custom.map(l => ((a.data.custom || []).find(c => c.label === l) || {}).value || ''),
  ]);
  return [head, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
// Zeilen einer CSV-Datei (Trennzeichen ; oder , – wird erkannt; Anführungszeichen nach RFC 4180)
export function parseCsv(text) {
  const src = String(text || '').replace(/^\ufeff/, '');
  const first = src.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const KIND_ALIAS = Object.fromEntries(Object.entries(KINDS).flatMap(([k, v]) => [[k, k], [v.toLowerCase(), k]]));
const STATUS_ALIAS = Object.fromEntries(Object.entries(STATUSES).flatMap(([k, v]) => [[k, k], [v.toLowerCase(), k]]));
// Einträge aus CSV anlegen oder (bei gleichem Typ und Namen) aktualisieren
export function importCsv(text, userId) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'Die Datei enthält keine Datenzeilen (erste Zeile = Spaltenüberschriften).');
  if (rows.length > 2001) throw new HttpError(400, 'Höchstens 2000 Einträge je Import.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = n => head.indexOf(n);
  const nameCol = col('name');
  if (nameCol < 0) throw new HttpError(400, 'Die Spalte „name“ fehlt. Am besten zuerst exportieren und die Datei als Vorlage nehmen.');
  const existing = listAssets();
  const find = (kind, name) => existing.find(a => a.kind === kind && a.name.toLowerCase() === name.toLowerCase());
  const out = { created: 0, updated: 0, errors: [] }, parents = [];
  rows.slice(1).forEach((r, k) => {
    const get = n => (col(n) >= 0 ? (r[col(n)] || '').trim() : undefined);
    const line = k + 2;
    try {
      const name = (r[nameCol] || '').trim();
      if (!name) throw new HttpError(400, 'Name fehlt.');
      const kind = KIND_ALIAS[(get('typ') || 'host').toLowerCase()];
      if (!kind) throw new HttpError(400, `Unbekannter Typ „${get('typ')}“.`);
      const body = { kind, name };
      const st = get('status');
      if (st) { if (!STATUS_ALIAS[st.toLowerCase()]) throw new HttpError(400, `Unbekannter Status „${st}“.`); body.status = STATUS_ALIAS[st.toLowerCase()]; }
      if (get('ips') !== undefined) body.ips = get('ips').split(/,/).map(x => x.trim()).filter(Boolean).map(x => {
        const m = x.match(/^(\S+)(?:\s*\[([^\]]+)\])?(?:\s*\((.*)\))?$/);
        return m ? { address: m[1], mac: m[2] || '', note: m[3] || '' } : { address: x };
      });
      if (get('tags') !== undefined) body.tags = get('tags');
      const data = {};
      for (const f of FIELDS) if (get(f) !== undefined) data[f] = get(f);
      const custom = head.map((h, i) => (h.startsWith('feld:') ? { label: rows[0][i].trim().slice(5), value: (r[i] || '').trim() } : null)).filter(Boolean);
      if (custom.length) data.custom = custom;
      body.data = data;
      const cur = find(kind, name);
      const a = cur ? updateAsset(cur.id, body, userId) : createAsset(body, userId);
      if (cur) out.updated++; else { out.created++; existing.push(a); }
      if (get('laeuft_auf') !== undefined) parents.push({ id: a.id, parent: get('laeuft_auf'), line });
    } catch (e) { out.errors.push({ line, error: e.message || 'Ungültige Zeile' }); }
  });
  // „Läuft auf“ erst zuordnen, wenn alle Einträge existieren
  for (const p of parents) {
    try {
      const target = p.parent ? existing.find(a => a.kind !== 'network' && a.name.toLowerCase() === p.parent.toLowerCase()) : null;
      if (p.parent && !target) throw new HttpError(400, `„Läuft auf“: Eintrag „${p.parent}“ nicht gefunden.`);
      updateAsset(p.id, { parent: target ? target.id : null }, userId);
    } catch (e) { out.errors.push({ line: p.line, error: e.message }); }
  }
  return out;
}

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
