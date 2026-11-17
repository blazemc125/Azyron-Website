/* =============================================================================
   AZYRON CLIENT — front-end controller
   All numbers on this page come from /api/*, which is backed by the real
   GitHub Releases API (server-side cached). Nothing is hard-coded or faked.
   ============================================================================= */

const POLL_MS = 5000;

const state = {
  release: null,
  lastUpdatedAt: null,
  pollTimer: null,
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

  // nav + footer + everywhere
  setText($('#navVersion'), versionLabel);
  setText($('#stackVersion'), versionLabel);
  setText($('#footerVersion'), versionLabel);
  setText($('#heroTagText'), release.tag);
  setText($('#heroLatestVersion'), versionLabel);
  setText($('#heroFileCount'), `${release.assets.length} ${release.assets.length === 1 ? 'file' : 'files'}`);
  setText($('#heroLastUpdated'), dateLabel(release.updatedAt || release.publishedAt));
  setText($('#footerDownloads'), formatNumber(release.totals.downloads));

  // totals
  setText($('#totalDownloads'), formatNumber(release.totals.downloads), { pop: true });
  const hint = $('#totalDownloadsHint');
  if (hint) {
    const bits = [
      `${release.assets.length} ${release.assets.length === 1 ? 'asset' : 'assets'}`,
      release.totals.sizeLabel || formatBytes(release.totals.size),
      release.totals.proxied > 0 ? `${formatNumber(release.totals.proxied)} via this site` : 'counted by GitHub',
    ];
    hint.innerHTML = `<span>${escapeHtml(bits.join(' · '))}</span>`;
  }

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
  setStatDownloads(release.totals.downloads);
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
      `<span><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>${formatNumber(release.totals.downloads)} downloads</span>`,
      release.totals.proxied > 0
        ? `<span><svg viewBox="0 0 24 24"><path d="M4 12h16M12 4v16"/></svg>${formatNumber(release.totals.proxied)} served here</span>`
        : '',
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
      syncText.textContent = 'GitHub unavailable';
    } else if (release.stale) {
      sync.classList.add('is-stale');
      syncText.textContent = `Cached · ${relativeTime(release.fetchedAt)}`;
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
    setText($('#downloadsErrorText'), `${release.error || 'The GitHub release API could not be reached.'} Retrying automatically every few seconds.`);
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
    const served = card.querySelector('[data-field="served"]');
    const proxied = release.analytics?.byAssetId?.[String(asset.id)] || 0;
    if (served) served.textContent = proxied > 0 ? formatNumber(proxied) : '—';
  });
}

function assetCardHtml(asset) {
  const copy = assetCopy[asset.kind] || assetCopy.file;
  const served = state.release?.analytics?.byAssetId?.[String(asset.id)] || 0;
  return `
  <article class="asset" data-asset-id="${asset.id}" data-download-url="${escapeHtml(asset.downloadUrl)}">
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
        <span class="asset__meta-k">DOWNLOADS</span>
        <span class="asset__meta-v" data-field="downloads">${formatNumber(asset.downloads)}</span>
      </div>
      <div class="asset__meta-item">
        <span class="asset__meta-k">SERVED HERE</span>
        <span class="asset__meta-v" data-field="served">${served > 0 ? formatNumber(served) : '—'}</span>
      </div>
    </div>
    <div class="asset__progress" aria-hidden="true"><div class="asset__progress-bar"></div></div>
    <div class="asset__actions">
      <button class="btn btn--primary btn--shine" data-download-asset="${asset.id}">
        <span class="btn__label">DOWNLOAD</span>
        <span class="btn__meta">${escapeHtml(copy.label)}</span>
        <svg class="btn__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16"/></svg>
      </button>
      <a class="asset__direct" href="${escapeHtml(asset.downloadUrl)}" download="${escapeHtml(asset.name)}" title="Direct download link">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7m0 0H9m8 0v8"/></svg>
        <span class="asset__direct-label">Direct download link</span>
      </a>
    </div>
  </article>`;
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
  setText($('#modalSub'), 'Starting secure transfer…');
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

  const started = performance.now();
  let received = 0;
  let lastTick = started;
  let lastBytes = 0;
  let raf = 0;

  const limit = total > 0 ? total : 0;
  const render = (fraction, receivedBytes) => {
    const pct = limit > 0 ? Math.min(100, (receivedBytes / limit) * 100) : fraction * 100;
    setProgress(Number.isFinite(pct) ? pct : 0);
    pctEl.textContent = limit > 0 ? `${Math.floor(pct)}%` : '—';
    transferredEl.textContent = `${formatBytes(receivedBytes)} / ${asset.sizeLabel || formatBytes(total)}`;
    if (card) {
      const inlineBar = card.querySelector('.asset__progress-bar');
      if (inlineBar) inlineBar.style.width = `${pct.toFixed(1)}%`;
    }
    document.title = limit > 0 ? `${Math.floor(pct)}% · ${asset.name} — AZYRON CLIENT` : `Downloading ${asset.name} — AZYRON CLIENT`;
    const now = performance.now();
    if (now - lastTick > 320) {
      const bps = ((receivedBytes - lastBytes) / (now - lastTick)) * 1000;
      if (bps > 0) speedEl.textContent = `${formatBytes(bps)}/s`;
      lastTick = now;
      lastBytes = receivedBytes;
    }
  };

  try {
    const response = await fetch(asset.downloadUrl, {
      signal: controller.signal,
      credentials: 'same-origin',
      headers: { Accept: 'application/octet-stream' },
    });

    if (!response.ok) throw new Error(`Server responded ${response.status}`);

    const type = response.headers.get('content-type') || '';
    if (type.includes('text/html')) {
      throw new Error('Server returned a web page instead of the file');
    }

    const length = Number(response.headers.get('content-length')) || total;

    if (!response.body || !response.body.getReader) {
      // Browser cannot stream — hand the download to the browser directly.
      window.location.href = asset.downloadUrl;
      finish('Your browser is downloading the file directly.');
      return;
    }

    const reader = response.body.getReader();
    const chunks = [];
    $('#modalSub').textContent = 'Receiving file…';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          render(length ? received / length : 0, received);
          raf = 0;
        });
      }
    }
    if (raf) cancelAnimationFrame(raf);
    render(length ? received / length : 1, received);

    setProgress(100);
    pctEl.textContent = '100%';
    document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
    transferComplete(chunks, response.headers.get('content-type'), asset);
  } catch (error) {
    if (error.name === 'AbortError') {
      document.title = 'AZYRON CLIENT — Performance. Smoothness. Style.';
      $('#modalSub').textContent = 'Download cancelled.';
      checkSaved.classList.remove('is-busy');
      if (card) card.classList.remove('is-downloading');
      return;
    }
    showDownloadError(asset, error, card);
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
  direct.href = asset.githubUrl || asset.downloadUrl;
  direct.setAttribute('download', asset.name);
  $('#checkSaved').classList.remove('is-busy');
  $('#modalCancel').hidden = true;
  $('#modalDone').hidden = false;
  setText($('#progressSpeed'), '');
}

/* ------------------------------------------------------------------ polling */
async function fetchJSON(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  if (!response.ok && response.status >= 500) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function pollStats(force = false) {
  try {
    const release = await fetchJSON(`/api/release${force ? '?force=1' : ''}`);
    state.failures = 0;
    if (release.ok) {
      applyRelease(release);
    } else {
      state.release = { ...release, assets: [] };
      applyRelease(state.release);
    }
    return release;
  } catch (error) {
    state.failures += 1;
    const sync = $('#syncState');
    const syncText = $('#syncText');
    if (sync && syncText && state.failures > 1) {
      sync.classList.remove('is-live', 'is-stale');
      sync.classList.add('is-error');
      syncText.textContent = `Retrying (${state.failures})…`;
    }
    if (state.failures === 3) {
      toast('Connection to the site API failed — retrying.', 'warn');
    }
    return null;
  }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const delay = state.failures > 0 ? Math.min(POLL_MS * 2, 15000) : POLL_MS;
  state.pollTimer = setTimeout(async () => {
    if (!document.hidden) await pollStats();
    schedulePoll();
  }, delay);
}

function initPolling() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollStats();
  });
  window.addEventListener('online', () => pollStats(true));
  schedulePoll();
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
  try {
    const payload = await fetchJSON('/api/releases');
    renderChangelog(payload);
  } catch {
    if (list) {
      list.setAttribute('aria-busy', 'false');
      list.innerHTML = `<div class="timeline__empty">Release history could not be loaded. Retrying…</div>`;
    }
    setTimeout(loadChangelog, 15000);
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

function boot() {
  initNav();
  initReveal();
  initSpotlight();
  initTabs();
  initMarquee();
  if (document.fonts?.ready) document.fonts.ready.then(() => initMarquee()).catch(() => {});
  window.addEventListener('resize', () => { initMarquee(); });
  initMisc();
  initPolling();
  pollStats();
  loadChangelog();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
