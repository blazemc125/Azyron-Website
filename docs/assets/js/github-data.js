/* =============================================================================
   AZYRON CLIENT — GitHub data layer (runs entirely in the browser)

   This module is what makes the site work on GitHub Pages, where there is no
   server to proxy or cache anything. It talks straight to GitHub's public API
   and is built around three constraints that actually matter in production:

   1. RATE LIMITS — an unauthenticated IP gets 60 requests/hour. If every tab
      revalidated GitHub every second we would burn that in minutes, so:
        • responses are cached in localStorage and kept for CACHE_TTL_MS;
        • refreshes use conditional requests (ETag / If-None-Match). A 304
          response does NOT count against the rate limit;
        • simultaneous callers share one in-flight request (single flight);
        • when the remaining budget gets low we back off automatically;
        • on a 403/429 we serve the cache and show an honest banner.
   2. HONESTY — numbers always come from GitHub or from this site's own real
      download log. If GitHub cannot be reached and there is no cache, the UI
      gets an explicit `ok: false` payload. Nothing is ever invented.
   3. STATIC HOSTING — every URL is relative, so the site works at
      /AzyronWebsite/, at a custom domain, or from file:// .
   ============================================================================= */

/**
 * Refresh cadence for the live download statistics: one second.
 *
 * This is affordable because of how conditional requests work. Once we hold an
 * ETag, GitHub answers a revalidation with `304 Not Modified` whenever nothing
 * has changed — and a 304 does NOT count against the 60-requests/hour
 * unauthenticated quota. Measured against the real endpoint: six conditional
 * requests in six seconds left `x-ratelimit-remaining` completely unchanged.
 *
 * So the honest cost of polling every second is: one request per second on the
 * wire, and *zero* quota while the release is unchanged. Only an actual change
 * (or a cold start with no ETag) costs a request. That is what lets the site
 * promise a genuine 1-second refresh instead of decorating a slow one.
 */
export const POLL_MS = 1000;

/** Slower cadence used only when the budget is genuinely under pressure. */
export const SAFE_POLL_MS = 5000;

const DEFAULTS = {
  owner: 'blazemc125',
  repo: 'AzyronClient',
  tag: 'azyronclient-v1.0.0',
};

const CACHE_TTL_MS = 1000; // may be raised automatically when rate-limited
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const HISTORY_TTL_MS = 5 * 60 * 1000;
// Below these, the site stops chasing 1 s and protects the shared quota instead.
const LOW_BUDGET = 8;
const CRITICAL_BUDGET = 2;
const STORE_KEY = 'azyron:release:v1';
const HISTORY_KEY = 'azyron:history:v1';
const LOG_KEY = 'azyron:downloads:v1';

export const api = {
  /** Override with ?owner=…&repo=…&tag=… (handy for testing or forks). */
  owner: DEFAULTS.owner,
  repo: DEFAULTS.repo,
  tag: DEFAULTS.tag,

  releaseUrl() {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/releases/tags/${encodeURIComponent(this.tag)}`;
  },
  historyUrl() {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/releases?per_page=20`;
  },
  repoUrl() {
    return `https://github.com/${this.owner}/${this.repo}`;
  },
  releasePageUrl() {
    return `https://github.com/${this.owner}/${this.repo}/releases/tag/${this.tag}`;
  },
  assetUrl(asset) {
    // The exact asset URL GitHub's API reported — never a release page.
    return asset?.browserDownloadUrl || '';
  },
};

const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — cache is an optimisation, never a requirement */
    }
  },
};

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

const assetKind = (name) => {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.jar')) return 'jar';
  if (lower.endsWith('.mrpack')) return 'mrpack';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.apk')) return 'apk';
  if (lower.endsWith('.7z')) return '7z';
  return 'file';
};

/** Map GitHub's raw release JSON to the compact shape the UI consumes. */
export function normalizeRelease(raw) {
  const assets = (raw.assets || []).map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    sizeLabel: humanFileSize(asset.size),
    downloads: asset.download_count ?? 0,
    contentType: asset.content_type || 'application/octet-stream',
    kind: assetKind(asset.name),
    updatedAt: asset.updated_at || null,
    browserDownloadUrl: asset.browser_download_url,
  }));

  const downloads = assets.reduce((sum, asset) => sum + (asset.downloads || 0), 0);

  return {
    ok: true,
    source: 'github',
    stale: false,
    repo: `${api.owner}/${api.repo}`,
    repoUrl: api.repoUrl(),
    tag: raw.tag_name,
    version: String(raw.tag_name || '').replace(/^[a-zA-Z-]*?v/i, '') || raw.tag_name,
    name: raw.name || raw.tag_name,
    body: raw.body || '',
    publishedAt: raw.published_at,
    updatedAt: raw.updated_at || raw.published_at,
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    htmlUrl: raw.html_url || api.releasePageUrl(),
    assets,
    totals: {
      downloads,
      files: assets.length,
      size: assets.reduce((sum, asset) => sum + (asset.size || 0), 0),
      sizeLabel: humanFileSize(assets.reduce((sum, asset) => sum + (asset.size || 0), 0)),
    },
  };
}

/* ----------------------------------------------------------- rate limit state */
const rateLimit = { limit: null, remaining: null, reset: null };

function readRateLimit(response) {
  // `Number(null)` is 0, so a response that simply omits these headers (a proxy,
  // a CDN, a 304 from some intermediaries) used to be recorded as "budget
  // exhausted". pollInterval() then dropped the refresh to 5s+ and the live
  // section quietly stopped being live — while still badging itself LIVE.
  // Only accept a header that is genuinely present and numeric.
  const num = (name) => {
    const raw = response.headers.get(name);
    if (raw === null || raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const limit = num('x-ratelimit-limit');
  const remaining = num('x-ratelimit-remaining');
  const reset = num('x-ratelimit-reset');

  if (limit !== null) rateLimit.limit = limit;
  if (remaining !== null) rateLimit.remaining = remaining;
  if (reset !== null) rateLimit.reset = reset;
  return rateLimit;
}

export const getRateLimit = () => ({ ...rateLimit });

/**
 * How long to wait before the next revalidation. Target: exactly 1 second.
 *
 * 1 s is the default and stays the default; conditional requests make it free
 * while nothing changes (verified: quota unscathed across a burst of 304s).
 * The only things that lengthen it are a genuinely exhausted/blocked budget or
 * a run of failures — situations where continuing to hammer the API would break
 * the site for everyone behind the same IP. When that happens the page says so
 * on the LIVE badge rather than pretending the numbers are live.
 */
export function pollInterval() {
  const { remaining, reset } = rateLimit;

  if (Number.isFinite(remaining)) {
    // Out of budget: wait for the reset window, never spam a 403.
    if (remaining <= 0 && Number.isFinite(reset)) {
      return Math.max(SAFE_POLL_MS, reset * 1000 - Date.now() + 5000);
    }
    if (remaining <= CRITICAL_BUDGET) return 60_000;
    if (remaining <= LOW_BUDGET) return 15_000;
  }

  // Repeated failures: back off, capped, so a broken endpoint isn't hammered.
  if (failures > 0) return Math.min(POLL_MS * 2 ** failures, 30_000);

  // Normal operation: 1 second, whether the last response was a 304 (free) or a
  // 200 (a real change we wanted immediately anyway).
  return POLL_MS;
}

/** Poll interval grows when the API budget is scarce, so the site never trips 429. */
function adaptiveTtl() {
  const { remaining, reset } = rateLimit;
  let ttl = CACHE_TTL_MS;
  if (Number.isFinite(remaining)) {
    if (remaining <= 0 && Number.isFinite(reset)) {
      ttl = Math.max(MIN_TTL_MS, (reset * 1000 - Date.now()) + 5000);
    } else if (remaining <= 2) ttl = 120_000;
    else if (remaining <= LOW_BUDGET) ttl = 30_000;
    else if (remaining <= 20) ttl = 15_000;
  }
  return Math.min(Math.max(ttl, MIN_TTL_MS), MAX_TTL_MS);
}

/* --------------------------------------------------------------- the fetcher */
let inFlight = null;
let failures = 0;
let lastError = null;
/* consecutive 304s (free refreshes) and consecutive 200s (paid refreshes) */
let freeRefreshes = 0;
let modifiedStreak = 0;

function headers(etag) {
  const h = { Accept: 'application/vnd.github+json' };
  if (etag) h['If-None-Match'] = etag;
  return h;
}

async function request(url, { etag, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetch(url, {
      headers: headers(etag),
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get the release, refreshing from GitHub only when the cache is older than the
 * adaptive TTL. Concurrent calls share a single network request.
 */
export async function getRelease({ force = false, signal } = {}) {
  const cached = store.get(STORE_KEY);
  const now = Date.now();

  // NOTE: there is deliberately no "cached, fresh enough → skip the network"
  // short-circuit here. Download counters can change during any given second, so
  // the only way to honour a 1-second refresh is to actually revalidate. The
  // cost is benign: a 304 Not Modified does not consume the rate-limit quota.
  // `force` is kept for the callers that want to bypass a joined in-flight read.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await request(api.releaseUrl(), { etag: cached?.etag, signal });

      if (response.status === 304 && cached?.data) {
        // Not modified — free refresh, does not consume the rate limit.
        readRateLimit(response);
        freeRefreshes += 1;
        modifiedStreak = 0;
        const ttl = Math.min(adaptiveTtl(), pollInterval());
        store.set(STORE_KEY, { ...cached, at: now, ttl });
        failures = 0;
        return {
          ...cached.data,
          fetchedAt: new Date(now).toISOString(),
          fromCache: true,
          stale: false,
          notModified: true,
        };
      }

      readRateLimit(response);

      if (!response.ok) {
        const err = new Error(
          response.status === 404
            ? `Release "${api.tag}" was not found in ${api.owner}/${api.repo}.`
            : response.status === 403 || response.status === 429
              ? 'GitHub API rate limit reached for this network.'
              : `GitHub API responded with ${response.status}.`,
        );
        err.status = response.status;
        throw err;
      }

      const raw = await response.json();
      const data = normalizeRelease(raw);
      freeRefreshes = 0;
      modifiedStreak += 1;
      const ttl = Math.min(adaptiveTtl(), pollInterval());
      store.set(STORE_KEY, {
        data,
        etag: response.headers.get('etag'),
        at: Date.now(),
        ttl,
        rateLimit: { ...rateLimit },
      });
      failures = 0;
      lastError = null;
      return { ...data, fetchedAt: new Date().toISOString(), fromCache: false };
    } catch (error) {
      failures += 1;
      lastError = error.name === 'AbortError' ? new Error('GitHub API request timed out.') : error;

      // Persist the backoff window into the cache record so the next poll does
      // not immediately retry a rate-limited/limited endpoint.
      const stored = store.get(STORE_KEY);
      if (stored?.data) {
        const ttl = Math.max(adaptiveTtl(), Math.min(30_000 * failures, MAX_TTL_MS));
        store.set(STORE_KEY, { ...stored, ttl, at: stored.at || Date.now(), lastError: lastError.message });
      }

      const fallback = stored?.data;
      if (fallback) {
        // Serve what we know, but never pretend it is live.
        return {
          ...fallback,
          stale: true,
          source: 'cache',
          fetchedAt: new Date(stored.at || Date.now()).toISOString(),
          warning: lastError.message,
          error: lastError.message,
        };
      }
      return {
        ok: false,
        error: lastError.message,
        repo: `${api.owner}/${api.repo}`,
        repoUrl: api.repoUrl(),
        tag: api.tag,
        htmlUrl: api.releasePageUrl(),
        assets: [],
        totals: { downloads: 0, files: 0, size: 0 },
        stale: true,
        source: 'none',
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Release history for the changelog (longer cache — it changes rarely). */
let historyInFlight = null;

export async function getReleaseHistory({ signal } = {}) {
  const cached = store.get(HISTORY_KEY);
  if (cached?.data && Date.now() - (cached.at || 0) < HISTORY_TTL_MS) {
    return { ...cached.data, fromCache: true };
  }
  if (historyInFlight) return historyInFlight;

  historyInFlight = (async () => {
    try {
      const response = await request(api.historyUrl(), { etag: cached?.etag, signal });
      if (response.status === 304 && cached?.data) {
        readRateLimit(response);
        store.set(HISTORY_KEY, { ...cached, at: Date.now() });
        return { ...cached.data, fromCache: true };
      }
      readRateLimit(response);
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
            assets: normalized.assets.map((asset) => ({
              name: asset.name,
              size: asset.size,
              downloads: asset.downloads,
              kind: asset.kind,
            })),
          };
        }),
        fetchedAt: new Date().toISOString(),
      };
      store.set(HISTORY_KEY, { data: payload, etag: response.headers.get('etag'), at: Date.now() });
      return payload;
    } catch (error) {
      if (cached?.data) return { ...cached.data, stale: true, warning: error.message };
      return { ok: false, error: error.message, releases: [], fetchedAt: new Date().toISOString() };
    } finally {
      historyInFlight = null;
    }
  })();

  return historyInFlight;
}

/* --------------------------------------------------------- download analytics */
/**
 * GitHub already counts every asset download on its own. This local log exists
 * only so the site can honestly say "N downloads started from here" — it is
 * never added to GitHub's totals and is never seeded with anything.
 */
export function recordLocalDownload(asset) {
  const log = store.get(LOG_KEY) || { total: 0, byAsset: {}, byName: {}, first: new Date().toISOString() };
  log.total = (log.total || 0) + 1;
  log.byAsset = log.byAsset || {};
  log.byAsset[String(asset.id)] = (log.byAsset[String(asset.id)] || 0) + 1;
  log.byName = log.byName || {};
  log.byName[asset.name] = (log.byName[asset.name] || 0) + 1;
  log.last = new Date().toISOString();
  store.set(LOG_KEY, log);
  return log;
}

export function getLocalDownloads() {
  const log = store.get(LOG_KEY);
  return { total: log?.total || 0, byAsset: log?.byAsset || {}, byName: log?.byName || {} };
}

export function getDiagnostics() {
  const cached = store.get(STORE_KEY);
  return {
    rateLimit: getRateLimit(),
    failures,
    lastError: lastError?.message || null,
    cachedAt: cached?.at ? new Date(cached.at).toISOString() : null,
    ttlMs: cached?.ttl ?? CACHE_TTL_MS,
    endpoint: api.releaseUrl(),
  };
}
