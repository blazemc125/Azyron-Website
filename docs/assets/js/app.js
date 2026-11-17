/* =============================================================================
   AZYRON CLIENT — front-end controller

   Runs as a static site (GitHub Pages). All live data comes from the public
   GitHub Releases API through ./github-data.js, which caches responses in
   localStorage and uses conditional requests so the 60-requests/hour
   anonymous limit is never exhausted. Nothing here is hard-coded or faked.
   ============================================================================= */

import {
  POLL_MS,
  pollInterval,
  api,
  getRelease,
  getReleaseHistory,
  getLocalDownloads,
  getDiagnostics,
} from './github-data.js';
import { loadBaseline, computeSinceLaunch } from './counter.js';
import {
  formatCount,
  parseCount,
  sharePercent,
  interpolate,
  animationDuration,
  relativeLabel,
  LIVE_LABELS,
  pickAssetByKind,
  buildLiveModel,
} from './live-stats.js';

/**
 * Version handshake.
 *
 * GitHub Pages serves files with a 10-minute cache, so a visitor can end up
 * running yesterday's HTML with today's JS (or the reverse) for a few minutes
 * after a deploy. That produced a real bug once: the page said "total
 * downloads" while the JS happily wrote "since launch" numbers into it.
 *
 * The workflow stamps ./version.json on each deploy. If the page we loaded is
 * not the version that is live, we reload once — guarded by sessionStorage so a
 * broken deploy can never trap someone in a reload loop.
 */
const RELOAD_GUARD = 'azyron:reloaded-for';
const APP_VERSION = document.documentElement.dataset.appVersion || '';


// Allow ?owner=…&repo=…&tag=… so a fork can point the page at its own release.
(() => {
  const params = new URLSearchParams(location.search);
  for (const key of ['owner', 'repo', 'tag']) {
    const value = params.get(key);
    if (value) api[key] = value;
  }
})();

const state = {
  release: null,
  baseline: null,
  sinceLaunch: null,
  /** mirrors the counter to the browser tab title so backgrounded tabs cannot
   *  hide a change; purely cosmetic */
  pendingLocal: 0,
  lastUpdatedAt: null,
  pollTimer: null,
  clockTimer: null,
  pollIntervalMs: POLL_MS,
  live: null,
  pending: { active: false, byAsset: {}, base: {}, expires: 0 },
  effective: null,
  failures: 0,
  lastTotal: null,
  activeDownload: null,
};

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const nf = new Intl.NumberFormat('en-US');

const formatNumber = (n) => (Number.isFinite(Number(n)) ? nf.format(Number(n)) : '—');

const formatBytes = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};

const relativeTime = (iso) => {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

const dateLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ toasts */
function toast(message, kind = 'ok', ttl = 4200) {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--err' : kind === 'warn' ? ' toast--warn' : ''}`;
  el.innerHTML = `<span class="toast__dot"></span><span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 400);
  }, ttl);
}

/* --------------------------------------------------------------- animations */
function initReveal() {
  const items = $$('[data-reveal]');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.style.setProperty('--reveal-delay', `${Math.min(i * 60, 240)}ms`);
        el.classList.add('is-visible');
        io.unobserve(el);
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
  );
  items.forEach((el) => io.observe(el));
}

function initNav() {
  const nav = $('#nav');
  const progress = $('#scrollProgress');
  const links = $$('.nav__link');
  const sections = $$('main section[id]');

  const onScroll = () => {
    const y = window.scrollY;
    nav.classList.toggle('is-stuck', y > 24);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = `${max > 0 ? Math.min(100, (y / max) * 100) : 0}%`;

    let current = sections[0]?.id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 140) current = section.id;
    }
    links.forEach((link) => link.classList.toggle('is-active', link.dataset.section === current));
  };

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  // mobile menu
  const burger = $('#navBurger');
  const menu = $('#mobileMenu');
  const setMenu = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.classList.toggle('is-open', open);
    menu.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('is-locked', open);
  };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  $$('.mobile-menu__link, .mobile-menu__cta', menu).forEach((a) => a.addEventListener('click', () => setMenu(false)));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1080) setMenu(false);
  });
}

function initSpotlight() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(hover: none)').matches) return;
  const spotlight = $('#spotlight');
  let raf = 0;
  window.addEventListener(
    'pointermove',
    (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        spotlight.style.setProperty('--mx', `${e.clientX}px`);
        spotlight.style.setProperty('--my', `${e.clientY}px`);
        raf = 0;
      });
    },
    { passive: true },
  );

  // card-local glow
  $$('[data-tilt], .asset').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--cx', `${x}%`);
      card.style.setProperty('--cy', `${y}%`);
      card.style.setProperty('--ax', `${x}%`);
      card.style.setProperty('--ay', `${y}%`);
    });
  });

  // button sheen origin
  $$('.btn--shine').forEach((btn) => {
    btn.addEventListener('pointermove', (e) => {
      const rect = btn.getBoundingClientRect();
      btn.style.setProperty('--bx', `${((e.clientX - rect.left) / rect.width) * 100}%`);
      btn.style.setProperty('--by', `${((e.clientY - rect.top) / rect.height) * 100}%`);
    });
  });
}

function initTabs() {
  const tabs = $$('.tab');
  const ink = $('.tabs__ink');
  if (!tabs.length) return;

  const moveInk = (tab) => {
    ink.style.width = `${tab.offsetWidth}px`;
    ink.style.transform = `translateX(${tab.offsetLeft - tab.parentElement.offsetLeft}px)`;
  };

  const activate = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) {
        panel.classList.toggle('is-active', on);
        panel.hidden = !on;
      }
    });
    moveInk(tab);
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      activate(next);
    });
  });

  requestAnimationFrame(() => moveInk(tabs.find((t) => t.classList.contains('is-active')) || tabs[0]));
  window.addEventListener('resize', () => moveInk(tabs.find((t) => t.classList.contains('is-active')) || tabs[0]));
}

function initMarquee() {
  // Repeat the group enough times for ultra-wide screens, then force an EVEN
  // group count so the -50% keyframe lands on an identical tile (no jump).
  const track = $('#marqueeTrack');
  if (!track) return;
  const group = track.firstElementChild;
  if (!group) return;
  const width = Math.max(group.getBoundingClientRect().width, 1);
  const needed = Math.ceil(window.innerWidth / width) + 1;
  while (track.children.length < Math.max(2, needed)) {
    track.appendChild(group.cloneNode(true));
  }
  if (track.children.length % 2 !== 0) track.appendChild(group.cloneNode(true));
  const half = track.scrollWidth / 2;
  track.style.animationDuration = `${Math.max(24, half / 46)}s`;
}

/* ------------------------------------------------------------ stat rendering */
function setText(el, value, { pop = false } = {}) {
  if (!el) return;
  const text = String(value);
  if (el.textContent === text) return;
  el.textContent = text;
  if (pop) {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
}

function setStatDownloads(value) {
  const host = $('[data-stat="downloads"]');
  if (!host) return;
  const target = Number(value) || 0;
  const from = state.lastTotal ?? target;
  state.lastTotal = target;

  host.innerHTML = `<span class="stat__num">${formatNumber(from)}</span>`;

  if (from === target) return;
  const start = performance.now();
  const dur = 700;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - (1 - p) ** 3;
    const current = Math.round(from + (target - from) * eased);
    host.firstElementChild.textContent = formatNumber(current);
    if (p < 1) requestAnimationFrame(tick);
    else host.firstElementChild.classList.add('pop');
  };
  requestAnimationFrame(tick);
}

function applyRelease(release) {
  const prevTag = state.release?.tag;
  state.release = release;
  state.lastUpdatedAt = new Date();

  const versionLabel = `v${release.version || release.tag}`;

  // "Downloads Since Launch" — the only download figure shown as a headline.
  // Derived from GitHub's live counters minus the snapshot taken at launch,
  // so it starts at 0 and only ever moves when a real download happens.
  const since = computeSinceLaunch(release, state.baseline);
  state.sinceLaunch = since;
  release.sinceLaunch = since;
  // per-asset cells are written by repaintCounters(), which folds in clicks
  // per-asset "since launch" for the download cards
  release.analytics = {
    sinceByAsset: Object.fromEntries(since.perAsset.map((p) => [String(p.id), p.since])),
  };
  release.totals.sinceLaunch = since.total;

  // nav + footer + everywhere
  setText($('#navVersion'), versionLabel);
  setText($('#stackVersion'), versionLabel);
  setText($('#footerVersion'), versionLabel);
  setText($('#heroTagText'), release.tag);
  setText($('#heroLatestVersion'), versionLabel);
  setText($('#heroFileCount'), `${release.assets.length} ${release.assets.length === 1 ? 'file' : 'files'}`);
  setText($('#heroLastUpdated'), dateLabel(release.updatedAt || release.publishedAt));

  // headline counter — repaintCounters() folds in any unconfirmed clicks and
  // updates the hero, the stats bar, the split and the live section in one go.
  repaintCounters();
  const totalEl = $('#totalDownloads');
  if (totalEl && since.total !== state.lastTotal) {
    totalEl.classList.remove('pop');
    void totalEl.offsetWidth;
    totalEl.classList.add('pop');
  }
  const hint = $('#totalDownloadsHint');
  if (hint) {
    if (!since.hasBaseline) {
      hint.innerHTML = '<span>Waiting for the launch baseline…</span>';
    } else {
      const bits = [
        since.launchedAt ? `since ${dateLabel(since.launchedAt)}` : 'since launch',
        'checked every second against GitHub',
      ];
      hint.innerHTML = `<span>${escapeHtml(bits.join(' · '))}</span>`;
    }
  }

  state.lastTotal = since.total;

  // hero + cta download meta
  const primary = pickPrimaryAsset(release.assets);
  const metaText = primary ? `${versionLabel} · ${primary.sizeLabel}` : versionLabel;
  setText($('#heroDownloadMeta'), metaText);
  setText($('#ctaDownloadMeta'), versionLabel);
  $$('[data-hero-download]').forEach((btn) => {
    btn.disabled = !primary;
    btn.dataset.assetId = primary?.id ?? '';
    btn.title = primary ? `Download ${primary.name}` : 'No assets available';
  });

  // stats bar
  setStatDownloads(since.total);
  const statVersion = $('[data-stat="version"]');
  if (statVersion) statVersion.textContent = versionLabel;
  const statFiles = $('[data-stat="files"]');
  if (statFiles) statFiles.textContent = String(release.assets.length);
  const statUpdated = $('[data-stat="updated"]');
  if (statUpdated) {
    statUpdated.textContent = relativeTime(release.updatedAt || release.publishedAt);
    statUpdated.title = dateLabel(release.updatedAt || release.publishedAt);
  }

  // release header
  const nameEl = $('#releaseName');
  if (nameEl) nameEl.textContent = release.name || release.tag;
  const meta = $('#releaseMeta');
  if (meta) {
    meta.innerHTML = [
      `<span><svg viewBox="0 0 24 24"><path d="M12 2 3 7v10l9 5 9-5V7z"/></svg>${escapeHtml(release.tag)}</span>`,
      `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${escapeHtml(dateLabel(release.publishedAt))}</span>`,
      `<span><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>${formatNumber(since.total)} since launch</span>`,
    ].join('');
  }
  const pageLink = $('#releasePageLink');
  if (pageLink && release.htmlUrl) pageLink.href = release.htmlUrl;

  // sync indicator
  const sync = $('#syncState');
  const syncText = $('#syncText');
  if (sync && syncText) {
    sync.classList.remove('is-live', 'is-error', 'is-stale');
    if (!release.ok) {
      sync.classList.add('is-error');
      syncText.textContent = /rate limit/i.test(release.error || '') ? 'GitHub rate limited' : 'GitHub unavailable';
    } else if (release.stale) {
      sync.classList.add('is-stale');
      syncText.textContent = /rate limit/i.test(release.error || release.warning || '')
        ? 'Rate limited · cached data'
        : `Cached · ${relativeTime(release.fetchedAt)}`;
    } else if (release.fromCache) {
      sync.classList.add('is-live');
      syncText.textContent = `Live · checked ${relativeTime(release.fetchedAt)}`;
    } else {
      sync.classList.add('is-live');
      syncText.textContent = `Live · updated ${relativeTime(release.fetchedAt)}`;
    }
  }
  const footerStatus = $('#footerStatus');
  if (footerStatus) footerStatus.textContent = release.ok ? (release.stale ? 'Cached' : 'Live') : 'Offline';
  const footerDot = $('#footerDot');
  if (footerDot) footerDot.style.background = release.ok ? (release.stale ? 'var(--warn)' : 'var(--ok)') : 'var(--err)';

  // banners
  const errBanner = $('#downloadsError');
  const staleBanner = $('#downloadsStale');
  if (errBanner) errBanner.hidden = Boolean(release.ok);
  if (staleBanner) staleBanner.hidden = !(release.ok && release.stale);
  if (!release.ok) {
    setText($('#downloadsErrorText'), `${release.error || 'The GitHub release API could not be reached.'} Retrying automatically — the official download links below still work.`);
  }

  renderAssets(release);

  if (prevTag && prevTag !== release.tag) {
    toast(`New release detected: ${release.tag}`, 'ok', 6000);
  }
}

function pickPrimaryAsset(assets = []) {
  return assets.find((a) => a.kind === 'jar') || assets[0] || null;
}

const assetCopy = {
  jar: {
    label: 'Fabric mod',
    desc: 'Drop into your mods folder. Needs Fabric API on Minecraft 1.21.11.',
  },
  mrpack: {
    label: 'Modrinth modpack',
    desc: 'Complete tuned pack — AZYRON CLIENT plus the full performance stack.',
  },
  zip: { label: 'Archive', desc: 'ZIP archive from the release.' },
  exe: { label: 'Windows build', desc: 'Executable installer from the release.' },
  apk: { label: 'Android build', desc: 'Android package from the release.' },
  file: { label: 'Release file', desc: 'Downloadable file published with this release.' },
  binary: { label: 'Release file', desc: 'Downloadable file published with this release.' },
};

const iconFor = (kind) => {
  if (kind === 'jar') return '<svg viewBox="0 0 24 24"><path d="M9 3h6l1.5 3H18a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1.5z"/><path d="M9.5 12.5h5M12 10v5"/></svg>';
  if (kind === 'mrpack') return '<svg viewBox="0 0 24 24"><path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg>';
};

function renderAssets(release) {
  const grid = $('#assetGrid');
  if (!grid) return;
  grid.setAttribute('aria-busy', 'false');

  if (!release.assets.length) {
    grid.innerHTML = `
      <div class="asset" style="grid-column:1/-1;align-items:center;text-align:center;padding:2.6rem 1.5rem">
        <div class="asset__icon" style="margin-inline:auto">${iconFor('file')}</div>
        <div>
          <h3 class="asset__name">${release.ok ? 'No downloadable files in this release yet' : 'Release data unavailable'}</h3>
          <p class="asset__desc">${escapeHtml(
            release.ok
              ? 'The release exists but has no uploaded assets. Check the GitHub release page for updates.'
              : release.error || 'We could not reach GitHub. Retrying automatically.',
          )}</p>
        </div>
        <a class="btn btn--ghost btn--sm" href="${escapeHtml(release.htmlUrl || 'https://github.com/blazemc125/AzyronClient/releases')}" target="_blank" rel="noopener noreferrer">
          <span class="btn__label">OPEN RELEASE PAGE</span>
        </a>
      </div>`;
    return;
  }

  const existing = Array.from(grid.children).filter((el) => el.classList.contains('asset') && el.dataset.assetId);
  const sameShape =
    existing.length === release.assets.length &&
    release.assets.every((asset, i) => existing[i]?.dataset.assetId === String(asset.id));

  if (!sameShape) {
    grid.innerHTML = release.assets.map((asset) => assetCardHtml(asset)).join('');
    bindAssetCards(grid);
    return;
  }

  // update counters in place so hovering/downloading is never disrupted
  release.assets.forEach((asset) => {
    const card = grid.querySelector(`.asset[data-asset-id="${asset.id}"]`);
    if (!card) return;
    const dl = card.querySelector('[data-field="downloads"]');
    if (dl && dl.textContent !== formatNumber(asset.downloads)) {
      dl.textContent = formatNumber(asset.downloads);
      dl.classList.remove('pop');
      void dl.offsetWidth;
      dl.classList.add('pop');
    }
    // left to repaintCounters(): it adds any unconfirmed local click on top of
    // the confirmed per-asset figure, so this cell never flickers down.
  });
}

function assetCardHtml(asset) {
  const copy = assetCopy[asset.kind] || assetCopy.file;
  const sinceValue = state.release?.analytics?.sinceByAsset?.[String(asset.id)] || 0;
  return `
  <article class="asset" data-asset-id="${asset.id}" data-download-url="${escapeHtml(asset.browserDownloadUrl)}">
    <div class="asset__top">
      <div class="asset__icon">${iconFor(asset.kind)}</div>
      <div class="asset__ident">
        <h3 class="asset__name">${escapeHtml(asset.name)}</h3>
        <p class="asset__desc">${escapeHtml(copy.desc)}</p>
      </div>
      <span class="asset__badge asset__badge--${escapeHtml(asset.kind)}">${escapeHtml(asset.kind.toUpperCase())}</span>
    </div>
    <div class="asset__meta">
      <div class="asset__meta-item">
        <span class="asset__meta-k">SIZE</span>
        <span class="asset__meta-v">${escapeHtml(asset.sizeLabel || formatBytes(asset.size))}</span>
      </div>
      <div class="asset__meta-item">
        <span class="asset__meta-k">ALL-TIME (GITHUB)</span>
        <span class="asset__meta-v" data-field="downloads">${formatNumber(asset.downloads)}</span>
      </div>
      <div class="asset__meta-item">
        <span class="asset__meta-k">SINCE LAUNCH</span>
        <span class="asset__meta-v" data-field="since" data-kind="${escapeHtml(asset.kind)}">${formatNumber(sinceValue)}</span>
      </div>
    </div>
    <div class="asset__progress" aria-hidden="true"><div class="asset__progress-bar"></div></div>
    <div class="asset__actions">
      <button class="btn btn--primary btn--shine" data-download-asset="${asset.id}">
        <span class="btn__label">DOWNLOAD</span>
        <span class="btn__meta">${escapeHtml(copy.label)}</span>
        <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16"/></svg>
      </button>
      <a class="asset__direct" href="${escapeHtml(asset.browserDownloadUrl)}" download="${escapeHtml(asset.name)}" rel="noopener noreferrer" title="Direct download from GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7m0 0H9m8 0v8"/></svg>
        <span class="asset__direct-label">Direct download link</span>
      </a>
    </div>
  </article>`;
}

/**
 * The JAR / MRPACK buttons in the live section use the same download path as
 * the main asset cards — same verified browser_download_url, same progress
 * modal, same optimistic feedback. Nothing is duplicated or special-cased.
 */
function bindLiveCards() {
  $$('[data-live-download]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.liveDownload;
      const asset =
        state.live?.[kind]?.asset ||
        pickAssetByKind(state.release?.assets || [], kind);
      if (!asset) {
        toast('That file is not in the current release yet.', 'err');
        return;
      }
      startDownload(asset, btn.closest('.dl-card'));
    });
  });
}

function bindAssetCards(grid) {
  $$('[data-download-asset]', grid).forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.asset');
      const asset = state.release?.assets.find((a) => String(a.id) === String(btn.dataset.downloadAsset));
      if (asset) startDownload(asset, card);
    });
  });
}

/* ------------------------------------------------------------ download flow */
function openModal() {
  const modal = $('#downloadModal');
  modal.hidden = false;
  document.body.classList.add('is-locked');
  $('#modalClose').focus({ preventScroll: true });
}

function closeModal() {
  document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
  const modal = $('#downloadModal');
  if (!modal.hidden) {
    modal.hidden = true;
    document.body.classList.remove('is-locked');
  }
  if (state.activeDownload?.controller) {
    state.activeDownload.userCancelled = true;
    try { state.activeDownload.controller.abort(); } catch { /* noop */ }
    state.activeDownload = null;
  }
}

function setProgress(value) {
  const el = $('#progressEl');
  if (!el) return;
  if (value === null) {
    // unknown size — native indeterminate bar
    el.removeAttribute('value');
  } else {
    el.value = value;
  }
}

function resetModal(asset) {
  const copy = assetCopy[asset.kind] || assetCopy.file;
  setText($('#modalKind'), asset.kind.toUpperCase());
  setText($('#modalTitle'), asset.name);
  setText($('#modalSub'), 'Starting download…');
  setProgress(null);
  setText($('#progressPct'), '0%');
  setText($('#progressTransferred'), `0 B / ${asset.sizeLabel || formatBytes(asset.size)}`);
  setText($('#progressSpeed'), '');
  const checks = [$('#checkSource'), $('#checkSaved')];
  checks.forEach((c) => c?.classList.remove('is-done', 'is-busy'));
  $('#modalError').hidden = true;
  $('#modalDone').hidden = true;
  $('#modalCancel').hidden = false;
  const meta = $('#modalFileMeta');
  if (meta) {
    meta.innerHTML = `
      <div><span>FILE</span><strong>${escapeHtml(asset.name)}</strong></div>
      <div><span>SIZE</span><strong>${escapeHtml(asset.sizeLabel || formatBytes(asset.size))}</strong></div>
      <div><span>TYPE</span><strong>${escapeHtml(copy.label)}</strong></div>
      <div><span>SOURCE</span><strong>GitHub Releases</strong></div>`;
  }
  $('#checkSavedText').textContent = `Saving ${asset.name} to your device`;
}

async function startDownload(asset, card) {
  openModal();
  resetModal(asset);

  const pctEl = $('#progressPct');
  const transferredEl = $('#progressTransferred');
  const speedEl = $('#progressSpeed');
  const total = Number(asset.size) || 0;
  const controller = new AbortController();
  state.activeDownload = { asset, controller };

  const checkSource = $('#checkSource');
  const checkSaved = $('#checkSaved');
  checkSource.classList.add('is-done');
  checkSaved.classList.add('is-busy');
  if (card) card.classList.add('is-downloading');

  const url = api.assetUrl(asset);
  if (!url) {
    showDownloadError(asset, new Error('This asset has no download URL'), card);
    return;
  }

  // Browsers only save types they recognise (or that we tell them to attach).
  // Custom container types like application/x-modrinth-modpack+zip would open a
  // "Save as" dialog or render as text, so those go straight to the browser.
  const SAFE_MIRROR_TYPES = new Set([
    'application/java-archive',
    'application/zip',
    'application/octet-stream',
    'application/x-zip-compressed',
    'application/x-java-archive',
  ]);
  const declared = String(asset.contentType || '').toLowerCase().split(';')[0].trim();
  const mirrorable = !declared || SAFE_MIRROR_TYPES.has(declared) || asset.kind === 'jar';

  // Acknowledge the click straight away for THIS visitor. The shared counter is
  // never touched here — it only ever moves when GitHub records the download,
  // which the 5-second poll picks up. This local nudge just avoids the feeling
  // that nothing happened while GitHub's counter catches up.
  noteLocalClick(asset);

  // The browser starts saving the file straight away. If we can also read the
  // body we mirror the byte stream into the progress UI at the same time.
  const nativeAnchor = document.createElement('a');
  let usingNative = false;
  const started = performance.now();
  let received = 0;
  let firstByteAt = 0;
  let lastTick = started;
  let lastBytes = 0;
  let raf = 0;

  let expected = total;

  const render = (receivedBytes) => {
    const pct = expected > 0 ? Math.min(100, (receivedBytes / expected) * 100) : 0;
    setProgress(expected > 0 ? pct : null);
    pctEl.textContent = expected > 0 ? `${Math.floor(pct)}%` : '—';
    transferredEl.textContent = `${formatBytes(receivedBytes)} / ${formatBytes(expected)}`;
    if (card) {
      const inlineBar = card.querySelector('.asset__progress-bar');
      if (inlineBar) inlineBar.style.width = `${pct.toFixed(1)}%`;
    }
    document.title = expected > 0
      ? `${Math.floor(pct)}% · ${asset.name} — AZYRON CLIENT`
      : `Downloading ${asset.name} — AZYRON CLIENT`;
    const now = performance.now();
    if (now - lastTick > 320) {
      const bps = ((receivedBytes - lastBytes) / (now - lastTick)) * 1000;
      if (bps > 0) speedEl.textContent = `${formatBytes(bps)}/s`;
      lastTick = now;
      lastBytes = receivedBytes;
    }
  };

  const useNativeDownload = () => {
    usingNative = true;
    nativeAnchor.href = url;
    nativeAnchor.download = asset.name;
    nativeAnchor.rel = 'noopener noreferrer';
    document.body.appendChild(nativeAnchor);
    nativeAnchor.click();
    setTimeout(() => nativeAnchor.remove(), 1000);
    setProgress(null);
    $('#modalSub').textContent = 'Your browser is saving the file…';
    pctEl.textContent = '—';
    transferredEl.textContent = asset.sizeLabel || formatBytes(total);
    checkSaved.classList.remove('is-busy');
    checkSaved.classList.add('is-done');
    $('#modalCancel').hidden = true;
    $('#modalDone').hidden = false;
    if (card) card.classList.remove('is-downloading');
    toast(`${asset.name} — download started in your browser`, 'ok');
    return true;
  };

  // If the mirrored read has not produced a byte in this window we stop trying
  // and hand the file to the browser instead. The download always starts.
  let firstByteTimer = setTimeout(() => {
    if (firstByteAt === 0) {
      clearTimeout(firstByteTimer);
      try { controller.abort(); } catch { /* noop */ }
      if (!usingNative) useNativeDownload();
    }
  }, 3000);

  if (!mirrorable) {
    useNativeDownload();
    return;
  }

  try {
    if (firstByteAt !== 0) return;
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/octet-stream' },
    });

    if (!response.ok) throw new Error(`GitHub responded ${response.status}`);

    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) throw new Error('GitHub returned a web page instead of the file');
    if (type && !SAFE_MIRROR_TYPES.has(type.split(';')[0].trim())) {
      useNativeDownload();
      return true;
    }

    const length = Number(response.headers.get('content-length')) || total;
    if (Number.isFinite(length) && length > 0) expected = length;
    let reader = null;
    const chunks = [];
    $('#modalSub').textContent = 'Receiving file from GitHub…';

    if (!response.body || !response.body.getReader) {
      useNativeDownload();
      return true;
    }
    reader = response.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === 0) {
        firstByteAt = performance.now();
        clearTimeout(firstByteTimer);
      }
      chunks.push(value);
      received += value.byteLength;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          render(received);
          raf = 0;
        });
      }
    }
    clearTimeout(firstByteTimer);
    if (raf) cancelAnimationFrame(raf);
    render(length || received);

    setProgress(100);
    pctEl.textContent = '100%';
    document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
    transferComplete(chunks, response.headers.get('content-type'), asset);
  } catch (error) {
    if (error.name === 'AbortError') {
      clearTimeout(firstByteTimer);
      if (!usingNative && state.activeDownload?.userCancelled !== true) {
        useNativeDownload();
        return;
      }
      document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
      $('#modalSub').textContent = 'Download cancelled.';
      checkSaved.classList.remove('is-busy');
      if (card) card.classList.remove('is-downloading');
      return;
    }
    clearTimeout(firstByteTimer);
    // Any transport problem on the mirrored read (CORS, offline, timeout,
    // cross-origin restrictions) is not fatal: hand the exact same asset URL
    // to the browser so the download still happens.
    const transportLike =
      /fetch|network|load failed|cors|terminated|aborted|timeout/i.test(error.message || '') ||
      error.name === 'TypeError' ||
      error.name === 'NetworkError' ||
      error instanceof TypeError;
    if (!usingNative && transportLike) {
      useNativeDownload();
      return true;
    }
    showDownloadError(asset, error, card);
    return;
  }
}

function transferComplete(chunks, contentType, asset) {
  const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = asset.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  const checkSaved = $('#checkSaved');
  checkSaved.classList.remove('is-busy');
  checkSaved.classList.add('is-done');
  setText($('#modalSub'), 'Download complete.');
  $('#modalCancel').hidden = true;
  $('#modalDone').hidden = false;
  $('#modalDone').focus({ preventScroll: true });
  const card = document.querySelector(`.asset[data-asset-id="${asset.id}"]`);
  if (card) card.classList.remove('is-downloading');
  toast(`${asset.name} downloaded`, 'ok');

  // refresh counters almost immediately so the new download shows up
  pollStats(true);
}

function finish(message) {
  setText($('#modalSub'), message);
  $('#modalCancel').hidden = true;
  $('#modalDone').hidden = false;
  $('#checkSaved').classList.remove('is-busy');
  $('#checkSaved').classList.add('is-done');
}

function showDownloadError(asset, error, card) {
  document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
  if (card) card.classList.remove('is-downloading');
  const errBox = $('#modalError');
  errBox.hidden = false;
  setText($('#modalErrorText'), `${error.message}. Use the direct GitHub link below — it points at the same official asset.`);
  const direct = $('#modalDirectLink');
  direct.href = asset.browserDownloadUrl || api.assetUrl(asset);
  direct.setAttribute('download', asset.name);
  $('#checkSaved').classList.remove('is-busy');
  $('#modalCancel').hidden = true;
  $('#modalDone').hidden = false;
  setText($('#progressSpeed'), '');
}

/* ==========================================================================
   LIVE DOWNLOAD STATISTICS
   The section under the hero: one card per file kind, a combined total, an
   honest LIVE badge and counts that animate when they change.
   ========================================================================== */

const liveAnim = new Map(); // element → requestAnimationFrame handle
const liveShown = new Map(); // element → last rendered integer

/**
 * Animate an element from whatever it currently shows to a new value.
 * Re-entrant: a fresh poll cancels the in-flight animation and continues from
 * the position on screen, so a 1-second cadence never produces a stutter.
 */
function animateCount(el, value, { duration } = {}) {
  if (!el) return;
  if (value === null || value === undefined) {
    const handle = liveAnim.get(el);
    if (handle) cancelAnimationFrame(handle);
    liveAnim.delete(el);
    liveShown.delete(el);
    el.textContent = '—';
    return;
  }

  const target = Math.max(0, Math.round(Number(value) || 0));
  const from = liveShown.has(el) ? liveShown.get(el) : parseCount(el.textContent);
  liveShown.set(el, target);

  if (from === target) {
    el.textContent = formatCount(target);
    return;
  }

  // Reduced motion: still update, just without the count-up.
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reduce || document.hidden) {
    el.textContent = formatCount(target);
    return;
  }

  const existing = liveAnim.get(el);
  if (existing) cancelAnimationFrame(existing);

  const dur = duration ?? animationDuration(from, target);
  if (dur === 0) {
    el.textContent = formatCount(target);
    return;
  }

  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = formatCount(interpolate(from, target, p));
    if (p < 1) {
      liveAnim.set(el, requestAnimationFrame(tick));
    } else {
      liveAnim.delete(el);
      el.textContent = formatCount(target);
      // subtle acknowledgement when a new download lands
      if (target > from) {
        el.classList.remove('num-pop');
        void el.offsetWidth;
        el.classList.add('num-pop');
      }
    }
  };
  liveAnim.set(el, requestAnimationFrame(tick));
}

function setBar(el, percent) {
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0)).toFixed(1)}%`;
}

/** Render the whole section from one consistent snapshot. */
function renderLiveStats(model) {
  state.live = model;

  // combined total + split
  animateCount($('#liveTotal'), model.total);
  const totalSub = $('#liveTotalSub');
  if (totalSub) {
    totalSub.innerHTML =
      `JAR ${escapeHtml(formatCount(model.jar.live))} &nbsp;+&nbsp; MRPACK ${escapeHtml(formatCount(model.mrpack.live))}`;
  }

  // JAR card
  setText($('#liveJarFile'), model.jar.name);
  setText($('#liveJarSize'), model.jar.asset ? `${model.jar.sizeLabel} · ${model.versionLabel}` : '—');
  setText($('#liveJarBtnMeta'), model.versionLabel);
  animateCount($('#liveJarTotal'), model.jar.total);
  animateCount($('#liveJarLive'), model.jar.live);
  setBar($('#liveJarBar'), model.jar.share);

  // MRPACK card
  setText($('#liveMrpackFile'), model.mrpack.name);
  setText($('#liveMrpackSize'), model.mrpack.asset ? `${model.mrpack.sizeLabel} · ${model.versionLabel}` : '—');
  setText($('#liveMrpackBtnMeta'), model.versionLabel);
  animateCount($('#liveMrpackTotal'), model.mrpack.total);
  animateCount($('#liveMrpackLive'), model.mrpack.live);
  setBar($('#liveMrpackBar'), model.mrpack.share);

  // download buttons — enabled only when the asset really exists
  for (const kind of ['jar', 'mrpack']) {
    const btn = $(`[data-live-download="${kind}"]`);
    if (!btn) continue;
    const asset = model[kind].asset;
    btn.disabled = !asset;
    btn.dataset.downloadAsset = asset?.id ?? '';
    if (asset) {
      btn.setAttribute('aria-label', `Download ${asset.name}`);
      btn.title = `Direct download: ${asset.name}`;
    }
  }

  const grid = $('#liveGrid');
  if (grid) grid.setAttribute('aria-busy', 'false');

  // LIVE badge + "updated …" line
  const status = $('#liveStatus');
  const statusText = $('#liveStatusText');
  if (status) status.dataset.state = model.state;
  if (statusText) setText(statusText, LIVE_LABELS[model.state] || 'LIVE');

  const updated = $('#liveUpdatedText');
  if (updated) {
    if (model.state === 'offline') setText(updated, 'GitHub unreachable — numbers unavailable');
    else if (model.fetchedAt) setText(updated, relativeLabel(model.fetchedAt));
    else setText(updated, 'waiting for first update');
  }
}

/** Re-render only the "updated …" label, once a second, without a network call. */
function tickLiveClock() {
  const model = state.live;
  if (!model || !model.fetchedAt) return;
  const updated = $('#liveUpdatedText');
  if (updated) setText(updated, relativeLabel(model.fetchedAt));
}


/* ------------------------------------------- optimistic per-click feedback */
/**
 * A click on DOWNLOAD and GitHub's own download counter are a few seconds apart.
 * Without care that gap produces a number that rises by one and then falls back,
 * which reads as a bug.
 *
 * So a click files a claim: "one more download of <this asset> started, when the
 * confirmed figure was X". The claim is carried on top of every render until
 * GitHub's counter for that file has actually moved by as much, then it retires
 * itself. Nothing is written to shared state — this only decides what the
 * visitor who clicked sees while the two systems catch up.
 *
 * Claims are per-asset, so the JAR card, the MRPACK card and the combined total
 * always add up to the same number.
 */
function noteLocalClick(asset) {
  const since = state.sinceLaunch;
  if (!since) return;

  const pending = state.pending;
  const id = String(asset.id);

  if (!pending.active) {
    pending.active = true;
    pending.base = Object.fromEntries(since.perAsset.map((entry) => [String(entry.id), entry.since]));
    pending.expires = Date.now() + 25_000;
  }
  pending.byAsset[id] = (pending.byAsset[id] || 0) + 1;

  repaintCounters();
}

/** Fold any unconfirmed clicks into a confirmed snapshot. */
function withPending(since) {
  const pending = state.pending;
  if (!pending.active || !since) return since;

  if (pending.expires < Date.now()) {
    resetPending();
    return since;
  }

  let outstanding = 0;
  const perAsset = since.perAsset.map((entry) => {
    const claimed = pending.byAsset[String(entry.id)] || 0;
    if (!claimed) return entry;
    // how far GitHub has actually moved for this file since the click
    const base = pending.base[String(entry.id)] ?? entry.since;
    const moved = Math.max(0, entry.since - base);
    const open = Math.max(0, claimed - moved);
    if (open === 0) return entry;
    outstanding += open;
    return { ...entry, since: entry.since + open, pending: open };
  });

  if (outstanding === 0) {
    // GitHub has caught up — the claim is real data now, so drop it.
    resetPending();
    return since;
  }

  const byKind = {};
  for (const entry of perAsset) byKind[entry.kind] = (byKind[entry.kind] || 0) + entry.since;

  return {
    ...since,
    perAsset,
    byKind,
    total: perAsset.reduce((sum, entry) => sum + entry.since, 0),
    pending: outstanding,
  };
}

function resetPending() {
  state.pending = { active: false, byAsset: {}, base: {}, expires: 0 };
}

/**
 * Repaint every download figure from the confirmed snapshot plus any
 * unconfirmed local clicks. Single source of truth, so the hero counter, the
 * stats bar, the per-file cards and the live section can never disagree.
 */
function repaintCounters() {
  const since = withPending(state.sinceLaunch);
  if (!since) return;

  state.effective = since;

  setText($('#totalDownloads'), formatNumber(since.total));
  setText($('#footerDownloads'), formatNumber(since.total));
  setText($('#countJar'), formatNumber(since.byKind.jar || 0));
  setText($('#countMrpack'), formatNumber(since.byKind.mrpack || 0));
  const split = $('#counterSplit');
  if (split) split.hidden = !since.hasBaseline || since.total === 0;
  const statNum = $('[data-stat="downloads"] .stat__num');
  if (statNum) statNum.textContent = formatNumber(since.total);

  // per-asset "since launch" cells on the asset cards
  for (const entry of since.perAsset) {
    const cell = $(`.asset[data-asset-id="${entry.id}"] [data-field="since"]`);
    if (cell) cell.textContent = formatNumber(entry.since);
  }

  if (state.release) renderLiveStats(buildLiveModel(state.release, since));
}

/* ------------------------------------------------------- version handshake */
async function checkVersion() {
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const live = await response.json();
    const liveVersion = String(live.version || '');
    if (!liveVersion || !APP_VERSION || liveVersion === APP_VERSION) return;
    if (sessionStorage.getItem(RELOAD_GUARD) === liveVersion) return;
    sessionStorage.setItem(RELOAD_GUARD, liveVersion);
    location.reload();
  } catch {
    /* offline or blocked — the cached page is perfectly usable */
  }
}

/* ------------------------------------------------------------------ polling */
async function pollStats(force = false) {
  const release = await getRelease({ force });
  state.failures = release.stale ? state.failures + 1 : 0;
  state.release = release;
  applyRelease(release);
  return release;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);

  // pollInterval() (github-data.js) decides the cadence from what GitHub is
  // actually granting us: 1 s while conditional requests return 304 (free),
  // stepping up to 5 s / 15 s / 60 s as the quota tightens. The live section is
  // therefore as fast as GitHub allows and never fast enough to get throttled.
  const wait = pollInterval();
  state.pollIntervalMs = wait;

  state.pollTimer = setTimeout(async () => {
    if (!document.hidden) await pollStats();
    schedulePoll();
  }, wait);
}

/**
 * The visible cadence. Revalidating GitHub every second is only free while it
 * answers 304; the *label* and the clock, however, can always tick every second
 * because they are computed locally from the timestamp of the last confirmed
 * read. That keeps "Updated just now" honest and responsive either way.
 */
function initLiveClock() {
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    if (!document.hidden) tickLiveClock();
  }, 1000);
}

function initPolling() {
  document.addEventListener('visibilitychange', () => {
    // Returning to the tab: refresh immediately instead of waiting out the timer.
    if (!document.hidden) pollStats();
  });
  window.addEventListener('online', () => pollStats(true));
  schedulePoll();
  initLiveClock();
}

/* --------------------------------------------------------------- changelog */
function renderChangelog(payload) {
  const list = $('#changelogList');
  if (!list) return;
  list.setAttribute('aria-busy', 'false');

  if (!payload.ok || !payload.releases?.length) {
    list.innerHTML = `<div class="timeline__empty">Release history is unavailable right now${payload.error ? ` — ${escapeHtml(payload.error)}` : ''}. The latest release is still shown in the Downloads section.</div>`;
    return;
  }

  list.innerHTML = payload.releases
    .map((release, index) => {
      const files = release.assets
        .map(
          (asset) =>
            `<span class="timeline__file"><b>${escapeHtml(asset.kind.toUpperCase())}</b>${escapeHtml(asset.name)} · ${escapeHtml(formatBytes(asset.size))}</span>`,
        )
        .join('');
      return `
      <div class="timeline__item">
        <span class="timeline__dot" aria-hidden="true"></span>
        <div class="timeline__card">
          <div class="timeline__top">
            <span class="timeline__ver">v${escapeHtml(release.version || release.tag)}</span>
            ${index === 0 ? '<span class="timeline__badge">LATEST</span>' : ''}
            ${release.prerelease ? '<span class="timeline__badge timeline__badge--pre">PRE-RELEASE</span>' : ''}
            <span class="timeline__date">${escapeHtml(dateLabel(release.publishedAt))}</span>
          </div>
          ${release.name ? `<h3 class="timeline__name">${escapeHtml(release.name)}</h3>` : ''}
          <p class="timeline__body">${escapeHtml(release.body || 'No release notes were published for this version.')}</p>
          <div class="timeline__files">${files}</div>
          <a class="timeline__link" href="${escapeHtml(release.htmlUrl)}" target="_blank" rel="noopener noreferrer">
            RELEASE PAGE
            <svg viewBox="0 0 24 24"><path d="M7 17 17 7m0 0H9m8 0v8"/></svg>
          </a>
        </div>
      </div>`;
    })
    .join('');
}

async function loadChangelog() {
  const list = $('#changelogList');
  const payload = await getReleaseHistory();
  if (payload.ok) {
    renderChangelog(payload);
  } else if (list) {
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = `<div class="timeline__empty">Release history could not be loaded — ${escapeHtml(payload.error || 'GitHub is unreachable')}. The latest release is still shown above.</div>`;
    setTimeout(loadChangelog, 30_000);
  }
}

/* ------------------------------------------------------------------- boot */
function initMisc() {
  setText($('#year'), new Date().getFullYear());

  const modal = $('#downloadModal');
  if (modal) {
    $$('[data-modal-close]', modal).forEach((el) => el.addEventListener('click', closeModal));
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalCancel').addEventListener('click', closeModal);
    $('#modalDone').addEventListener('click', closeModal);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
      if (e.key === 'Tab' && !modal.hidden) {
        const focusables = $$('button, a[href]', modal).filter((el) => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  $$('[data-hero-download]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.assetId;
      const asset = state.release?.assets.find((a) => String(a.id) === String(id));
      if (asset) {
        const card = document.querySelector(`.asset[data-asset-id="${asset.id}"]`);
        startDownload(asset, card);
      } else if (state.release?.assets.length) {
        const fallback = pickPrimaryAsset(state.release.assets);
        startDownload(fallback, null);
      } else {
        toast('Release assets are still loading — try again in a moment.', 'warn');
      }
    });
  });

  $('#retryFetch')?.addEventListener('click', async () => {
    const release = await pollStats(true);
    if (release?.ok) toast('Reconnected to GitHub releases.', 'ok');
    else toast('GitHub is still unreachable — showing cached data.', 'warn');
  });

  // anchor navigation that also closes the mobile menu
  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#' || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', id);
    });
  });

  // keep relative timestamps fresh
  setInterval(() => {
    if (state.release?.ok) {
      const statUpdated = $('[data-stat="updated"]');
      if (statUpdated) statUpdated.textContent = relativeTime(state.release.updatedAt || state.release.publishedAt);
      const sync = $('#syncText');
      if (sync && state.release.stale) sync.textContent = `Cached · ${relativeTime(state.release.fetchedAt)}`;
      const heroUpdated = $('#heroLastUpdated');
      if (heroUpdated) heroUpdated.textContent = dateLabel(state.release.updatedAt || state.release.publishedAt);
    }
  }, 30000);
}

async function boot() {
  initNav();
  initReveal();
  initSpotlight();
  initTabs();
  initMarquee();
  if (document.fonts?.ready) document.fonts.ready.then(() => initMarquee()).catch(() => {});
  window.addEventListener('resize', () => { initMarquee(); });
  initMisc();
  bindLiveCards();
  initPolling();

  // The launch snapshot must be known before the first render, otherwise the
  // headline would briefly show GitHub's all-time figure.
  state.baseline = await loadBaseline();
  await pollStats();
  loadChangelog();
  checkVersion();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
