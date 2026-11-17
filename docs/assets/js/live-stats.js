/* =============================================================================
   AZYRON CLIENT — Live download statistics (pure logic)

   Everything in this module is side-effect free and unit tested in
   scripts/test-live-stats.mjs, so the section's behaviour can be verified
   without a browser.

   WHAT THE NUMBERS MEAN
   ---------------------
   • total  — GitHub's all-time download_count for that asset. It is the number
              a visitor recognises from the release page, and it is never
              modified by this site.
   • live   — downloads recorded *since this counter launched*. It is derived by
              counter.js as (live GitHub count − launch baseline), so it starts
              at 0 and every increment is a real, shared download.

   Nothing here invents a value. When a figure is unknown the module returns
   null and the UI shows an em dash rather than a made-up zero.
   ============================================================================= */

/** Format an integer with thousands separators. Unknown → em dash. */
export function formatCount(value, { locale = 'en-US' } = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Locale-tolerant parse of a rendered count, used to animate from whatever is
 * currently on screen (so a mid-animation refresh does not jump).
 */
export function parseCount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : 0;
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

/**
 * Fraction of the combined total contributed by one kind, 0…100.
 * Returns 0 for an empty total rather than dividing by zero.
 */
export function sharePercent(part, whole) {
  const p = Number(part) || 0;
  const w = Number(whole) || 0;
  if (w <= 0 || p <= 0) return 0;
  return Math.max(0, Math.min(100, (p / w) * 100));
}

/** Cubic ease-out — fast start, gentle settle. Matches the CSS timing. */
export function easeOutCubic(t) {
  const clamped = Math.max(0, Math.min(1, Number(t) || 0));
  return 1 - (1 - clamped) ** 3;
}

/** Interpolated value for a count-up animation. Rounds to whole downloads. */
export function interpolate(from, to, progress) {
  const a = Number(from) || 0;
  const b = Number(to) || 0;
  return Math.round(a + (b - a) * easeOutCubic(progress));
}

/**
 * How long a count-up should run.
 *
 * Small jumps settle instantly (a +1 should not feel laboured); large jumps get
 * a longer, more satisfying sweep — but never long enough to lag behind a
 * 1-second refresh, otherwise the number would still be moving when the next
 * value arrives.
 */
export function animationDuration(from, to, { max = 620, min = 180 } = {}) {
  const delta = Math.abs((Number(to) || 0) - (Number(from) || 0));
  if (delta === 0) return 0;
  const scaled = 220 + Math.log10(delta + 1) * 240;
  return Math.round(Math.max(min, Math.min(max, scaled)));
}

/**
 * "Updated just now" style label.
 *
 * The section is meant to answer "is this current?" at a glance, so anything
 * inside the refresh window reads as "just now" instead of "0s ago".
 */
export function relativeLabel(timestamp, now = Date.now(), { justNowMs = 3000 } = {}) {
  if (!timestamp) return 'waiting for first update';
  const then = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
  if (!Number.isFinite(then)) return 'waiting for first update';

  const delta = Math.max(0, now - then);
  if (delta < justNowMs) return 'Updated just now';

  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `Updated ${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;

  const days = Math.round(hours / 24);
  return `Updated ${days}d ago`;
}

/**
 * Badge state for the LIVE indicator.
 *
 * 'live'    — GitHub answered during this poll: genuinely current.
 * 'cached'  — GitHub could not be reached but we have real earlier numbers.
 * 'stale'   — numbers are older than the slow-poll ceiling.
 *
 * The badge is never allowed to say LIVE while the data is not.
 */
export function liveState({ ok = false, stale = false, ageMs = 0, maxAgeMs = 15_000 } = {}) {
  if (!ok) return 'offline';
  if (stale) return 'cached';
  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) return 'cached';
  return 'live';
}

export const LIVE_LABELS = {
  live: 'LIVE',
  cached: 'CACHED',
  offline: 'OFFLINE',
};

/**
 * Pick the asset that represents a card's file kind.
 *
 * Prefers an exact extension match. If a release ever ships several files of
 * the same kind we take the newest, so the card always points at a real file
 * rather than guessing a URL.
 */
export function pickAssetByKind(assets = [], kind = 'jar') {
  const suffix = `.${String(kind).toLowerCase()}`;
  const matches = assets.filter((asset) => String(asset?.name || '').toLowerCase().endsWith(suffix));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
}

/**
 * Assemble everything the section renders. One call per poll, so the DOM is
 * written from a single consistent snapshot.
 */
export function buildLiveModel(release, sinceLaunch, now = Date.now()) {
  const assets = release?.assets || [];
  const jar = pickAssetByKind(assets, 'jar');
  const mrpack = pickAssetByKind(assets, 'mrpack');

  const perAsset = new Map(
    (sinceLaunch?.perAsset || []).map((entry) => [String(entry.id), entry]),
  );
  const sinceFor = (asset) =>
    asset ? perAsset.get(String(asset.id))?.since ?? 0 : 0;

  const jarLive = sinceFor(jar);
  const mrpackLive = sinceFor(mrpack);
  const totalLive = sinceLaunch?.hasBaseline === false ? null : sinceLaunch?.total ?? 0;

  const fetchedAt = release?.fetchedAt ? new Date(release.fetchedAt).getTime() : null;
  const ageMs = fetchedAt ? Math.max(0, now - fetchedAt) : Number.POSITIVE_INFINITY;

  return {
    ok: Boolean(release?.ok),
    stale: Boolean(release?.stale),
    state: liveState({
      ok: Boolean(release?.ok),
      stale: Boolean(release?.stale),
      ageMs,
      maxAgeMs: 20_000,
    }),
    ageMs,
    fetchedAt,
    total: totalLive,
    totalAllTime:
      (jar?.downloads || 0) + (mrpack?.downloads || 0) || null,
    jar: {
      asset: jar,
      total: jar ? jar.downloads : null,
      live: jarLive,
      name: jar?.name || 'Not in this release',
      sizeLabel: jar?.sizeLabel || '—',
      share: sharePercent(jarLive, totalLive || 0),
    },
    mrpack: {
      asset: mrpack,
      total: mrpack ? mrpack.downloads : null,
      live: mrpackLive,
      name: mrpack?.name || 'Not in this release',
      sizeLabel: mrpack?.sizeLabel || '—',
      share: sharePercent(mrpackLive, totalLive || 0),
    },
    versionLabel: release?.version ? `v${release.version}` : '—',
  };
}
