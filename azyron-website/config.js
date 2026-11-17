/**
 * Central configuration for the AZYRON CLIENT website.
 * Everything here can be overridden with environment variables so the site can
 * be pointed at another repository / release without touching code.
 */

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  github: {
    owner: process.env.GH_OWNER || 'blazemc125',
    repo: process.env.GH_REPO || 'AzyronClient',
    // The release the whole site is built around.
    tag: process.env.GH_TAG || 'azyronclient-v1.0.0',
    // Optional personal-access token. Not required for public repositories,
    // but raises the GitHub rate limit from 60 to 5000 requests / hour.
    token: process.env.GITHUB_TOKEN || '',
    // Overridable for GitHub Enterprise / local test doubles.
    apiBase: process.env.GH_API_BASE || 'https://api.github.com',
  },

  /**
   * Server-side cache TTL for the GitHub API payload.
   * The browser polls OUR endpoint every 5s; this endpoint only forwards a
   * request to GitHub once per CACHE_TTL_MS, no matter how many visitors are
   * online. 5xx responses are retried sooner so an outage heals quickly.
   */
  cacheTtlMs: int(process.env.CACHE_TTL_MS, 5000),
  errorCacheTtlMs: int(process.env.ERROR_CACHE_TTL_MS, 2000),

  /** Download-analytics log (one JSON line per release-asset download). */
  analyticsFile: process.env.ANALYTICS_FILE || './data/downloads.log',

  /** Snapshot used to render a last-known-good state if GitHub is unreachable at boot. */
  fallbackFile: process.env.FALLBACK_FILE || './data/fallback-release.json',

  /** Origin used to resolve the proxied download URLs (empty = derive from request). */
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
};

export const releaseHtmlUrl = () =>
  `https://github.com/${config.github.owner}/${config.github.repo}/releases/tag/${config.github.tag}`;

export const repoHtmlUrl = () =>
  `https://github.com/${config.github.owner}/${config.github.repo}`;
