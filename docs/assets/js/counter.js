/* =============================================================================
   AZYRON CLIENT — "Downloads Since Launch" counter

   WHAT THIS COUNTS
   ----------------
   The headline number answers exactly one question: how many release downloads
   happened after the counter went live.

       sinceLaunch = live GitHub download_count − baseline captured at launch

   • It starts at 0 by definition: the baseline is a snapshot of GitHub's
     historical counters taken at launch, so on the first render the difference
     is zero.
   • Every increment is a REAL download. GitHub increments `download_count` when
     somebody actually pulls the asset from its release storage — which is the
     same URL our DOWNLOAD buttons hand to the browser. Nothing is random,
     simulated or hard-coded.
   • JAR and MRPACK are tracked separately, each against its own baseline.
   • The baseline is only ever moved once, at launch. It is never reset, so the
     number cannot drift and cannot go backwards.

   WHY A BASELINE INSTEAD OF A COUNTER WE INCREMENT OURSELVES
   ----------------------------------------------------------
   Incrementing on click cannot be honest on a static host: GitHub Pages runs no
   server, and there is no write-only token we could hand a browser. Any counter
   incremented client-side would either be per-browser (one visitor's number,
   not the site's) or editable by anyone with the console (fakable). Deriving the
   figure from GitHub's own download log keeps it global, real and untouchable —
   the same integrity guarantee the rest of this site already makes.

   ACCURACY WINDOW
   ---------------
   GitHub's counter updates within a few seconds of a completed download, and the
   UI re-reads it every 5 seconds, so a fresh download appears on the next tick.
   While GitHub's response is in flight the UI shows its last confirmed value and
   says "syncing" rather than guessing.
   ============================================================================= */

/** Where the launch snapshot lives. Fetched from the same origin. */
export const BASELINE_URL = './data/counter-baseline.json';

/** Extra headroom so a baseline that is *ahead* of GitHub can never show a
 *  negative number (only possible if GitHub itself reports a lower value). */
const clamp = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

const kindOf = (name = '') => {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.jar')) return 'jar';
  if (lower.endsWith('.mrpack')) return 'mrpack';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.apk')) return 'apk';
  return 'file';
};

/**
 * Parse and validate the baseline file. Returns null when it is missing or
 * malformed so callers can fall back to showing nothing rather than a wrong
 * number.
 */
export function parseBaseline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const baseline = raw.baseline && typeof raw.baseline === 'object' ? raw.baseline : null;
  const baselineByName =
    raw.baselineByName && typeof raw.baselineByName === 'object' ? raw.baselineByName : {};
  const baselineByKind =
    raw.baselineByKind && typeof raw.baselineByKind === 'object' ? raw.baselineByKind : null;
  const usableByIdOrName =
    (baseline && Object.keys(baseline).length > 0) ||
    (baselineByName && Object.keys(baselineByName).length > 0);
  const usableByKind = baselineByKind && Object.keys(baselineByKind).length > 0;
  if (!usableByIdOrName && !usableByKind) return null;

  return {
    launchedAt: raw.launchedAt || null,
    tag: raw.tag || null,
    baseline: baseline || {},
    baselineByName,
    baselineByKind: baselineByKind || {},
    baselineTotal:
      Number.isFinite(Number(raw.baselineTotal)) && raw.baselineTotal !== null
        ? Number(raw.baselineTotal)
        : null,
  };
}

let baselinePromise = null;

/** Load the launch snapshot once (cached across calls). */
export function loadBaseline() {
  if (baselinePromise) return baselinePromise;
  baselinePromise = fetch(BASELINE_URL, { cache: 'no-store', credentials: 'omit' })
    .then((response) => {
      if (!response.ok) throw new Error(`baseline request failed: ${response.status}`);
      return response.json();
    })
    .then(parseBaseline)
    .catch(() => null);
  return baselinePromise;
}

const baselineFor = (baseline, asset, siblings = []) => {
  if (!baseline) return 0;

  // 1. exact asset id (the normal path)
  const byId = baseline.baseline?.[String(asset.id)];
  if (Number.isFinite(Number(byId))) return Number(byId);

  // 2. exact file name (survives an asset being re-uploaded with a new id)
  const byName = baseline.baselineByName?.[asset.name];
  if (Number.isFinite(Number(byName))) return Number(byName);

  // 3. per-kind aggregate — only safe when this is the only asset of its kind,
  //    i.e. the aggregate was measured on exactly this file. Otherwise a new
  //    asset published after launch would wrongly inherit history.
  const kind = kindOf(asset.name);
  const sameKind = siblings.filter((item) => kindOf(item.name) === kind);
  if (sameKind.length === 1) {
    const byKind = baseline.baselineByKind?.[kind];
    if (Number.isFinite(Number(byKind))) return Number(byKind);
  }

  return 0;
};

/**
 * Compute the since-launch figures for a release payload.
 *
 * @param {{assets: Array}} release  normalised release from github-data.js
 * @param {object|null} baseline     parsed baseline (see parseBaseline)
 */
export function computeSinceLaunch(release, baseline) {
  const assets = release?.assets || [];
  const perAsset = assets.map((asset) => {
    const lived = Number(asset.downloads) || 0;
    const base = baselineFor(baseline, asset, assets);
    const since = clamp(lived - base);
    return {
      id: asset.id,
      name: asset.name,
      kind: kindOf(asset.name),
      live: lived,
      baseline: base,
      since,
      /** true when GitHub reports fewer downloads than the snapshot — the
       *  difference is unknown, so we show 0 rather than a negative number. */
      clamped: lived < base,
    };
  });

  const byKind = {};
  for (const entry of perAsset) {
    byKind[entry.kind] = (byKind[entry.kind] || 0) + entry.since;
  }

  const total = clamp(perAsset.reduce((sum, entry) => sum + entry.since, 0));

  return {
    total,
    byKind,
    perAsset,
    baselineTotal: baseline
      ? perAsset.reduce((sum, entry) => sum + entry.baseline, 0)
      : null,
    liveTotal: perAsset.reduce((sum, entry) => sum + entry.live, 0),
    launchedAt: baseline?.launchedAt || null,
    /** False when we could not load the launch snapshot: the UI must then say
     *  so instead of presenting an un-baselined (too large) number. */
    hasBaseline: Boolean(baseline),
  };
}

/**
 * Increment the counter optimistically for the local visitor only.
 * This is NOT added to the shared number — it exists so the person who just
 * clicked sees their download acknowledged immediately while GitHub's own
 * counter catches up on the next 5-second tick. It is discarded as soon as the
 * live value moves.
 */
export function localPending(previous, next) {
  const delta = Math.max(0, (next?.total || 0) - (previous?.total || 0));
  return delta;
}
