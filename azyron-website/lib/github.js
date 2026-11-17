/**
 * GitHub release client with a process-wide, single-flight cache.
 *
 * Key guarantees
 * --------------
 * 1. All visitors share ONE upstream snapshot. The browser polls
 *    /api/release every 5s, but GitHub is only asked once per `cacheTtlMs`,
 *    and never more than once concurrently (single-flight).
 * 2. If GitHub is unreachable we keep serving the last known good snapshot,
 *    flagged `stale: true`, instead of breaking the page.
 * 3. Nothing is ever invented. If we have no live data AND no snapshot, the
 *    API reports an error and the UI shows an honest error state.
 *
 * Only release metadata that the site actually needs is exposed publicly —
 * we never forward GitHub's raw JSON (no uploader tokens, no useless noise).
 */

import { readFileSync, existsSync } from 'node:fs';
import { config, releaseHtmlUrl, repoHtmlUrl } from '../config.js';

const API = () => config.github.apiBase.replace(/\/$/, '');

let cache = { payload: null, expiresAt: 0, fetchedAt: 0, etag: null, lastModified: null };
let inFlight = null;
let rateLimit = { limit: null, remaining: null, reset: null };
let consecutiveFailures = 0;
let snapshot = null;

function loadSnapshot() {
  try {
    if (existsSync(config.fallbackFile)) {
      snapshot = JSON.parse(readFileSync(config.fallbackFile, 'utf8'));
    }
  } catch {
    snapshot = null;
  }
  return snapshot;
}

function authHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AzyronClientWebsite/1.0 (+https://github.com/blazemc125/AzyronClient)',
  };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;
  return headers;
}

export const humanFileSize = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

const assetKind = (name, contentType) => {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.jar')) return 'jar';
  if (lower.endsWith('.mrpack')) return 'mrpack';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.apk')) return 'apk';
  if (lower.endsWith('.7z')) return '7z';
  if (contentType) return 'binary';
  return 'file';
};

/** Map the GitHub release JSON onto the compact shape the UI consumes. */
export function normalizeRelease(raw) {
  const assets = (raw.assets || []).map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    sizeLabel: humanFileSize(asset.size),
    downloads: asset.download_count ?? 0,
    contentType: asset.content_type || 'application/octet-stream',
    kind: assetKind(asset.name, asset.content_type),
    updatedAt: asset.updated_at || null,
    // Kept so the server can stream the exact declared asset. Only the
    // /api/download/:assetId route is ever handed to the browser.
    browserDownloadUrl: asset.browser_download_url,
    apiUrl: asset.url,
  }));

  const totalDownloads = assets.reduce((sum, asset) => sum + (asset.downloads || 0), 0);

  return {
    ok: true,
    repo: `${config.github.owner}/${config.github.repo}`,
    repoUrl: repoHtmlUrl(),
    tag: raw.tag_name,
    version: String(raw.tag_name || '').replace(/^[a-zA-Z-]*?v/i, '') || raw.tag_name,
    name: raw.name || raw.tag_name,
    body: raw.body || '',
    publishedAt: raw.published_at,
    updatedAt: raw.updated_at || raw.published_at,
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    htmlUrl: raw.html_url || releaseHtmlUrl(),
    assets,
    totals: {
      downloads: totalDownloads,
      files: assets.length,
      size: assets.reduce((sum, asset) => sum + (asset.size || 0), 0),
    },
    rateLimit,
    fetchedAt: null, // filled by the cache layer
    stale: false,
    source: 'github',
  };
}

function backoffTtl() {
  if (consecutiveFailures <= 1) return config.errorCacheTtlMs;
  return Math.min(config.errorCacheTtlMs * 2 ** (consecutiveFailures - 1), 30_000);
}

async function fetchRelease() {
  const { owner, repo, tag } = config.github;
  const url = `${API()}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      headers: authHeaders(),
      signal: controller.signal,
    });

    const rl = {
      limit: Number(response.headers.get('x-ratelimit-limit')) || null,
      remaining: Number(response.headers.get('x-ratelimit-remaining')) || null,
      reset: Number(response.headers.get('x-ratelimit-reset')) || null,
    };
    if (rl.limit) rateLimit = rl;

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const err = new Error(
        response.status === 404
          ? `Release "${tag}" was not found in ${owner}/${repo}.`
          : `GitHub API responded with ${response.status}.`,
      );
      err.status = response.status;
      err.detail = detail.slice(0, 400);
      throw err;
    }

    const raw = await response.json();
    return normalizeRelease(raw);
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('GitHub API request timed out.');
      err.status = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return the shared release snapshot, refreshing it at most once per TTL.
 * Concurrent callers await the same in-flight request.
 */
export async function getRelease({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.payload && now < cache.expiresAt) {
    return { ...cache.payload, fetchedAt: new Date(cache.fetchedAt).toISOString() };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const fresh = await fetchRelease();
      consecutiveFailures = 0;
      const fetchedAt = Date.now();
      cache = {
        payload: fresh,
        expiresAt: fetchedAt + config.cacheTtlMs,
        fetchedAt,
        etag: null,
        lastModified: null,
      };
      rateLimit = fresh.rateLimit;
      return { ...fresh, fetchedAt: new Date(fetchedAt).toISOString() };
    } catch (error) {
      consecutiveFailures += 1;
      const last = cache.payload || (snapshot ? normalizeRelease(snapshot) : null);

      if (last) {
        // Serve the last known good data so the site keeps working.
        cache.expiresAt = Date.now() + backoffTtl();
        return {
          ...last,
          fetchedAt: new Date(cache.fetchedAt || Date.now()).toISOString(),
          stale: true,
          source: cache.payload ? 'cache' : 'snapshot',
          warning: error.message,
        };
      }

      cache.expiresAt = Date.now() + backoffTtl();
      return {
        ok: false,
        error: error.message,
        status: error.status || 502,
        repo: `${config.github.owner}/${config.github.repo}`,
        repoUrl: repoHtmlUrl(),
        tag: config.github.tag,
        htmlUrl: releaseHtmlUrl(),
        assets: [],
        totals: { downloads: 0, files: 0, size: 0 },
        fetchedAt: new Date().toISOString(),
        stale: true,
        source: 'none',
      };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// ---------------------------------------------------------------------------
// Release history (used by the Changelog section)
// ---------------------------------------------------------------------------
let historyCache = { payload: null, expiresAt: 0 };
let historyInFlight = null;
const HISTORY_TTL_MS = 60_000;

export async function getReleaseHistory() {
  if (historyCache.payload && Date.now() < historyCache.expiresAt) return historyCache.payload;
  if (historyInFlight) return historyInFlight;

  historyInFlight = (async () => {
    const { owner, repo } = config.github;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`${API()}/repos/${owner}/${repo}/releases?per_page=20`, {
        headers: authHeaders(),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) throw new Error(`GitHub API responded with ${response.status}.`);
      const list = await response.json();
      const payload = {
        ok: true,
        releases: list.map((raw) => {
          const normalized = normalizeRelease(raw);
          return {
            tag: normalized.tag,
            version: normalized.version,
            name: normalized.name,
            body: normalized.body,
            publishedAt: normalized.publishedAt,
            prerelease: normalized.prerelease,
            htmlUrl: normalized.htmlUrl,
            totals: normalized.totals,
            assets: normalized.assets.map((asset) => ({ name: asset.name, size: asset.size, downloads: asset.downloads, kind: asset.kind })),
          };
        }),
        fetchedAt: new Date().toISOString(),
      };
      historyCache = { payload, expiresAt: Date.now() + HISTORY_TTL_MS };
      return payload;
    } catch (error) {
      if (historyCache.payload) {
        return { ...historyCache.payload, stale: true, warning: error.message };
      }
      return { ok: false, error: error.message, releases: [], fetchedAt: new Date().toISOString() };
    } finally {
      historyInFlight = null;
    }
  })();

  return historyInFlight;
}

/** Look up one asset inside the shared snapshot (used by the download proxy). */
export async function findAsset(assetId) {
  const release = await getRelease();
  if (!release.ok) return { release, asset: null };
  const asset = release.assets.find((item) => String(item.id) === String(assetId));
  return { release, asset: asset || null };
}

export function cacheStats() {
  return {
    cachedUntil: cache.expiresAt ? new Date(cache.expiresAt).toISOString() : null,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    ttlMs: config.cacheTtlMs,
    rateLimit,
    consecutiveFailures,
    hasSnapshot: Boolean(snapshot || loadSnapshot()),
  };
}

export function primeSnapshot() {
  loadSnapshot();
  return snapshot;
}

// Warm the cache at boot so the first visitor never waits for GitHub.
primeSnapshot();
getRelease().catch(() => {});
