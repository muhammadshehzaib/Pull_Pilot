/**
 * Self-hosted Umami analytics configuration.
 *
 * The script URL and website id come from the deployment rather than being
 * hardcoded. A hardcoded value previously shipped as a plain-http IP address
 * (`http://109.123.244.167:3008/script.js`), which could never load: the
 * production CSP forbids third-party script origins, and `upgrade-insecure-requests`
 * rewrites the http URL on an https page anyway. It failed silently, so the
 * only evidence was an empty dashboard.
 *
 * When this is unconfigured, analytics is simply off: no script is rendered and
 * the CSP stays tight, instead of loading something known to fail.
 *
 * next.config.ts imports this module so the CSP allowlist and the rendered
 * script cannot disagree about which host is in play.
 */

const scriptSrc = process.env.NEXT_PUBLIC_UMAMI_SRC?.trim() || null;
const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID?.trim() || null;

/** Absolute URL of the Umami tracker, or null when analytics is off. */
export const ANALYTICS_SCRIPT_SRC = scriptSrc;

/** Umami website id, or null when analytics is off. */
export const ANALYTICS_WEBSITE_ID = websiteId;

/**
 * Origin of the analytics host, e.g. `https://analytics.example.com`.
 * The tracker both loads from and posts events to this origin, so it must be
 * allowed by script-src and connect-src. Null when unconfigured or malformed.
 */
export const ANALYTICS_ORIGIN = (() => {
  if (!scriptSrc) return null;
  try {
    const url = new URL(scriptSrc);
    // Only https is allowed: the production site is https, so a plain-http
    // tracker is mixed content and would be blocked by the browser.
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
})();

/** True only when a valid https tracker and a website id are both present. */
export const ANALYTICS_ENABLED =
  ANALYTICS_ORIGIN !== null && ANALYTICS_WEBSITE_ID !== null;