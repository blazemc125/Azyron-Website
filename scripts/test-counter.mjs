#!/usr/bin/env node
/**
 * Unit tests for the "Downloads Since Launch" counter (docs/assets/js/counter.js).
 *
 * These run in CI and locally (`node --test scripts/`). They exist to prove the
 * two properties that matter:
 *   1. the counter STARTS AT ZERO — GitHub's historical counts never leak into it;
 *   2. it only ever increments by a REAL difference in GitHub's own counters,
 *      tracked separately for JAR and MRPACK, and can never go negative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSinceLaunch, parseBaseline, BASELINE_URL } from '../docs/assets/js/counter.js';

const BASELINE = parseBaseline(JSON.parse(readFileSync(new URL('../docs/data/counter-baseline.json', import.meta.url), 'utf8')));

const releaseWith = (jar, mrpack) => ({
  assets: [
    { id: 757856664, name: 'azyron-client-1.0.0.mrpack', downloads: mrpack },
    { id: 757856668, name: 'azyronclient-1.0.0.jar', downloads: jar },
  ],
});

test('baseline file parses and matches the launch snapshot shape', () => {
  assert.ok(BASELINE, 'baseline should parse');
  assert.equal(BASELINE.baselineTotal, 15);
  assert.equal(BASELINE.baseline['757856668'], 10);
  assert.equal(BASELINE.baseline['757856664'], 5);
  assert.match(BASELINE.launchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('the displayed total is ZERO at launch, not GitHub history', () => {
  const result = computeSinceLaunch(releaseWith(10, 5), BASELINE);
  assert.equal(result.total, 0, 'must start from zero');
  assert.equal(result.byKind.jar, 0);
  assert.equal(result.byKind.mrpack, 0);
  assert.equal(result.liveTotal, 15, 'GitHub history is still available, but not shown as the counter');
  assert.equal(result.baselineTotal, 15);
});

test('each real download increments the total and its own kind', () => {
  let result = computeSinceLaunch(releaseWith(11, 5), BASELINE);
  assert.equal(result.total, 1);
  assert.equal(result.byKind.jar, 1);
  assert.equal(result.byKind.mrpack, 0);

  result = computeSinceLaunch(releaseWith(13, 7), BASELINE);
  assert.equal(result.total, 5);
  assert.equal(result.byKind.jar, 3);
  assert.equal(result.byKind.mrpack, 2);
});

test('JAR and MRPACK counters are independent', () => {
  const jarOnly = computeSinceLaunch(releaseWith(12, 5), BASELINE);
  const mrpackOnly = computeSinceLaunch(releaseWith(10, 9), BASELINE);
  assert.equal(jarOnly.byKind.jar, 2);
  assert.equal(jarOnly.byKind.mrpack, 0);
  assert.equal(mrpackOnly.byKind.jar, 0);
  assert.equal(mrpackOnly.byKind.mrpack, 4);
});

test('per-asset figures line up with the release assets', () => {
  const result = computeSinceLaunch(releaseWith(12, 8), BASELINE);
  const jar = result.perAsset.find((p) => p.kind === 'jar');
  const mrpack = result.perAsset.find((p) => p.kind === 'mrpack');
  assert.deepEqual(
    { name: jar.name, live: jar.live, baseline: jar.baseline, since: jar.since },
    { name: 'azyronclient-1.0.0.jar', live: 12, baseline: 10, since: 2 },
  );
  assert.equal(mrpack.since, 3);
  assert.equal(result.total, jar.since + mrpack.since);
});

test('never shows a negative number if GitHub reports less than the snapshot', () => {
  const result = computeSinceLaunch(releaseWith(4, 2), BASELINE);
  assert.equal(result.total, 0);
  assert.equal(result.byKind.jar, 0);
  assert.equal(result.byKind.mrpack, 0);
  assert.equal(result.perAsset.every((p) => p.since >= 0), true);
  assert.equal(result.perAsset.every((p) => p.clamped), true);
});

test('a new asset published after launch counts from zero', () => {
  const release = {
    assets: [
      ...releaseWith(10, 5).assets,
      { id: 999, name: 'azyronclient-1.1.0.jar', downloads: 3 }, // unknown to the baseline
    ],
  };
  const result = computeSinceLaunch(release, BASELINE);
  assert.equal(result.total, 3, 'an asset absent from the snapshot has a baseline of 0');
  assert.equal(result.byKind.jar, 3);
});

test('without a baseline the UI is told, rather than shown an un-baselined number', () => {
  const result = computeSinceLaunch(releaseWith(10, 5), null);
  assert.equal(result.hasBaseline, false);
});

test('baseline falls back to names when asset ids change', () => {
  const release = {
    assets: [
      { id: 111, name: 'azyronclient-1.0.0.jar', downloads: 12 },
      { id: 222, name: 'azyron-client-1.0.0.mrpack', downloads: 5 },
    ],
  };
  const result = computeSinceLaunch(release, BASELINE);
  assert.equal(result.byKind.jar, 2, 'id changed → matched by file name');
  assert.equal(result.total, 2);
});

test('malformed baselines are rejected instead of producing wrong numbers', () => {
  assert.equal(parseBaseline(null), null);
  assert.equal(parseBaseline({}), null);
  assert.equal(parseBaseline({ baseline: {} }), null);
  assert.equal(parseBaseline({ nonsense: true }), null);
});

test('the baseline URL is relative so it works under /Azyron-Website/', () => {
  assert.equal(BASELINE_URL, './data/counter-baseline.json');
  assert.ok(!BASELINE_URL.startsWith('/'), 'must not be root-absolute');
});

test('the counter is not hardcoded anywhere in the shipped JS', () => {
  const app = readFileSync(new URL('../docs/assets/js/app.js', import.meta.url), 'utf8');
  const counter = readFileSync(new URL('../docs/assets/js/counter.js', import.meta.url), 'utf8');
  // no literal totals such as "totalDownloads = 1234"
  assert.ok(!/totalDownloads['"]?\s*[,)]\s*['"]?\d{2,}/.test(app));
  assert.ok(!/Math\.random/.test(app), 'counter must never be randomised');
  assert.ok(!/Math\.random/.test(counter), 'counter must never be randomised');
});
