#!/usr/bin/env node
/**
 * Design-system linter: scans src/**\/*.{astro,ts,tsx,css} (excluding the
 * generated tokens.generated.css) for hardcoded style values that must come
 * from design tokens instead:
 *   - hex colors            #FFF / #31487A / #RRGGBBAA
 *   - rgb()/rgba()/hsl()/hsla() literals
 *   - font-family with anything other than var(--*) values
 * Escape hatch: append `/* tokens-ok *\/` on the same line.
 * Plain Node ESM, zero dependencies. findViolations is exported for tests.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCAN_EXTS = new Set(['.astro', '.ts', '.tsx', '.css']);
const EXCLUDED_FILES = new Set(['tokens.generated.css']);
const ALLOW_MARK = '/* tokens-ok */';

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const COLOR_FN_RE = /\b(?:rgba?|hsla?)\(/;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;]*)/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** font-family passes only if its value is purely var(--*) refs (plus a
 * CSS-wide keyword), e.g. `font-family: var(--font-body);`. */
function fontFamilyOk(value) {
  const rest = value
    .replace(/var\(--[a-zA-Z0-9-]+\)/g, '')
    .replace(/[\s,]/g, '');
  return rest === '' || /^(inherit|initial|unset|revert)$/i.test(rest);
}

/**
 * Scan a directory tree for hardcoded style values.
 * @returns {{file: string, line: number, rule: string}[]}
 */
export function findViolations(rootDir) {
  const violations = [];
  for (const file of walk(rootDir)) {
    if (!SCAN_EXTS.has(extname(file)) || EXCLUDED_FILES.has(basename(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (text.includes(ALLOW_MARK)) return;
      const line = i + 1;
      if (HEX_RE.test(text)) {
        violations.push({ file, line, rule: 'hardcoded hex color' });
      }
      if (COLOR_FN_RE.test(text)) {
        violations.push({ file, line, rule: 'hardcoded rgb()/hsl() color' });
      }
      const font = FONT_FAMILY_RE.exec(text);
      if (font && !fontFamilyOk(font[1])) {
        violations.push({ file, line, rule: 'literal font-family (use var(--font-*))' });
      }
    });
  }
  return violations;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = process.argv[2] ? resolve(process.argv[2]) : join(root, 'src');
  const violations = findViolations(target);
  const shown = relative(process.cwd(), target) || '.';
  if (violations.length > 0) {
    console.error(`tokens:check FAILED — ${violations.length} hardcoded style value(s) in ${shown}:`);
    for (const v of violations) {
      console.error(`  ${relative(process.cwd(), v.file)}:${v.line}  ${v.rule}`);
    }
    console.error('Use design tokens (var(--color-*), var(--font-*)) or append /* tokens-ok */ to allow intentionally.');
    process.exit(1);
  }
  console.log(`tokens:check passed — no hardcoded colors/fonts in ${shown}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
