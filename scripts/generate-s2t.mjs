// Generates src/lib/s2t-table.json from the `opencc-data` npm package
// (Apache-2.0, nk2028/opencc-data mirroring BYVoid/OpenCC dictionaries).
// Simplified→Traditional only; run `node scripts/generate-s2t.mjs` to regenerate.
//
// Ported from dcfc-website's scripts/generate-t2s.mjs with the direction
// flipped, plus one s2t-specific change: identity phrases (from === target,
// e.g. 皇后→皇后) are KEPT when converting the phrase char-by-char would
// produce something else (后→後 would give 皇後) — in this direction they
// protect against char-level misfires. Conversely, phrases whose target
// equals the plain char-by-char conversion (e.g. 后来→後來) add no value
// and are dropped to keep the committed table small.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dataDir = join(dirname(require.resolve('opencc-data/package.json')), 'data');
const readDict = (name) => readFileSync(join(dataDir, name), 'utf8');

function* entries(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [from, to] = trimmed.split('\t');
    if (!from || !to) continue;
    yield [from, to.split(' ')[0]]; // first target wins, as in OpenCC's own s2t chain
  }
}

// Pass 1: single-character map (STCharacters). Identity rows are pure weight.
const chars = {};
for (const [from, to] of entries(readDict('STCharacters.txt'))) {
  if (from !== to) chars[from] = to;
}

const charConvert = (s) => [...s].map((ch) => chars[ch] ?? ch).join('');

// Pass 2: phrases (STPhrases), keeping only those that change the outcome
// relative to plain char-by-char conversion.
const map = { ...chars };
let maxLen = 1;
let kept = 0;
for (const [from, to] of entries(readDict('STPhrases.txt'))) {
  if (charConvert(from) === to) continue;
  map[from] = to;
  kept++;
  if (from.length > maxLen) maxLen = from.length;
}

writeFileSync('src/lib/s2t-table.json', JSON.stringify({ maxLen, map }));
console.log(
  `chars: ${Object.keys(chars).length}, phrases kept: ${kept}, total: ${Object.keys(map).length}, maxLen: ${maxLen}`,
);
