# AZYRON CLIENT — Website

**PERFORMANCE. SMOOTHNESS. STYLE.**

The official website for AZYRON CLIENT: a premium black-and-white marketing site
with a **live, real** download system wired to the
[`blazemc125/AzyronClient`](https://github.com/blazemc125/AzyronClient) GitHub release
[`azyronclient-v1.0.0`](https://github.com/blazemc125/AzyronClient/releases/tag/azyronclient-v1.0.0).

No mock data. No fake counters. No placeholder links.

---

## What it does

| Requirement | Implementation |
| --- | --- |
| Live GitHub release data | `GET /api/release` → GitHub RIP `/releases/tags/azyronclient-v1.0.0`, normalised server-side |
| Latest release info | tag, version, name, notes, publish date, updater, release page URL |
| All downloadable assets | rendered as cards with name, kind, size, per-asset GitHub download count |
| Refresh every 5 s | browser polls the cached endpoint; per-asset and total counters animate in place |
| Server-side cache | one shared snapshot per `CACHE_TTL_MS`, **single-flight** (concurrent visitors share one GitHub request) |
| Loading state | skeleton cards, shimmer counters, live "sync" indicator |
| Error state | honest banner + automatic retry + last-known-good snapshot when GitHub is down |
| Direct downloads | `GET /api/download/:assetId` streams the real `browser_download_url` binary with `Content-Disposition: attachment`. Never redirects to a release web page, never serves HTML |
| JAR + MRPACK | both supported, plus zip/exe/apk/7z and any future asset type |
| Download progress | streamed `fetch` + `ReadableStream` → native `<progress>`, percentage, bytes, speed, inline card bar |
| Live statistics | Total Downloads · Latest Version · Available Files · Last Updated (all real) |
| Sections | Home · Downloads · Features · Changelog · About · Support |

---

## Quick start

```bash
cd azyron-website
npm install
npm start
# → http://localhost:3000
```

Node.js **20+** is required (uses native `fetch` / web streams).

```bash
npm run dev     # auto-restart on change
npm test        # integration tests against a mock GitHub upstream
```

---

## Configuration

All configuration is environment based — see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `GH_OWNER` / `GH_REPO` | `blazemc125` / `AzyronClient` | Release source repository |
| `GH_TAG` | `azyronclient-v1.0.0` | Release tag the site is built around |
| `GITHUB_TOKEN` | *(empty)* | Optional; raises GitHub's rate limit to 5000 req/h |
| `CACHE_TTL_MS` | `5000` | How often the **server** refetches GitHub |
| `ERROR_CACHE_TTL_MS` | `2000` | Retry window after an upstream failure (exponential backoff) |
| `ANALYTICS_FILE` | `./data/downloads.log` | Append-only log of proxied downloads |
| `FALLBACK_FILE` | `./data/fallback-release.json` | Last-known-good snapshot for outages |
| `GH_API_BASE` | `https://api.github.com` | Override for GitHub Enterprise / tests |

**Why the cache matters:** the browser polls every 5 seconds, but GitHub is only
contacted once per `CACHE_TTL_MS` *for the whole site*. 10 000 concurrent visitors
generate at most 12 GitHub requests per minute instead of 120 000.

---

## How downloads work

```
browser ──click──► /api/download/<assetId>
                        │
                        ├─ looks up the asset inside the shared release snapshot
                        ├─ fetch(browser_download_url, follow redirects)
                        └─ streams bytes back as
                           Content-Type: <real asset mime>
                           Content-Disposition: attachment; filename="<real name>"
```

* The URL handed to the browser is never a GitHub **release page**; it is either the
  streaming proxy above or (as a fallback) the exact `browser_download_url`.
* If GitHub's asset CDN answers with HTML or an error, the route **302s to the official
  asset URL** rather than saving a broken file. The UI exposes the same direct link.
* Range requests are supported and proxied, so resumed downloads work.
* Only completed (non-range) transfers increment the site's own download counter.

### The two real counters

1. **Downloads** — from GitHub's API (`download_count` per asset, summed for the total).
2. **Served here** — how many downloads this website itself proxied, read from
   `ANALYTICS_FILE`. Shown as `—` until the first download; never fabricated.

---

## API

| Route | Description |
| --- | --- |
| `GET /api/release` | Cached release payload + assets + totals + analytics |
| `GET /api/stats` | Lightweight counters used by the 5 s poll |
| `GET /api/releases` | Release history for the Changelog (60 s cache) |
| `GET /api/download/:assetId` | Streams the real release asset |
| `GET /api/health` | Uptime, cache state, rate-limit info |

---

## Project layout

```
azyron-website/
├── server.js              Express app + download proxy
├── config.js              Env-driven configuration
├── lib/
│   ├── github.js          GitHub client, single-flight cache, normalisation
│   └── downloads.js       Append-only download analytics
├── public/
│   ├── index.html         All six sections
│   ├── 404.html
│   └── assets/
│       ├── css/styles.css Premium black & white design system
│       ├── js/app.js      Live data, download streaming, animations
│       └── fonts/         Self-hosted Space Grotesk + Inter (no Google Fonts)
├── data/                  Snapshot + download log
└── test/api.test.js       Integration tests (mock GitHub upstream)
```

---

## Deployment

**Render / Railway / Fly / VPS**

```bash
npm ci
node server.js
```

A ready-made [`render.yaml`](render.yaml) and [`Dockerfile`](Dockerfile) are included.

```bash
docker build -t azyron-website .
docker run -p 3000:3000 -v azyron-data:/app/data azyron-website
```

Mount a volume at `/app/data` in production so the download log and outage snapshot
survive restarts. Behind a CDN, keep `CACHE_TTL_MS` at 5000 and let the site serve
from its own cache.

---

## Design notes

* Pure black `#000` canvas, white typography, glass cards with layered
  `backdrop-filter`, hairline white borders and radial hover glows.
* Motion: scroll-reveal, cursor spotlight, orbiting logo rings, sheen-swept CTAs,
  animated counters, marquee, and a fully animated install-tab switch.
* Every animation respects `prefers-reduced-motion`.
* Responsive from 320 px to ultrawide, with a dedicated mobile menu.
* Self-hosted variable-quality fonts, `Content-Security-Policy` with `'self'` only —
  no third-party trackers, no external requests other than the GitHub API (server side).

---

Independent project. Not affiliated with Mojang Studios or Microsoft.
Minecraft is a trademark of Mojang Synergies AB.
