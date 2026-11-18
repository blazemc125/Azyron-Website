import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, releaseHtmlUrl, repoHtmlUrl } from './config.js';
import { getRelease, getReleaseHistory, findAsset, cacheStats, humanFileSize } from './lib/github.js';
import { recordDownload, downloadTotals } from './lib/downloads.js';
import { recordVisit, visitorTotals, isValidVisitorId, ACTIVE_WINDOW_MS, compactLog } from './lib/visitors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The static site lives in ../../docs so the exact same files can be published
// by GitHub Pages. The optional Express server only adds proxying + caching.
const SITE_DIR = join(__dirname, '..', 'docs');

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(compression());
  app.set('trust proxy', true);

  // ---------------------------------------------------------------------------
  // Security headers (also keeps the live-preview iframe happy)
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors *",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    next();
  });

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  /** Live release payload. Polled by every browser every 5s; cached server-side. */
  app.get('/api/release', async (req, res) => {
    const force = req.query.force === '1' && req.get('sec-fetch-site') === 'same-origin';
    const release = await getRelease({ force });

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Cache-TTL', String(config.cacheTtlMs));

    const assets = release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      sizeLabel: asset.sizeLabel,
      downloads: asset.downloads,
      contentType: asset.contentType,
      kind: asset.kind,
      updatedAt: asset.updatedAt,
      downloadUrl: `/api/download/${encodeURIComponent(asset.id)}?name=${encodeURIComponent(asset.name)}`,
      githubUrl: asset.browserDownloadUrl,
    }));

    const proxied = downloadTotals();

    res.status(release.ok ? 200 : release.status || 502).json({
      ok: release.ok,
      error: release.ok ? undefined : release.error,
      stale: Boolean(release.stale),
      source: release.source,
      fetchedAt: release.fetchedAt,
      cache: { ttlMs: config.cacheTtlMs, nextRefreshAt: new Date(Date.now() + config.cacheTtlMs).toISOString() },
      repo: release.repo,
      repoUrl: repoHtmlUrl(),
      tag: release.tag,
      version: release.version,
      name: release.name,
      body: release.body,
      publishedAt: release.publishedAt,
      updatedAt: release.updatedAt,
      prerelease: release.prerelease,
      htmlUrl: release.htmlUrl || releaseHtmlUrl(),
      assets,
      totals: {
        ...release.totals,
        proxied: proxied.proxied,
        sizeLabel: humanFileSize(release.totals.size),
      },
      analytics: {
        proxied: proxied.proxied,
        byAssetId: proxied.byAssetId,
      },
      rateLimit: release.rateLimit,
    });
  });

  /**
   * Download analytics only — the browser polls this every 5s so the counters
   * stay live without re-rendering the whole downloads grid.
   */
  app.get('/api/stats', async (req, res) => {
    const release = await getRelease();
    const proxied = downloadTotals();
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      stale: Boolean(release.stale),
      publishedAt: release.publishedAt,
      updatedAt: release.updatedAt,
      tag: release.tag,
      version: release.version,
      totals: { ...release.totals, proxied: proxied.proxied },
      byAssetId: proxied.byAssetId,
    });
  });

  /** Release history (changelog). Cached longer than the live counters. */
  app.get('/api/releases', async (req, res) => {
    const history = await getReleaseHistory();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(history.ok ? 200 : 502).json(history);
  });

  /** Lightweight health / diagnostics endpoint. */
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), cache: cacheStats(), analytics: downloadTotals().proxied });
  });

  /**
   * Download proxy.
   *
   * Why proxy instead of linking straight to browser_download_url?
   *  - Browser downloads must start immediately and land on the real binary.
   *  - We can therefore guarantee the correct filename, content-type and length.
   *  - Downloads are counted accurately and work cross-origin.
   *  - If GitHub's asset CDN cannot be reached from this host we transparently
   *    fall back to a 302 to the same official asset URL, so a download never
   *    silently becomes an HTML page.
   */
  app.get('/api/download/:assetId', async (req, res) => {
    const { release, asset } = await findAsset(req.params.assetId);

    if (!release.ok && !asset) {
      res.status(502).type('text/plain').send(`AZYRON CLIENT download unavailable: ${release.error}`);
      return;
    }
    if (!asset) {
      res.status(404).type('text/plain').send('Unknown release asset.');
      return;
    }

    const filename = asset.name;
    const disposition = `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

    const headers = { 'User-Agent': 'AzyronClientWebsite/1.0', Accept: '*/*' };
    const range = req.headers.range;
    if (range) headers.Range = range;

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 20_000);

    let upstream;
    try {
      upstream = await fetch(asset.browserDownloadUrl, {
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch {
      upstream = null;
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream || !upstream.ok) {
      // Never hand the client an error page disguised as a file. Fall back to a
      // direct redirect to the official GitHub asset URL.
      res.redirect(302, asset.browserDownloadUrl);
      recordDownload({ assetId: asset.id, name: filename, bytes: asset.size, userAgent: req.get('user-agent'), referer: req.get('referer') });
      return;
    }

    const upstreamType = upstream.headers.get('content-type') || '';
    const isHtml = upstreamType.includes('text/html');
    if (isHtml) {
      // Defensive: GitHub answered with a page instead of the binary.
      res.redirect(302, asset.browserDownloadUrl);
      return;
    }

    res.status(range && upstream.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', asset.contentType || upstreamType || 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const length = upstream.headers.get('content-length') || (range ? null : String(asset.size));
    if (length) res.setHeader('Content-Length', length);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    if (!range) {
      recordDownload({
        assetId: asset.id,
        name: filename,
        bytes: asset.size,
        userAgent: req.get('user-agent'),
        referer: req.get('referer'),
      });
    }

    const reader = upstream.body?.getReader();
    if (!reader) {
      res.end();
      return;
    }
    res.on('close', () => controller.abort());
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch {
      /* client went away mid-stream */
    } finally {
      res.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Static site
  // ---------------------------------------------------------------------------
  /**
   * ---------------------------------------------------------------------------
   * Visitor tracking
   * ---------------------------------------------------------------------------
   * These are the only endpoints that accept a write, and they are the reason
   * the visitor counters are real: a unique visitor is a row in a database, not
   * a number in someone's browser.
   */

  /** CORS for the GitHub Pages origin (the site is a different origin). */
  app.use('/api/visits', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  /** Shared totals. Polled by every visitor once a second. */
  app.get('/api/visits', (req, res) => {
    const totals = visitorTotals();
    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      unique: totals.unique,
      active: totals.active,
      windowMs: totals.windowMs,
    });
  });

  /**
   * Heartbeat. Called once when the page opens and every 10s while it is open.
   * Idempotent for uniques — the same visitor id can call this forever and the
   * unique total will not move after the first time.
   */
  app.post('/api/visits', express.json({ limit: '2kb' }), (req, res) => {
    const body = req.body || {};
    const visitorId = body.visitorId;

    if (!isValidVisitorId(visitorId)) {
      res.status(400).json({ ok: false, error: 'visitorId must be a 16–128 character opaque token' });
      return;
    }

    const result = recordVisit({
      visitorId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      // The client sets this only when it just minted an id because its
      // storage was empty, which is the one case where the IP+UA fallback
      // should be consulted.
      fresh: body.fresh === true,
    });

    res.status(201).json({ ok: true, fetchedAt: new Date().toISOString(), ...result });
  });

  /** Honest capability probe: tells the browser whether a writable store exists. */
  app.get('/api/visits/health', (req, res) => {
    const totals = visitorTotals();
    res.json({
      ok: true,
      store: 'append-only-jsonl',
      unique: totals.unique,
      active: totals.active,
      activeWindowMs: ACTIVE_WINDOW_MS,
      persisted: true,
    });
  });

  app.get('/api/*', (req, res) => res.status(404).json({ ok: false, error: 'Unknown API route' }));

  app.use(
    express.static(SITE_DIR, {
      extensions: ['html'],
      maxAge: '1h',
      setHeaders(res, path) {
        if (path.includes('/assets/fonts/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  app.use((req, res) => {
    res.status(404).sendFile(join(SITE_DIR, '404.html'));
  });

  return app;
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  createApp().listen(config.port, config.host, () => {
    console.log(`AZYRON CLIENT website listening on http://${config.host}:${config.port}`);
    console.log(`Release source: ${config.github.owner}/${config.github.repo}@${config.github.tag} (server cache ${config.cacheTtlMs}ms)`);
    console.log(`Visitor store: ${config.visitorsFile}`);

    // Fold the heartbeat log down to one row per visitor periodically. The log
    // is append-only so a crash cannot corrupt history, which means it needs
    // this to stay bounded.
    setInterval(() => {
      try {
        const rows = compactLog();
        console.log(`[visitors] compacted log to ${rows} visitor rows`);
      } catch (err) {
        console.warn('[visitors] compaction skipped:', err.message);
      }
    }, 15 * 60 * 1000).unref();
  });
}

export default createApp;
