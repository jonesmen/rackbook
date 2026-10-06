// Kopiert Frontend-Abhängigkeiten aus node_modules nach public/ und baut den Excalidraw-Editor,
// damit die App komplett ohne externe CDNs auskommt (strenge Content-Security-Policy).
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
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
  ['katex/dist/katex.min.js', 'public/vendor/katex/katex.min.js'],
  ['mermaid/dist/mermaid.min.js', 'public/vendor/mermaid/mermaid.min.js'],
];
for (const [src, dst] of files) {
  const to = join(root, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(nm, src), to);
}

// Excalidraw-Schriften (lokal, damit der Editor nichts von externen CDNs nachlädt)
const excFonts = join(nm, '@excalidraw/excalidraw/dist/prod/fonts');
let fonts = 0;
const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const n of readdirSync(from)) {
    const f = join(from, n);
    if (statSync(f).isDirectory()) copyDir(f, join(to, n));
    else { copyFileSync(f, join(to, n)); fonts++; }
  }
};
copyDir(excFonts, join(root, 'public/vendor/excalidraw/fonts'));

// Excalidraw-Editor bündeln (React + Excalidraw → eine Datei). Wird übersprungen, wenn aktuell.
const out = join(root, 'public/vendor/excalidraw/app.js');
const entry = join(root, 'scripts/excalidraw-entry.jsx');
const pkg = join(nm, '@excalidraw/excalidraw/package.json');
if (process.env.FORCE_VENDOR || !existsSync(out) || statSync(out).mtimeMs < Math.max(statSync(entry).mtimeMs, statSync(pkg).mtimeMs)) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry], outfile: out, bundle: true, minify: true, format: 'iife', target: 'es2020', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, conditions: ['production'], external: ['*.woff2'], logLevel: 'warning', legalComments: 'none',
    plugins: [{
      // Schriften nie vom CDN (esm.sh) nachladen, sondern immer vom eigenen Server
      name: 'kein-cdn',
      setup(b) {
        b.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async args => {
          const { readFile } = await import('node:fs/promises');
          const src = await readFile(args.path, 'utf8');
          return { contents: src.replace(/`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/g, '(window.location.origin+"/vendor/excalidraw/")'), loader: 'js' };
        });
      },
    }],
  });
  console.log('vendor: Excalidraw gebaut');
}
console.log(`vendor: ${files.length} Dateien und ${fonts} Excalidraw-Schriften kopiert`);
