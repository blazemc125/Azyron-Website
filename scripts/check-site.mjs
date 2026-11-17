#!/usr/bin/env node
/**
 * Static-site validator for docs/ (runs in CI and locally: `node scripts/check-site.mjs`).
 *
 * GitHub Pages serves this project from a sub-path (`/Azyron-Website/`), so a
 * single root-absolute reference (`/assets/…`) silently breaks the whole site.
 * This script fails the build if that ever happens, and otherwise proves that
 * every asset, anchor and ARIA reference in the published HTML resolves.
 *
 * Exit code 0 = publishable, 1 = broken.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'docs');
const errors = [];
const warnings = [];
const checks = [];

const ok = (msg) => checks.push(`  ok   ${msg}`);
const fail = (msg) => errors.push(msg);

/* ------------------------------------------------------------------ helpers */
const read = (p) => readFileSync(p, 'utf8');

const attrPattern = /(?:href|src)\s*=\s*"([^"]+)"/g;

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

/* ----------------------------------------------------- 1. required files exist */
const required = ['index.html', '404.html', '.nojekyll', 'favicon.svg', 'site.webmanifest', 'robots.txt',
  'assets/css/styles.css', 'assets/js/app.js', 'assets/js/github-data.js'];
for (const file of required) {
  if (!existsSync(join(SITE, file))) fail(`missing required file: docs/${file}`);
}
if (!errors.length) ok(`required files present (${required.length})`);

/* ------------------------------------------------- 2. no root-absolute paths */
const htmlFiles = ['index.html', '404.html'];
for (const file of htmlFiles) {
  const full = join(SITE, file);
  if (!existsSync(full)) continue;
  const html = read(full);

  for (const match of html.matchAll(attrPattern)) {
    const value = match[1];
    if (value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('tel:')) continue;
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:')) continue;
    if (value.startsWith('/')) {
      fail(`docs/${file}: root-absolute reference "${value}" breaks under /Azyron-Website/ — use "./…"`);
    }
  }
}
if (!errors.length) ok('all local references are relative (sub-path safe)');

/* ------------------------------- 3. every referenced local asset really exists */
function resolveLocalRef(fromFile, ref) {
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  return ref.startsWith('./') || !clean.startsWith('/')
    ? join(SITE, dirname(fromFile), clean)
    : join(SITE, clean.slice(1));
}

for (const file of htmlFiles) {
  const full = join(SITE, file);
  if (!existsSync(full)) continue;
  for (const match of read(full).matchAll(attrPattern)) {
    const value = match[1];
    if (!value || value.startsWith('#') || /^(https?:)?\/\//i.test(value) || value.startsWith('data:')) continue;
    const target = resolveLocalRef(file, value);
    if (!target) continue;
    if (!existsSync(target)) fail(`docs/${file}: reference "${value}" → file not found`);
  }
}
// CSS url() references (fonts live one directory up from the css file)
for (const cssFile of listFiles(SITE).filter((f) => f.endsWith('.css'))) {
  const css = read(join(SITE, cssFile));
  for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const value = match[1];
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('#')) continue;
    // url(#filter) / url(%23filter) inside an inline SVG data URI are fragments, not files
    if (/^%23|^#/.test(value)) continue;
    if (value.startsWith('/')) {
      fail(`docs/${cssFile}: root-absolute url(${value})`);
      continue;
    }
    const target = join(SITE, dirname(cssFile), value);
    if (!existsSync(target)) fail(`docs/${cssFile}: url(${value}) → file not found`);
  }
}
if (!errors.length) ok('every referenced asset exists on disk');

/* --------------------------------------- 4. JS module graph + syntax requires */
for (const file of htmlFiles) {
  const full = join(SITE, file);
  if (!existsSync(full)) continue;
  for (const match of read(full).matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const value = match[1];
    if (value.startsWith('/')) fail(`docs/${file}: root-absolute script src "${value}"`);
    const target = resolveLocalRef(file, value);
    if (target && !existsSync(target)) fail(`docs/${file}: script "${value}" not found`);
  }
}
// relative imports inside the ESM files must resolve
for (const jsFile of listFiles(SITE).filter((f) => f.endsWith('.js'))) {
  const source = read(join(SITE, jsFile));
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = join(SITE, dirname(jsFile), match[1]);
    if (!existsSync(target)) fail(`docs/${jsFile}: imports "${match[1]}" which does not exist`);
  }
}
ok('browser module graph resolves');

/* ------------------------------- 5. HTML integrity: ids, anchors, ARIA targets */
const parserWarnings = [];
for (const file of htmlFiles) {
  const full = join(SITE, file);
  if (!existsSync(full)) continue;
  const html = read(full);

  // duplicate ids
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) fail(`docs/${file}: duplicate id "${id}"`);
    seen.add(id);
  }

  // internal anchors must resolve
  for (const match of html.matchAll(/href="(#[^"]+)"/g)) {
    const target = match[1].slice(1);
    if (target && !seen.has(target)) fail(`docs/${file}: anchor "${match[1]}" has no matching id`);
  }

  // aria-controls / aria-labelledby must resolve
  for (const attr of ['aria-controls', 'aria-labelledby']) {
    for (const match of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      for (const id of match[1].split(/\s+/)) {
        if (id && !seen.has(id)) fail(`docs/${file}: ${attr}="${id}" has no matching element`);
      }
    }
  }

  // external links must be safe
  for (const match of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
    if (!/rel="[^"]*noopener/.test(match[0])) fail(`docs/${file}: target="_blank" without rel="noopener" → ${match[0].slice(0, 80)}`);
  }

  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt=/.test(match[0])) parserWarnings.push(`docs/${file}: <img> without alt`);
  }
}
warnings.push(...parserWarnings);
if (!errors.length) ok('HTML ids, anchors and ARIA references resolve');

/* --------------------------------------------------- 6. size budget (warning) */
const totalKb = listFiles(SITE)
  .filter((f) => !f.endsWith('.woff2'))
  .reduce((sum, f) => sum + statSync(join(SITE, f)).size, 0) / 1024;
if (totalKb > 900) warnings.push(`site payload is ${totalKb.toFixed(0)} KB (excluding fonts) — consider trimming`);
else ok(`payload ${totalKb.toFixed(0)} KB excluding fonts`);

/* ------------------------------------------------------------------- report */
console.log('AZYRON CLIENT — static site validation');
checks.forEach((line) => console.log(line));
if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach((w) => console.log(`  warn ${w}`));
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  errors.forEach((e) => console.error(`  FAIL ${e}`));
  process.exit(1);
}
console.log(`\nPASS — docs/ is publishable at /Azyron-Website/ (${htmlFiles.length} pages checked)`);
