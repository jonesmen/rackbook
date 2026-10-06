// Kopiert Frontend-Abhängigkeiten (Preact/htm, Schriften) aus node_modules nach public/,
// damit die App komplett ohne externe CDNs auskommt (strenge Content-Security-Policy).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const files = [
  ['htm/preact/standalone.module.js', 'public/vendor/preact-htm.js'],
  ['@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2', 'public/fonts/jakarta-latin.woff2'],
  ['@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-ext-wght-normal.woff2', 'public/fonts/jakarta-latin-ext.woff2'],
  ['@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2', 'public/fonts/jbmono-latin.woff2'],
  ['@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2', 'public/fonts/jbmono-latin-ext.woff2'],
  ['material-symbols/material-symbols-rounded.woff2', 'public/fonts/material-symbols-rounded.woff2'],
];
for (const [src, dst] of files) {
  const to = join(root, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(nm, src), to);
}
console.log(`vendor: ${files.length} Dateien kopiert`);
