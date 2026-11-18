/**
 * Unique + active visitor counter (browser side).
 *
 * TWO DIFFERENT NUMBERS — never merged:
 *   • TOTAL UNIQUE VISITORS — everyone who has ever opened the site, counted
 *     once per browser. Lifetime, monotonic.
 *   • LIVE ACTIVE VISITORS  — distinct visitors whose last heartbeat is inside
 *     the 30s window. Goes up and down, and decays to 0 when everyone leaves.
 *
 * WHY THERE IS A BACKEND
 * A shared total cannot live in localStorage or a static file: GitHub Pages is
 * read-only, so every visitor would see only their own number. The total lives
 * in the Express service in `azyron-website/` (`POST/GET /api/visits`) which
 * persists it to disk. This module only reads and renders what that service
 * reports, so the figures can never be invented in the browser.
 *
 * WHAT KEEPS THE COUNT HONEST ACROSS TABS
 *   1. The visitor id is stable in localStorage, so refreshes and revisits are
 *      the same visitor.
 *   2. Heartbeats are only sent by the *leader* tab, elected through
 *      BroadcastChannel + localStorage leases. Ten tabs produce one heartbeat.
 *   3. The server is idempotent for uniques anyway, so even a duplicated
 *      heartbeat cannot inflate the total.
 */

/**
 * Where the visitor service lives.
 *
 * Resolution order:
 *   1. ?api=…      — explicit override (used by the test harness)
 *   2. <meta name="azyron:api" content="…">  — set this to the deployed API URL
 *   3. same origin — when the Express app itself is serving these pages
 *   4. null        — GitHub Pages with no backend configured
 *
 * Case 4 is NOT papered over with a plausible-looking hostname: a made-up API
 * URL would produce either a broken counter or, worse, numbers nobody can
 * verify. The panel says so instead.
 */
const API_BASE = (() => {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery) return fromQuery.replace(/\/$/, '');
  const meta = document.querySelector('meta[name="azyron:api"]');
  if (meta && meta.content.trim()) return meta.content.trim().replace(/\/$/, '');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (location.protocol.startsWith('http') && (!/\.github\.io$/.test(location.hostname) || local)) return '';
  return null;
})();

const VISITS_URL = API_BASE === null ? null : `${API_BASE}/api/visits`;
const STORAGE_KEY = 'azyron:vid';
const LEASE_KEY = 'azyron:visitor-lease';
const CHANNEL_NAME = 'azyron-visitors';

/** Poll cadence while the page is visible: the requirement is 1 second. */
const POLL_MS = 1000;
/** Heartbeat cadence. Must stay well under the server's 30s active window. */
const HEARTBEAT_MS = 10_000;
/** Backoff ceiling when the API is unreachable. */
const MAX_BACKOFF_MS = 30_000;
const LEASE_MS = 6_000;

const els = {
  root: document.getElementById('visitors'),
  unique: document.getElementById('visitorUnique'),
  active: document.getElementById('visitorActive'),
  status: document.getElementById('visitorStatus'),
  statusText: document.getElementById('visitorStatusText'),
  note: document.getElementById('visitorNote'),
  retry: document.getElementById('visitorRetry'),
  uniqueSub: document.getElementById('visitorUniqueSub'),
  activeSub: document.getElementById('visitorActiveSub'),
};


/* ------------------------------------------------------------------ visitor id */

function randomId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  } catch {
    /* fall through to getRandomValues */
  }
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    /* last resort: still opaque, still not guessable in practice */
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Read the stable visitor id, minting one only when there is genuinely none.
 * `fresh` tells the API that storage was empty, which is the only situation
 * where its IP+User-Agent fallback should look for a previous identity (cleared
 * storage must not become a second visitor). It is stored fleet-wide so the flag
 * survives a reload.
 */
function loadIdentity() {
  let id = null;
  let fresh = false;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked (private mode / third-party context) */
  }
  if (!id || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
    id = randomId();
    fresh = true;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* the id still works for this page view */
    }
  }
  return { id, fresh };
}

/* ------------------------------------------------------- one heartbeat, ever */

/**
 * Elect a single heartbeat owner among this origin's tabs.
 *
 * BroadcastChannel alone is racy on first load (nobody is listening yet), so a
 * localStorage lease is the tie-breaker: whoever writes it first owns the
 * heartbeat, and every other tab stays read-only until the lease expires.
 */
const channel = (() => {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    return null;
  }
})();

function claimLease(now = Date.now()) {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (raw) {
      const lease = JSON.parse(raw);
      // A live lease owned by another tab keeps us in the passenger seat.
      if (lease && lease.until > now) return false;
    }
    localStorage.setItem(LEASE_KEY, JSON.stringify({ until: now + LEASE_MS, at: now }));
    return true;
  } catch {
    // No storage coordination available (private mode): one heartbeat per tab is
    // still safe, because the server dedupes by visitor id.
    return true;
  }
}

function releaseLease() {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return;
    const lease = JSON.parse(raw);
    if (lease && Date.now() < lease.until) {
      localStorage.setItem(LEASE_KEY, JSON.stringify({ until: 0, at: 0 }));
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- rendering */

const state = {
  identity: loadIdentity(),
  unique: null,
  active: null,
  lastOkAt: 0,
  failures: 0,
  paused: false,
  timer: null,
  heartbeatTimer: null,
  painted: { unique: null, active: null },
};

const fmt = new Intl.NumberFormat('en-US');

function paintNumber(el, key, value, { bump = true } = {}) {
  if (!el || value === null) return;
  const text = fmt.format(value);
  if (el.textContent === text) return;
  el.textContent = text;
  if (bump && state.painted[key] !== null) {
    el.dataset.bump = 'true';
    setTimeout(() => {
      delete el.dataset.bump;
    }, 500);
  }
  state.painted[key] = value;
}

function setStatus(mode, text, note, { retry = true } = {}) {
  els.root.dataset.state = mode;
  if (els.status) els.status.dataset.state = mode;
  if (els.statusText && text) els.statusText.textContent = text;
  if (els.note && note) els.note.textContent = note;
  // Only offer RETRY when retrying could plausibly help. With no backend
  // configured at all, a button that re-fails is just noise.
  if (els.retry) els.retry.hidden = !(retry && (mode === 'offline' || mode === 'unavailable'));
}

const LIVE_NOTE = 'active = seen in the last 30 seconds · updated every 1s';

function renderLive(data) {
  state.unique = Number(data.unique) || 0;
  state.active = Number(data.active) || 0;
  state.lastOkAt = Date.now();
  state.failures = 0;

  paintNumber(els.unique, 'unique', state.unique);
  paintNumber(els.active, 'active', state.active);

  if (els.uniqueSub) {
    els.uniqueSub.textContent =
      state.unique === 1 ? '1 player has opened the site' : `${fmt.format(state.unique)} players counted once each`;
  }
  if (els.activeSub) {
    els.activeSub.textContent =
      state.active === 0 ? 'nobody else here right now' : `${fmt.format(state.active)} on the site right now`;
  }

  setStatus('live', 'LIVE', LIVE_NOTE);
}

/**
 * The service is not reachable. Show that honestly: never invent a number and
 * never leave a stale one looking live.
 */
function renderUnavailable(reason) {
  setStatus(
    reason === 'offline' ? 'offline' : 'unavailable',
    reason === 'offline' ? 'RECONNECTING' : 'UNAVAILABLE',
    reason === 'offline'
      ? 'visitor service unreachable · retrying every few seconds'
      : 'visitor service not deployed — totals unavailable',
  );
  // Keep the last known numbers on screen but stop pretending they are live.
  if (els.unique && els.unique.textContent === '—') els.unique.textContent = '—';
  if (els.active && els.active.textContent === '—') els.active.textContent = '—';
}

/* --------------------------------------------------------------------- network */

async function fetchTotals() {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(VISITS_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data.unique !== 'number') throw new Error('malformed payload');
    return data;
  } finally {
    clearTimeout(abort);
  }
}

async function sendHeartbeat() {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(VISITS_URL, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ visitorId: state.identity.id, fresh: state.identity.fresh }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The server may resolve a cleared-storage id back to the original visitor;
    // adopt that id so this tab stops looking like a new player.
    const data = await res.json();
    if (data && typeof data.id === 'string' && data.id !== state.identity.id) {
      state.identity = { id: data.id, fresh: false };
      try {
        localStorage.setItem(STORAGE_KEY, data.id);
      } catch {
        /* ignore */
      }
    }
    state.identity.fresh = false;
    if (data && typeof data.unique === 'number') {
      renderLive(data);
      return true;
    }
    return false;
  } finally {
    clearTimeout(abort);
  }
}

/* ------------------------------------------------------------------ the loop */

const backoff = () => Math.min(POLL_MS * 2 ** Math.min(state.failures, 5), MAX_BACKOFF_MS);

async function tick() {
  if (state.paused) return;
  try {
    if (state.failures === 0) {
      const data = await fetchTotals();
      renderLive(data);
    } else {
      // Recovering: prove the service is back with a real read.
      const data = await fetchTotals();
      renderLive(data);
    }
  } catch (err) {
    state.failures += 1;
    // A 404 means "no such endpoint", i.e. the backend is not deployed —
    // a different, and much more honest, message than a network blip.
    const offline = !/HTTP 404/.test(String(err && err.message));
    renderUnavailable(offline ? 'offline' : 'unavailable');
  } finally {
    schedule();
  }
}

function schedule() {
  clearTimeout(state.timer);
  const delay = state.failures === 0 ? POLL_MS : backoff();
  state.timer = setTimeout(tick, delay);
}

async function heartbeatLoop() {
  try {
    if (claimLease()) {
      await sendHeartbeat();
      // Keep the lease warm only while this tab is alive and visible.
      if (!document.hidden) claimLease();
    }
  } catch {
    /* the poll loop surfaces connectivity problems; heartbeats stay quiet */
  } finally {
    clearTimeout(state.heartbeatTimer);
    state.heartbeatTimer = setTimeout(heartbeatLoop, HEARTBEAT_MS);
  }
}

function start() {
  if (els.unique) els.unique.textContent = '—';
  if (els.active) els.active.textContent = '—';
  setStatus('connecting', 'CONNECTING', 'contacting the visitor service');

  // Heartbeats first so this visitor lands in "active" immediately, then poll.
  heartbeatLoop().then(() => {
    tick();
  });

  document.addEventListener('visibilitychange', () => {
    state.paused = document.hidden;
    if (!document.hidden) {
      state.failures = 0;
      // Returning to the tab counts as being here again.
      heartbeatLoop();
      tick();
    } else {
      clearTimeout(state.timer);
      releaseLease();
    }
  });

  window.addEventListener('pagehide', () => {
    releaseLease();
    clearTimeout(state.timer);
    clearTimeout(state.heartbeatTimer);
  });

  if (els.retry) {
    els.retry.addEventListener('click', () => {
      state.failures = 0;
      setStatus('connecting', 'CONNECTING', 'reconnecting…');
      tick();
    });
  }

  // Another tab took over the heartbeat: nothing to do, it is already pinging.
  if (channel) {
    channel.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'totals' && typeof msg.unique === 'number') renderLive(msg);
    });
  }

  if (typeof console !== 'undefined') {
    console.info('[visitors] tracking via', VISITS_URL, 'as visitor', state.identity.id);
  }
}

/* ---------------------------------------------------------------- bootstrap */

// Must run last: everything above (state, channel, the DOM refs) has to exist
// before a poll or heartbeat touches it.
if (!els.root) {
  if (typeof console !== 'undefined') console.info('[visitors] panel not present; tracking disabled');
} else if (VISITS_URL === null) {
  // Honest dead end: no backend has been configured for this deployment, so
  // there is no shared total to read. Say that; do not invent a figure.
  setStatus('unavailable', 'UNAVAILABLE', 'visitor tracking backend not deployed', { retry: false });
  if (els.uniqueSub) els.uniqueSub.textContent = 'needs the visitor service (see azyron-website/render.yaml)';
  if (els.activeSub) els.activeSub.textContent = 'live activity needs the visitor service';
} else {
  start();
}

// Exported for the Node test harness; harmless in the browser.
export { VISITS_URL, POLL_MS, HEARTBEAT_MS, state as _state };
