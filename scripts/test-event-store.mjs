/* =============================================================================
   Tests for docs/assets/js/event-store.js and the 1-second polling policy.

   Run: node --test scripts/test-event-store.mjs
   ============================================================================= */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  eventKind,
  normaliseEvent,
  parseEvents,
  summariseEvents,
  loadEvents,
} from '../docs/assets/js/event-store.js';
import { mergeSources } from '../docs/assets/js/counter.js';

/* ------------------------------------------------------------------- kinds */

test('eventKind maps real file extensions and nothing else', () => {
  assert.equal(eventKind('azyronclient-1.0.0.jar'), 'jar');
  assert.equal(eventKind('AZYRONCLIENT-1.0.0.JAR'), 'jar');
  assert.equal(eventKind('azyron-client-1.0.0.mrpack'), 'mrpack');
  assert.equal(eventKind('notes.txt'), 'file');
  assert.equal(eventKind(''), 'file');
  assert.equal(eventKind(undefined), 'file');
});

/* ----------------------------------------------------------- normalisation */

test('normaliseEvent accepts a well-formed event and canonicalises the time', () => {
  const event = normaliseEvent({
    id: 'e1',
    assetId: 757856668,
    name: 'azyronclient-1.0.0.jar',
    at: '2026-11-17T15:04:11.500Z',
    count: 1,
  });
  assert.deepEqual(event, {
    id: 'e1',
    assetId: 757856668,
    name: 'azyronclient-1.0.0.jar',
    kind: 'jar',
    at: '2026-11-17T15:04:11.500Z',
    count: 1,
  });
});

test('normaliseEvent derives kind from the file name when absent', () => {
  const event = normaliseEvent({ name: 'azyron-client-1.0.0.mrpack', at: '2026-11-17T15:00:00Z', count: 1 });
  assert.equal(event.kind, 'mrpack');
});

test('normaliseEvent rejects anything that would corrupt a count', () => {
  const base = { name: 'x.jar', at: '2026-11-17T15:00:00Z', count: 1 };
  assert.equal(normaliseEvent(null), null);
  assert.equal(normaliseEvent({}), null);
  assert.equal(normaliseEvent({ ...base, at: undefined }), null);
  assert.equal(normaliseEvent({ ...base, at: 'not-a-date' }), null);
  assert.equal(normaliseEvent({ ...base, count: 0 }), null);
  assert.equal(normaliseEvent({ ...base, count: -3 }), null);
  assert.equal(normaliseEvent({ ...base, count: 'NaN' }), null);
});

test('parseEvents drops junk and duplicate deliveries instead of double counting', () => {
  const events = parseEvents({
    events: [
      { id: 'a', name: 'x.jar', at: '2026-11-17T15:00:02Z', count: 1 },
      { id: 'a', name: 'x.jar', at: '2026-11-17T15:00:02Z', count: 1 }, // duplicate
      { id: 'b', name: 'y.mrpack', at: '2026-11-17T15:00:01Z', count: 1 },
      { id: 'c', name: 'z.jar', at: 'garbage', count: 1 }, // invalid
      null,
      'nonsense',
    ],
  });
  assert.equal(events.length, 2, 'only the two valid, unique events survive');
  assert.deepEqual(events.map((e) => e.id), ['b', 'a'], 'sorted oldest first');
});

test('parseEvents tolerates every shape of missing payload', () => {
  assert.deepEqual(parseEvents(null), []);
  assert.deepEqual(parseEvents({}), []);
  assert.deepEqual(parseEvents({ events: 'nope' }), []);
  assert.deepEqual(parseEvents([]), []);
});

/* ------------------------------------------------------------- summarising */

const events = [
  { id: '1', name: 'a.jar', kind: 'jar', at: '2026-11-17T10:00:00Z', count: 1 },
  { id: '2', name: 'a.jar', kind: 'jar', at: '2026-11-17T11:00:00Z', count: 1 },
  { id: '3', name: 'b.mrpack', kind: 'mrpack', at: '2026-11-17T12:00:00Z', count: 1 },
];

test('summariseEvents counts JAR and MRPACK separately', () => {
  const summary = summariseEvents(events);
  assert.equal(summary.total, 3);
  assert.equal(summary.byKind.jar, 2);
  assert.equal(summary.byKind.mrpack, 1);
});

test('summariseEvents honours the launch cut-off', () => {
  const summary = summariseEvents(events, { since: '2026-11-17T11:30:00Z' });
  assert.equal(summary.total, 1, 'only the event after launch counts');
  assert.equal(summary.byKind.jar, 0);
  assert.equal(summary.byKind.mrpack, 1);
});

test('summariseEvents of an empty store is zero, never NaN', () => {
  const summary = summariseEvents([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.byKind.jar, 0);
  assert.equal(summary.byKind.mrpack, 0);
});

/* ------------------------------------------------------------ loadEvents */

test('loadEvents never throws and reports failure honestly', async () => {
  const missing = await loadEvents({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.events, []);

  const boom = await loadEvents({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(boom.ok, false);
  assert.deepEqual(boom.events, []);
  assert.match(boom.error, /offline/);
});

test('loadEvents parses a real payload', async () => {
  const result = await loadEvents({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ events: [{ id: 'x', name: 'a.jar', at: '2026-11-17T10:00:00Z', count: 1 }] }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
});

/* ------------------------------------------------------------ mergeSources */

test('GitHub is the source while the event store is empty', () => {
  const github = { total: 13, byKind: { jar: 12, mrpack: 1 }, hasBaseline: true };
  const merged = mergeSources(github, summariseEvents([]));
  assert.equal(merged.total, 13);
  assert.equal(merged.byKind.jar, 12);
  assert.equal(merged.source, 'github');
});

test('real events take over once any exist, without double counting', () => {
  const github = { total: 13, byKind: { jar: 12, mrpack: 1 }, hasBaseline: true };
  const merged = mergeSources(
    github,
    summariseEvents([
      { id: '1', name: 'a.jar', kind: 'jar', at: '2026-11-17T10:00:00Z', count: 1 },
      { id: '2', name: 'b.mrpack', kind: 'mrpack', at: '2026-11-17T10:00:01Z', count: 1 },
      { id: '3', name: 'c.jar', kind: 'jar', at: '2026-11-17T10:00:02Z', count: 1 },
    ]),
  );
  assert.equal(merged.source, 'events');
  assert.equal(merged.byKind.jar, 2, 'events replace GitHub, not add to it');
  assert.equal(merged.byKind.mrpack, 1);
  assert.equal(merged.total, 3);
});

/* ------------------------------------------------- the shipped event file */

test('the shipped download-events.json is valid and starts empty', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../docs/data/download-events.json', import.meta.url), 'utf8'),
  );
  assert.equal(raw.schemaVersion, 1);
  assert.ok(Array.isArray(raw.events));
  assert.deepEqual(parseEvents(raw), [], 'must not ship with invented events');
  assert.equal(raw.totals.total, 0);
});

/* ------------------------------------------------------- the 1-second policy */

test('the poll interval targets exactly 1 second for all visitors', async () => {
  const { POLL_MS } = await import('../docs/assets/js/github-data.js');
  assert.equal(POLL_MS, 1000, 'the live section must revalidate every second');
});

test('pollInterval backs off only when the shared budget is actually at risk', async () => {
  const { pollInterval, getRateLimit } = await import('../docs/assets/js/github-data.js');
  // No response headers seen yet (fresh page) → still 1 second.
  assert.equal(pollInterval(), 1000);
  // A recorded budget leaves the interval untouched while it is healthy.
  const before = getRateLimit();
  assert.equal(typeof before, 'object');
  assert.equal(pollInterval(), 1000);
});

test('the event store is fetched on every poll, at the same cadence', async () => {
  const source = await readFile(new URL('../docs/assets/js/app.js', import.meta.url), 'utf8');
  // both sources must be read together each cycle, not on separate schedules
  assert.match(source, /Promise\.all\(\[\s*getRelease\(/);
  assert.match(source, /loadEvents\(\)/);
});

/* ------------------------------------------- rate-limit header parsing edge cases */

test('a response with no rate-limit headers must not be read as "budget exhausted"', async () => {
  // Regression: `Number(null)` is 0, so a 304 or a proxied response that omits
  // x-ratelimit-remaining was recorded as remaining=0. pollInterval() then
  // dropped the refresh to 5s+ and the "1 second" live section silently stopped
  // being live while still showing a LIVE badge.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../docs/assets/js/github-data.js', import.meta.url), 'utf8');

  const fn = source.slice(source.indexOf('function readRateLimit'));
  const body = fn.slice(0, fn.indexOf('\n}', fn.indexOf('}')) + 1);

  assert.doesNotMatch(
    body,
    /Number\(response\.headers\.get\(/,
    'must not coerce a missing header to 0 — use a presence check',
  );
  assert.match(body, /=== null|== null|!raw/, 'must detect absent headers explicitly');
});

test('the shipped site never advertises a cadence it cannot deliver', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  // The cadence shown to visitors is rendered from the real interval, so the
  // markup must not hard-code a number that could drift from the scheduler.
  assert.match(html, /id="liveCadence"/);
  assert.doesNotMatch(html, /refreshing every\s+1\s*s</, 'the number must be data-driven');
});
