# AZYRON CLIENT — Website

**PERFORMANCE. SMOOTHNESS. STYLE.**

Premium black-and-white download site for AZYRON CLIENT, published **free on GitHub Pages**
and wired to the **live** GitHub release
[`azyronclient-v1.0.0`](https://github.com/blazemc125/AzyronClient/releases/tag/azyronclient-v1.0.0)
of [`blazemc125/AzyronClient`](https://github.com/blazemc125/AzyronClient).

**Live URL after enabling Pages:** <https://blazemc125.github.io/AzyronWebsite/>

> Free domain GitHub gives you = **`blazemc125.github.io/AzyronWebsite`** on every GitHub plan,
> with free HTTPS. No hosting bill, no credit card, no server to maintain.

---

## ✅ Step-by-step: put the site online

The site files are already committed in [`docs/`](../docs). You only need to turn Pages on.

### 1. Open the Pages settings

1. Go to <https://github.com/blazemc125/Azyron-Website>.
2. Click **Settings** (top bar, needs admin rights on the repo).
3. In the left sidebar click **Pages**.

### 2. Choose the source

Under **Build and deployment → Source**, pick **GitHub Actions** *(recommended — the
workflow in this repo already handles it)*.

<details>
<summary>Alternative: deploy without Actions</summary>

Pick **Source → Deploy from a branch**, then:

| Field | Value |
| --- | --- |
| Branch | `v3_openjdk` (or `main` after merging) |
| Folder | `/docs` |

Click **Save**. GitHub publishes the folder as-is — no build step exists, so nothing can fail.
</details>

### 3. Let the workflow run

* Open the **Actions** tab → **Deploy website to GitHub Pages**.
* It starts automatically on the next push that touches `docs/`. To trigger it by hand:
  **Actions → Deploy website to GitHub Pages → Run workflow**.
* Wait ~30 s. The job ends with a green check and prints the live URL.

### 4. Open your free domain

**<https://blazemc125.github.io/AzyronWebsite/>**

First load can take up to a minute while GitHub issues the HTTPS certificate. That is normal
— the padlock appears shortly after.

### 5. Confirm it is live

Check all four:

- [ ] The hero shows the AZYRON logo, `PERFORMANCE. SMOOTHNESS. STYLE.` and a **download counter with a real number**.
- [ ] **Downloads** lists `azyron-client-1.0.0.mrpack` (6.9 MB) and `azyronclient-1.0.0.jar` (161 KB), each with its own real download count.
- [ ] The **sync chip** next to the stats reads `Live · updated …`.
- [ ] Clicking **DOWNLOAD** starts the file immediately and a progress bar appears.

### 6. Ship a new version later (no website edits needed)

1. Publish a new GitHub release in `blazemc125/AzyronClient` with tag `azyronclient-v1.1.0`
   and attach the `.jar` / `.mrpack` assets.
2. In this repo open [`docs/assets/js/github-data.js`](../docs/assets/js/github-data.js) and change one line:
   ```js
   tag: 'azyronclient-v1.1.0',
   ```
3. Commit and push. Pages redeploys automatically; the new file appears on the site.

> Visitors can also preview another tag without a redeploy: append `?tag=azyronclient-v1.1.0`
> to the URL. Same for `?owner=…&repo=…` if you fork the site.

### 7. Optional: use a custom domain instead of `*.github.io`

1. Buy any domain (Namecheap, Cloudflare, Porkbun…).
2. Repo → **Settings → Pages → Custom domain** → enter `azyron.dev` → **Save**.
   GitHub writes a `CNAME` file into `docs/` — commit it.
3. At your DNS provider add **four `A` records** for `@`:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   and a `CNAME` record for `www` → `blazemc125.github.io`.
4. Wait for DNS, then tick **Enforce HTTPS**.

---

## What the site does

| Requirement | How it works on a static host |
| --- | --- |
| Live GitHub release data | Browser calls `api.github.com/repos/blazemc125/AzyronClient/releases/tags/azyronclient-v1.0.0` |
| Latest version, notes, date | Rendered from that response (never hard-coded) |
| All release assets | Cards with name, kind, real size and real per-asset `download_count` |
| Refresh every 5 s | Poll loop with adaptive back-off — see *Rate limits* below |
| Loading animation | Skeleton cards + shimmering counters until the first payload lands |
| Error message | Explicit banner + automatic retry; cached data is labelled `Cached` |
| Direct download | Each button fetches the real `browser_download_url` — never a release web page, never HTML |
| JAR + MRPACK | Both supported, plus zip/exe/apk/7z and any future asset type |
| Download progress | Streamed `fetch` → native `<progress>`, %, bytes, speed, inline card bar |
| Live statistics | Total Downloads · Latest Version · Available Files · Last Updated |
| Sections | Home · Downloads · Features · Changelog · About · Support |

### Two honest counters

1. **Downloads** — GitHub's own `download_count`, summed for the total. Source of truth.
2. **Started here** — a real, local count of download clicks on this site (localStorage).
   It starts at `—` and only ever grows from genuine clicks. Never seeded, never inflated.

---

## Why this still respects GitHub's rate limits

Anonymous GitHub API requests are capped at **60 per hour per IP**. A naive "poll every
5 seconds for every visitor" design would break the site within minutes. The data layer
([`docs/assets/js/github-data.js`](../docs/assets/js/github-data.js)) instead:

* **caches** the payload in `localStorage` and serves it inside the TTL window;
* **revalidates with `If-None-Match`** — a `304 Not Modified` is free and does not consume the limit;
* **single-flights** requests, so 10 simultaneous callers trigger 1 network call;
* **backs off automatically** as the remaining budget drops (`≤20` → 15 s, `≤8` → 30 s, `≤2` → 2 min);
* **persists a back-off window** on `403`/`429` and keeps showing the last good data with a
  clear `Rate limited · cached data` label;
* **never invents data** — no cache and no network means an explicit error state.

Result: a normal visitor costs **~1 request per 5 s of actual browsing**, and total site traffic
stays far inside 60/hour. If you ever expect thousands of concurrent visitors, add a tiny
Cloudflare Worker in front (30 lines) or use the bundled Express server.

---

## Optional: the bundled server (caching proxy)

`azyron-website/` contains an **optional** Node/Express server that serves the same `docs/`
folder while adding a shared server-side cache and a streaming download proxy. Use it only if
you outgrow the static limits or want to host elsewhere.

```bash
cd azyron-website
npm install
npm test        # 9 integration tests against a mock GitHub upstream
npm start       # http://localhost:3000
```

<details>
<summary>API routes added by the server</summary>

| Route | Description |
| --- | --- |
| `GET /api/release` | Cached release payload + assets + totals |
| `GET /api/stats` | Lightweight counters for the 5 s poll |
| `GET /api/releases` | Release history for the Changelog |
| `GET /api/download/:assetId` | Streams the real asset (Range supported) |
| `GET /api/health` | Uptime, cache state, GitHub rate-limit info |

Configuration lives in [`.env.example`](../azyron-website/.env.example).
</details>

---

## Local preview

Any static file server works — the site has **no build step**:

```bash
# from the repository root
npx serve docs          # or: python3 -m http.server 4000 --directory docs
# open http://localhost:4000
```

Open `docs/index.html` directly from disk and it still works (data loads from GitHub).

---

## Project layout

```
docs/                         ← everything GitHub Pages publishes
├── index.html                six sections, relative asset URLs
├── 404.html                  branded not-found page
├── .nojekyll                 serve files as-is (no Jekyll processing)
├── favicon.svg  site.webmanifest  robots.txt
└── assets/
    ├── css/styles.css        black & white design system
    ├── js/github-data.js     GitHub API client: cache, ETag, rate-limit back-off
    ├── js/app.js             UI, animations, download progress
    └── fonts/                self-hosted Space Grotesk + Inter

.github/workflows/pages.yml   deploys docs/ to GitHub Pages
azyron-website/               OPTIONAL Express server + tests (see above)
```

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| Pages tab has no **Save** button | You are not a repo admin, or Source is already set — check the Actions tab instead. |
| Workflow fails with *“Pages site not found”* | Set **Settings → Pages → Source = GitHub Actions** first, then re-run. |
| Site loads but counters show `—` | GitHub API unreachable from your network, or the 60/hour limit was hit. The chip says which; cached data appears on the next successful poll. |
| Download opens a GitHub page instead of saving | Some corporate proxies rewrite asset URLs. Use the ↗ direct-link button next to the download button — same official file. |
| `404` on a deep link | Pages serves `docs/404.html`; navigate from the home page. |

---

## Design

Pure `#000` canvas, white typography, glass cards with layered `backdrop-filter`, hairline
borders, radial hover glows, orbiting logo rings, sheen-swept CTAs, animated counters and
reveal-on-scroll. Every animation honours `prefers-reduced-motion`, and the layout is tested
from 320 px to ultrawide. Fonts are self-hosted — the page loads **zero third-party resources**;
the only external request in the whole site is the GitHub API call.

---

Independent project. Not affiliated with Mojang Studios or Microsoft.
Minecraft is a trademark of Mojang Synergies AB.
