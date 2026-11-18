/* =============================================================================
   AZYRON CLIENT — download event store

   One tiny module that defines the *contract* for shared download events, so the
   site has a single place to change when a first-party counter is introduced.

   WHY THERE ARE NO PER-EVENT ROWS TODAY
   -------------------------------------
   GitHub Pages is static hosting: it serves files and nothing else. It cannot
   accept a POST, so it cannot record "someone clicked download at 12:00:03".
   Writing such an event from the browser would also make it forgeable — anyone
   could fabricate download events with the developer console, which is exactly
   the "fake numbers" this project refuses to produce.

   So the authoritative download record is GitHub's own: GitHub increments
   `download_count` when a file is actually served from its release storage, and
   that count is shared by every visitor because it lives on GitHub's servers.

   THE CONTRACT
   ------------
   Normalised events, the shape `docs/data/download-events.json` carries and the
   shape a future writer must produce:

     {
       "id":       "757856668@2026-11-17T15:04:11Z",  // stable, dedupes
       "assetId":  757856668,
       "name":     "azyronclient-1.0.0.jar",
       "kind":     "jar" | "mrpack",
       "at":       "2026-11-17T15:04:11Z",            // ISO-8601 UTC
       "count":    1                                   // always 1 per event
     }

   `kind` is derived from the file extension by `eventKind()` so a writer cannot
   disagree with the site about which bucket an event belongs to.

   WHEN A REAL BACKEND ARRIVES
   ---------------------------
   Point an edge function (Cloudflare Worker / Vercel / Deno Deploy) at the same
   JSON shape, write rows to KV/D1/Postgres, and serve it with
   `Access-Control-Allow-Origin` for the site's origin. Then:

     • the site reads events instead of GitHub's counter;
     • the launch baseline becomes `{}` because counting starts at 0 by itself;
     • `loadEvents()` and `summariseEvents()` below already do the counting.

   Nothing else on the page has to change.
   ============================================================================= */

export const EVENTS_URL = './data/download-events.json';

/** Which counter bucket a file belongs to. */
export function eventKind(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.jar')) return 'jar';
  if (lower.endsWith('.mrpack')) return 'mrpack';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.apk')) return 'apk';
  return 'file';
}

/** Validate one raw event. Returns null for anything malformed. */
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = raw.at || raw.timestamp || raw.created_at;
  const when = new Date(at);
  if (!at || Number.isNaN(when.getTime())) return null;

  const name = String(raw.name || raw.asset || '');
  const kind = raw.kind && ['jar', 'mrpack'].includes(raw.kind) ? raw.kind : eventKind(name);

  const count = Number(raw.count);
  if (!(Number.isFinite(count) && count > 0)) return null;

  return {
    id: String(raw.id || `${raw.assetId || name}@${at}`),
    assetId: raw.assetId ?? raw.asset_id ?? null,
    name,
    kind,
    at: when.toISOString(),
    count,
  };
}

/** Parse a payload into validated events (drops junk instead of trusting it). */
export function parseEvents(payload) {
  const list = Array.isArray(payload) ? payload : payload?.events;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const event = normaliseEvent(raw);
    if (!event) continue;
    if (seen.has(event.id)) continue; // duplicate deliveries must not double-count
    seen.add(event.id);
    out.push(event);
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * Count events, optionally only those at or after `since`.
 * Returns the same {total, byKind} shape the rest of the site already uses.
 */
export function summariseEvents(events = [], { since = null, kinds = ['jar', 'mrpack'] } = {}) {
  const floor = since ? new Date(since).getTime() : -Infinity;
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  let total = 0;

  for (const event of events) {
    if (new Date(event.at).getTime() < floor) continue;
    if (!(event.kind in byKind)) continue;
    byKind[event.kind] += event.count;
    total += event.count;
  }

  return { total, byKind, count: events.length };
}

/** Fetch the shared event file. Never throws; an empty list is a valid answer. */
export async function loadEvents({ url = EVENTS_URL, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${url}?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) return { ok: false, events: [], status: response.status };
    const payload = await response.json();
    return { ok: true, events: parseEvents(payload), payload };
  } catch (error) {
    return { ok: false, events: [], error: String(error?.message || error) };
  }
}
