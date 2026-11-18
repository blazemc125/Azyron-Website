/**
 * Unique-visitor and active-visitor store.
 *
 * WHAT IS COUNTED
 * ---------------
 *   • unique  — one row per distinct visitor, ever. Re-visiting, refreshing or
 *               opening ten tabs never adds another row, because insert is keyed
 *               by the visitor id (and, as a fallback, by a hash of IP+User-Agent
 *               so clearing storage does not inflate the count).
 *   • active  — distinct visitors seen within ACTIVE_WINDOW_MS (30s). A visitor
 *               expires from "active" by simply not being seen again; no delete
 *               job is needed to compute the number.
 *
 * PERSISTENCE
 * -----------
 * Append-only JSON-lines log next to the download analytics log. The file is the
 * source of truth: on boot the log is replayed into memory, so a restart or a
 * redeploy does not lose the count. Writes are serialised through a promise chain
 * so concurrent requests (ten tabs opening at once) cannot interleave rows.
 *
 * PRIVACY
 * -------
 * The store keeps a random id the browser generated plus a *salted hash* of
 * IP+User-Agent for fallback dedupe. Raw IP addresses are never written to disk.
 * No cookies are set and nothing here identifies a person.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

/** A visitor counts as "active" for this long after their last heartbeat. */
export const ACTIVE_WINDOW_MS = 30_000;

const logPath = resolve(config.visitorsFile);
const salt = config.visitorSalt || 'azyron-visitor-salt';

/** visitorId → { first, last, hits } */
const visitors = new Map();
/** salted IP+UA hash → visitorId (fallback dedupe for cleared storage) */
const fingerprints = new Map();

let loaded = false;

const hash = (value) => createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 32);

/**
 * A visitor id must look like an opaque token. Rejecting junk keeps the store
 * honest and stops a script from inflating the count with `1`, `2`, `3`…
 */
export function isValidVisitorId(value) {
  if (typeof value !== 'string') return false;
  const id = value.trim();
  if (id.length < 16 || id.length > 128) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/** Derive the fallback fingerprint. Raw IP/UA never leaves this function. */
export function visitorFingerprint(ip, userAgent) {
  return hash(`${ip || 'unknown'}|${(userAgent || '').slice(0, 200)}`);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(logPath)) return;
    const lines = readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || !row.id) continue;
        const first = row.first || row.at;
        const last = row.last || row.at;
        const existing = visitors.get(row.id);
        if (existing) {
          existing.last = last > existing.last ? last : existing.last;
          existing.hits += row.hits || 1;
          if (!existing.fp && row.fp) existing.fp = row.fp;
        } else {
          visitors.set(row.id, { first, last, hits: row.hits || 1, fp: row.fp || null });
        }
        if (row.fp && !fingerprints.has(row.fp)) fingerprints.set(row.fp, row.id);
      } catch {
        /* ignore corrupt lines rather than losing the whole log */
      }
    }
  } catch {
    /* a missing/unreadable log simply means zero visitors so far */
  }
}

/**
 * Append one row, synchronously.
 *
 * appendFileSync under a single-threaded event loop is already atomic with
 * respect to request handling, so a promise chain buys nothing here and does
 * cost something: it lets a write from one request land *after* the next
 * request has already read the file, which is exactly the kind of ordering
 * bug that double-counts. Write immediately instead.
 */
function append(row) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  } catch {
    /* never fail a page load because analytics could not be written */
  }
}

const inWindow = (last, now) => now - new Date(last).getTime() < ACTIVE_WINDOW_MS;

/** Count visitors seen inside the active window. Pure function of the store. */
export function activeCount(now = Date.now()) {
  let count = 0;
  for (const record of visitors.values()) {
    if (inWindow(record.last, now)) count += 1;
  }
  return count;
}

export function visitorTotals(now = Date.now()) {
  load();
  return {
    unique: visitors.size,
    active: activeCount(now),
    windowMs: ACTIVE_WINDOW_MS,
  };
}

/**
 * Record a heartbeat for a visitor.
 *
 * Idempotent for uniques: calling this a hundred times with the same id still
 * yields exactly one unique visitor. Returns whether this call was the visitor's
 * first ever sighting, so the UI can honestly say "you are visitor #N".
 */
export function recordVisit({ visitorId, ip, userAgent, fresh = false, now = Date.now() }) {
  load();

  const id = String(visitorId).trim();
  const at = new Date(now).toISOString();
  const fp = visitorFingerprint(ip, userAgent);

  // Fallback dedupe, deliberately narrow.
  //
  // The id is the source of truth: it is stable in localStorage, so it already
  // survives refreshes, revisits and multiple tabs. The IP+UA fingerprint is
  // used *only* when the browser tells us it just minted a brand-new id because
  // its storage was empty (`fresh`), and only onto a visitor we have seen from
  // that exact fingerprint before. Anything wider would silently merge two real
  // people sharing one NAT/corporate IP on the same browser build — an
  // undercount, and a wrong one.
  const known = visitors.has(id) || !fresh ? id : fingerprints.get(fp) || id;
  const resolvedId = known;

  const existing = visitors.get(resolvedId);
  const isNew = !existing;

  if (existing) {
    existing.last = at;
    existing.hits += 1;
    if (!existing.fp) existing.fp = fp;
  } else {
    visitors.set(resolvedId, { first: at, last: at, hits: 1, fp });
  }
  if (!fingerprints.has(fp)) fingerprints.set(fp, resolvedId);

  append({ id: resolvedId, fp, at, first: visitors.get(resolvedId).first, last: at, hits: visitors.get(resolvedId).hits });

  return {
    ...visitorTotals(now),
    isNew,
    you: isNew ? visitors.size : null,
    id: resolvedId,
    lastSeen: at,
    expiresAt: new Date(now + ACTIVE_WINDOW_MS).toISOString(),
  };
}

/** Test/maintenance helper: forget everything held in memory (log untouched). */
export function resetForTests() {
  visitors.clear();
  fingerprints.clear();
  loaded = false;
}

/** Compact the append-only log down to one row per visitor.
 *  Called by the server on an interval so the file cannot grow without bound. */
export function compactLog() {
  load();
  const rows = [];
  for (const [id, record] of visitors) {
    // One row per visitor: first/last sighting plus how many heartbeats were
    // folded in. `hits` is a lifetime tally, so it is carried over rather than
    // clamped — clamping it would quietly rewrite history.
    rows.push({ id, fp: record.fp, at: record.last, first: record.first, last: record.last, hits: record.hits });
  }
  const tmp = `${logPath}.tmp`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(tmp, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    renameSync(tmp, logPath);
  } catch {
    /* compaction is best effort */
  }
  return rows.length;
}
