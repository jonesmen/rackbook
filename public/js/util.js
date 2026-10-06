import { html } from '/vendor/preact-htm.js';

export const DAY = 86400000;
export const ACCENTS = {
  mint: { soft: 'oklch(0.9 0.09 162)', strong: 'oklch(0.6 0.14 162)' },
  blau: { soft: 'oklch(0.9 0.06 250)', strong: 'oklch(0.56 0.16 250)' },
  violett: { soft: 'oklch(0.9 0.07 295)', strong: 'oklch(0.55 0.18 295)' },
};
export const DEFAULT_SETTINGS = { livePreview: true, wrap: true, fontSize: 14, accent: 'mint', startPage: 'dashboard', sidebarCollapsed: false, bmOpen: true };
export const ROLE_LABEL = { admin: 'Administrator', editor: 'Bearbeiter', viewer: 'Leser' };
export const STATUS_LABEL = { active: 'Aktiv', pending: 'Wartet auf Freischaltung', disabled: 'Deaktiviert' };

export const fcol = h => ({ background: `oklch(0.955 0.035 ${h})`, color: `oklch(0.62 0.16 ${h})` });
export const wordsOf = c => (c || '').split(/\s+/).filter(Boolean).length;
export const fmtWords = n => n.toLocaleString('de-DE') + ' Wörter';

export function fmtDate(ts) {
  if (!ts) return '–';
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const sd = (a, b) => a.toDateString() === b.toDateString();
  if (sd(d, now)) return 'Heute, ' + t;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sd(d, y)) return 'Gestern, ' + t;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const fmtDateTime = ts => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

export function download(name, text, type = 'text/markdown') {
  const b = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
export const fileName = d => d.title.replace(/[\/\\:*?"<>|]/g, '-') + '.md';
export const docMd = d => `# ${d.title}\n\n${d.content}\n`;
export const initials = name => (name || '?').split(/\s+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();

export function describeUA(ua) {
  const s = ua || '';
  const b = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl/i.test(s) ? 'curl' : 'Browser';
  const o = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return o ? `${b} auf ${o}` : b;
}

// Kleine UI-Bausteine
export const Icon = ({ name, cls = '', fill = false, title }) => html`<span class=${`ms ${cls}${fill ? ' fill' : ''}`} aria-hidden=${title ? undefined : 'true'} title=${title}>${name}</span>`;
export const Toggle = ({ on }) => html`<div class=${'toggle' + (on ? ' on' : '')} aria-hidden="true"><div></div></div>`;
export const stop = e => e && e.stopPropagation && e.stopPropagation();
