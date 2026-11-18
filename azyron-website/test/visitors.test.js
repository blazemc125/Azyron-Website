/**
 * Tests for the visitor store (azyron-website/lib/visitors.js).
 *
 * The whole point of this feature is the guarantees, so they are tested directly:
 *   - one browser counts once, no matter how many times it visits
 *   - active visitors expire on their own after the 30s window
 *   - duplicate tabs / refreshes never inflate the unique total
 *   - clearing localStorage still does not double-count (IP+UA fallback)
 *   - junk visitor ids are rejected instead of inflating the count
 *   - the count survives a restart because it is replayed from the log
 *
 * Run: node --test test/visitors.test.js  (part of `npm test`)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'azyron-visitors-'));

// The store reads its path/salt from config at import time, so set them first.
process.env.VISITORS_FILE = join(tmp, 'visitors.log');
process.env.VISITOR_SALT = 'test-salt';
process.env.ANALYTICS_FILE = join(tmp, 'downloads.log');

let store;

before(async () => {
  store = await import('../lib/visitors.js');
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // A hard reset for tests: empty log + empty memory. `resetForTests()` alone
  // replays the log by design (that is the restart guarantee), so tests that
  // need a blank slate must clear the file too.
  writeFileSync(process.env.VISITORS_FILE, '');
  store.resetForTests();
});

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

/* ------------------------------------------------------------ the guarantees */

test('a first-time visitor counts as exactly 1', () => {
  const result = store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  assert.equal(result.unique, 1);
  assert.equal(result.isNew, true);
  assert.equal(result.you, 1, 'the visitor is told they are #1');
});

test('refreshing or returning 100 times still counts as 1 unique visitor', () => {
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  for (let i = 0; i < 100; i += 1) {
    store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  }
  const totals = store.visitorTotals();
  assert.equal(totals.unique, 1, '100 repeat visits must not inflate the unique total');
});

test('ten tabs opening at once count as one visitor', () => {
  const results = Array.from({ length: 10 }, () =>
    store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' }),
  );
  assert.equal(store.visitorTotals().unique, 1);
  assert.equal(results.filter((r) => r.isNew).length, 1, 'only one tab is "new"');
});

test('two different browsers count as two unique visitors', () => {
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  store.recordVisit({ visitorId: ID_B, ip: '2.2.2.2', userAgent: 'Firefox' });
  const totals = store.visitorTotals();
  assert.equal(totals.unique, 2);
  assert.equal(totals.active, 2);
});

test('clearing localStorage does not double-count the same device', () => {
  // Same IP + User-Agent, brand-new id, and the client says the id is fresh
  // (storage was empty): the fingerprint fallback folds it back.
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  const afterClear = store.recordVisit({ visitorId: ID_B, ip: '1.1.1.1', userAgent: 'Chrome', fresh: true });
  assert.equal(afterClear.unique, 1, 'a cleared-storage revisit must not add a visitor');
  assert.equal(afterClear.isNew, false);
  assert.equal(afterClear.id, ID_A, 'the original id is reused');
});

test('a non-fresh new id is a real new visitor, even from the same IP', () => {
  // Two people behind one NAT on the same browser build both have stable,
  // non-fresh ids. Merging them would undercount real humans.
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  store.recordVisit({ visitorId: ID_B, ip: '1.1.1.1', userAgent: 'Chrome' });
  assert.equal(store.visitorTotals().unique, 2);
});

test('a different browser on the same IP counts separately', () => {
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  store.recordVisit({ visitorId: ID_B, ip: '1.1.1.1', userAgent: 'Firefox', fresh: true });
  assert.equal(store.visitorTotals().unique, 2, 'UA must be part of the fingerprint');
});

/* -------------------------------------------------------------- active window */

test('active visitors expire after 30 seconds of inactivity', () => {
  const t0 = 1_700_000_000_000;
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome', now: t0 });
  store.recordVisit({ visitorId: ID_B, ip: '2.2.2.2', userAgent: 'Firefox', now: t0 });

  // 29s later both are still active
  let totals = store.visitorTotals(t0 + 29_000);
  assert.equal(totals.active, 2);
  assert.equal(totals.unique, 2, 'expiring from active must not remove the unique record');

  // 31s with no heartbeat: both drop out of "active"
  totals = store.visitorTotals(t0 + 31_000);
  assert.equal(totals.active, 0);
  assert.equal(totals.unique, 2);

  // a heartbeat brings one back
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome', now: t0 + 31_000 });
  assert.equal(store.visitorTotals(t0 + 31_000).active, 1);
});

test('the active window is exactly 30 seconds', () => {
  assert.equal(store.ACTIVE_WINDOW_MS, 30_000);
});

test('unique is never smaller than active', () => {
  const t0 = 1_700_000_000_000;
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome', now: t0 });
  const totals = store.visitorTotals(t0 + 1000);
  assert.ok(totals.unique >= totals.active);
});

/* ------------------------------------------------------------ input validation */

test('malformed visitor ids are rejected rather than counted', () => {
  assert.equal(store.isValidVisitorId('short'), false);
  assert.equal(store.isValidVisitorId(''), false);
  assert.equal(store.isValidVisitorId(null), false);
  assert.equal(store.isValidVisitorId(12345), false);
  assert.equal(store.isValidVisitorId('has spaces in it and is long enough'), false);
  assert.equal(store.isValidVisitorId('a'.repeat(129)), false);
  assert.equal(store.isValidVisitorId('a'.repeat(32)), true);
  assert.equal(store.isValidVisitorId('AbC-123_xyz789012345678'), true);
});

test('the log never contains a raw IP address', () => {
  store.recordVisit({ visitorId: ID_A, ip: '203.0.113.77', userAgent: 'Chrome' });
  const raw = readFileSync(process.env.VISITORS_FILE, 'utf8');
  assert.ok(raw.includes(ID_A), 'the opaque visitor id is stored');
  assert.ok(!raw.includes('203.0.113.77'), 'the raw IP must not be written to disk');
});

/* ------------------------------------------------------------- persistence */

test('the count survives a restart because it is replayed from the log', () => {
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  store.recordVisit({ visitorId: ID_B, ip: '2.2.2.2', userAgent: 'Firefox' });
  assert.equal(store.visitorTotals().unique, 2);
  assert.ok(existsSync(process.env.VISITORS_FILE));

  // simulate a process restart: drop all in-memory state, replay the log
  store.resetForTests();
  assert.equal(store.visitorTotals().unique, 2, 'must be rebuilt from disk');
});

test('a corrupt log line does not lose the rest of the history', () => {
  store.recordVisit({ visitorId: ID_A, ip: '1.1.1.1', userAgent: 'Chrome' });
  store.recordVisit({ visitorId: ID_B, ip: '2.2.2.2', userAgent: 'Firefox' });
  store.resetForTests();
  appendFileSync(process.env.VISITORS_FILE, '{not json}\n');
  assert.equal(store.visitorTotals().unique, 2);
});
