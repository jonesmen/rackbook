// Markdown-Schicht: Einlesen → Speichern → Einlesen darf Inhalte nicht verändern.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parse, serialize, md, inline, safeHref, listNumbers } = await import('../public/js/md.js');
const { escText } = await import('../public/js/editor/dom.js');
const { lineDiff, diffHunks } = await import('../public/js/diff.js');

const rt = s => serialize(parse(s));
const strip = blocks => JSON.parse(JSON.stringify(blocks, (k, v) => (k === 'id' || k === 'line' || k === 'start' ? undefined : v)));

// Diese Eingaben müssen unverändert wieder herauskommen
const STABLE = [
  'Absatz mit **fett**, *kursiv*, ~~durch~~ und `code`.',
  'Zeile eins\\\nZeile zwei',
  '## Überschrift\n\nText',
  '- a\n    - b\n        - c\n- d',
  '1. a\n    1. x\n    2. y\n2. b',
  '- [ ] offen\n    - [x] erledigt\n- [ ] noch eins',
  '- a\n    1. eins\n    2. zwei\n- b',
  '- erste Zeile\\\n  zweite Zeile\n- b',
  '3. drei\n4. vier',
  '0. null\n1. eins',
  '- a\n\n1. b',
  '> a\\\n> b',
  '> a\n>\n> b',
  '> - a\\\n> - b',
  '> [!NOTE]\n> Text',
  '> [!WARNING] Eigener Titel\n> Text\\\n> zweite Zeile',
  '> [!TIP] Nur Titel\n>',
  '```js title="x"\ncode\n```\n\nnach dem Block',
  '```{r}\nplot(1)\n```',
  '~~~\ncode\n~~~'.replace(/~~~/g, '```'),
  '````\n```\ninnen\n```\n````',
  'text ![a](https://x.y/z.png) more',
  '***fett und kursiv*** und *a***b**',
  'C:\\',
  'Pfad C:\\\\\\\nnächste Zeile',
  '![a](https://x.y/a_%281%29.png "Titel")',
  '[Wiki](https://de.wikipedia.org/wiki/Foo_(Bar)) danach',
  '## Ticket \\#',
  'echo $a$b und $HOME:$PATH',
  'Formel $x^2$ im Text und 5$ oder 10$',
  '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |',
  '| a | b |\n|---|---|\n| x \\| y | `z` |',
  ':::toggle Titel\n```\n:::\n```\n\nx\n:::\n\ndanach',
  ':::columns\n:::column\nlinks\n:::\n:::column\nrechts\n:::\n:::',
  'Text[^1]\n\n[^1]: Fußnote',
  '{{date:2026-01-31}} {{time:14:30}} {{status:In Arbeit|blue}}',
  '::asset {"id":"abcd1234"}',
  '\\- kein Listenpunkt',
  '\\# keine Überschrift',
  '---',
  '',
];

test('Markdown: stabile Eingaben bleiben unverändert', () => {
  for (const s of STABLE) assert.equal(rt(s), s, `verändert: ${JSON.stringify(s)}`);
});

// Diese Eingaben werden einmal normalisiert, danach bleiben sie stabil – und der Inhalt bleibt erhalten
const NORMALIZED = [
  '- a\n  - b\n    - c',
  '* a\n* b',
  '1. a\n1. b\n1. c',
  '- a\n  weiter ohne Umbruch\n- b',
  '> a\n> b',
  '> [!TIP] nur text',
  '> - a\n> - b',
  'Zeile eins\nZeile zwei',
  '## Ticket #',
  '# H1\n##### H5',
  ':::columns\nlose Zeile\n:::column\na\n:::\n:::column\nb\n:::\n:::',
  ':::column\nallein\n:::',
  '-',
  '- a\r\n- b\r\n',
  '| a | b |\n| 1 | 2 |',
  'Tab\t- kein Problem',
];

test('Markdown: Normalisierung ist nach einem Durchlauf stabil und verliert keinen Text', () => {
  const words = s => (s.replace(/^:::.*$/gm, '').match(/[A-Za-zäöüÄÖÜß0-9]{2,}/g) || []).sort().join(' ');
  for (const s of NORMALIZED) {
    const once = rt(s);
    assert.equal(rt(once), once, `nicht stabil: ${JSON.stringify(s)}`);
    assert.deepEqual(strip(parse(once)), strip(parse(s)), `anderer Aufbau: ${JSON.stringify(s)}`);
    assert.equal(words(once), words(s), `Text verloren: ${JSON.stringify(s)}`);
  }
});

test('Markdown: verschachtelte Listen', () => {
  const b = parse('- a\n  - b\n    - c\n  - d\n- e');
  assert.deepEqual(b.map(x => x.indent || 0), [0, 1, 2, 1, 0]);
  const html = md('- a\n    1. x\n    2. y\n- b').html;
  assert.equal(html, '<ul class="md-list"><li>a<ol class="md-list"><li>x</li><li>y</li></ol></li><li>b</li></ul>');
  // Nummern zählen je Ebene
  assert.deepEqual(listNumbers(parse('1. a\n    1. x\n    2. y\n2. b\n\nText\n\n5. neu')), [1, 1, 2, 2, 0, 5]);
  // Aufgaben behalten ihre Zeilennummer (zum Abhaken in der Leseansicht)
  assert.deepEqual(parse('Text\n\n- [ ] a\n    - [x] b').filter(x => x.type === 'todo').map(x => [x.line, x.done, x.indent || 0]), [[2, false, 0], [3, true, 1]]);
  assert.match(md('- [ ] a\n    - [x] b', { interactive: true }).html, /data-task-line="1"/);
});

test('Markdown: Zitate, Hinweise, Code-Zäune', () => {
  assert.equal(parse('> a\\\n> b')[0].text, 'a\nb');
  assert.equal(parse('> a\n>\n> b')[0].text, 'a\n\nb');
  const c = parse('> [!WARNING] Achtung Strom\n> Erst abschalten.')[0];
  assert.deepEqual([c.kind, c.title, c.text], ['warning', 'Achtung Strom', 'Erst abschalten.']);
  assert.match(md('> [!WARNING] Achtung Strom\n> x').html, /md-callout-t">Achtung Strom</);
  // Ein Zaun mit Zusatz darf den Rest des Dokuments nicht verschlucken
  const blocks = parse('```js title="x"\ncode\n```\n\nnach');
  assert.deepEqual(blocks.map(x => x.type), ['code', 'p']);
  assert.equal(blocks[0].lang, 'js title="x"');
  // „:::“ in einem Code-Block schließt den Umschaltblock nicht
  const t = parse(':::toggle T\n```\n:::\n```\ninnen\n:::\n\naußen');
  assert.deepEqual(t.map(x => x.type), ['toggle', 'p']);
  assert.deepEqual(t[0].children.map(x => x.type), ['code', 'p']);
});

test('Markdown: Inline-Sonderfälle', () => {
  assert.equal(inline('***x***'), '<strong><em>x</em></strong>');
  assert.equal(inline('*a***b**'), '<em>a</em><strong>b</strong>');
  assert.equal(inline('echo $a$b'), 'echo $a$b');
  assert.match(inline('$x^2$'), /md-math/);
  assert.equal(inline('C:\\'), 'C:\\');
  // Bilder im Fließtext sind im Editor ein Atom und gehen beim Bearbeiten nicht verloren
  assert.match(inline('a ![b](https://x.y/z.png) c', {}, 'edit'), /data-md="!\[b\]\(https:\/\/x\.y\/z\.png\)"/);
  assert.match(inline('[W](https://de.wikipedia.org/wiki/Foo_(Bar))'), /href="https:\/\/de\.wikipedia\.org\/wiki\/Foo_\(Bar\)"/);
  // Klammern in Bild-Adressen werden kodiert, damit das Bild ein Bild bleibt
  assert.equal(rt('![a](https://x.y/a_(1).png)'), '![a](https://x.y/a_%281%29.png)');
  assert.equal(parse('![a](https://x.y/a_(1).png)')[0].type, 'image');
  assert.match(md('| a | b |\n|:-:|--:|\n| 1 | 2 |').html, /<th class="al-center">a<\/th><th class="al-right">b<\/th>/);
});

test('Markdown: unsichere Adressen', () => {
  assert.equal(safeHref('\u0001javascript:alert(1)'), null);
  assert.equal(safeHref('java\tscript:alert(1)'), 'java script:alert(1)');
  assert.equal(safeHref('//evil.example'), null);
  assert.equal(safeHref('/\\evil.example'), null);
  assert.equal(safeHref('/doc/abc'), '/doc/abc');
  assert.doesNotMatch(md('[x](//evil.example)').html, /href/);
});

test('Editor: Text → Markdown', () => {
  assert.equal(escText('C:\\'), 'C:\\\\');
  assert.equal(parse(escText('C:\\'))[0].text, 'C:\\\\');
  assert.equal(inline(escText('C:\\')), 'C:\\');
  assert.equal(inline(escText('a * b ` c')), 'a * b ` c');
});

test('Vergleich zweier Stände', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.map(r => r.t + r.s), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepEqual(lineDiff('x', 'x').map(r => r.t), [' ']);
  const long = Array.from({ length: 30 }, (_, i) => 'z' + i).join('\n');
  assert.ok(diffHunks(lineDiff(long, long.replace('z15', 'neu'))).some(r => r.t === '…'));
});
