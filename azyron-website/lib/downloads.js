/**
 * Download analytics.
 *
 * Two independent, *real* numbers are surfaced by the site:
 *  - per-asset download counts coming straight from GitHub's API, and
 *  - how many downloads this website itself has proxied (an append-only
 *    JSON-lines log written by the server).
 *
 * Nothing here is a fake counter: if the log is empty the site shows no
 * "served by this site" figure at all.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

const logPath = resolve(config.analyticsFile);
const totals = { all: 0, byAsset: new Map(), byName: new Map() };
let loaded = false;

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
        totals.all += 1;
        if (row.assetId) totals.byAsset.set(String(row.assetId), (totals.byAsset.get(String(row.assetId)) || 0) + 1);
        if (row.name) totals.byName.set(row.name, (totals.byName.get(row.name) || 0) + 1);
      } catch {
        /* ignore corrupt lines */
      }
    }
  } catch {
    /* log is best-effort only */
  }
}

export function recordDownload({ assetId, name, bytes, userAgent, referer }) {
  load();
  totals.all += 1;
  totals.byAsset.set(String(assetId), (totals.byAsset.get(String(assetId)) || 0) + 1);
  if (name) totals.byName.set(name, (totals.byName.get(name) || 0) + 1);

  const row = {
    at: new Date().toISOString(),
    assetId,
    name: name || null,
    bytes: bytes ?? null,
    ua: (userAgent || '').slice(0, 160),
    referer: (referer || '').slice(0, 160),
  };

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  } catch {
    /* never fail a download because analytics could not be written */
  }
}

export function downloadTotals() {
  load();
  return {
    proxied: totals.all,
    byAssetId: Object.fromEntries(totals.byAsset),
    byName: Object.fromEntries(totals.byName),
  };
}
