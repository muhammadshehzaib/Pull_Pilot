/**
 * Single source of truth for brand identity.
 *
 * Everything here is a *value* the product declares about itself: its name,
 * where it lives, and which public profiles it owns. Marketing prose inside JSX
 * may still spell the name out inline, but no file should hardcode the canonical
 * origin, profile URLs, or the metadata title shape. Changing the brand or the
 * domain should be a one-line edit in this file plus a rename of this module's
 * consumers, not a hunt through sixteen components.
 *
 * This module is intentionally dependency-free and free of `process.env` so it
 * can be imported from server components, metadata routes, and tests alike.
 */

/** Product name as shown to users. */
export const BRAND_NAME = 'Pull Pilot';

/** Short positioning line, reused in titles and social cards. */
export const BRAND_TAGLINE = 'Beautiful Code by Default';

/** Byline for metadata and JSON-LD. */
export const BRAND_AUTHOR = `${BRAND_NAME} Team`;

/**
 * Canonical origin, with no trailing slash.
 *
 * WARNING: this must be the domain the site is actually served from. It is
 * emitted as `metadataBase`, as the canonical URL, into `robots.txt`, and into
 * `sitemap.xml`, so a wrong value here tells search engines that every page
 * lives somewhere else and suppresses indexing of the real domain.
 *
 * Temporarily the deployment host, because `pullpilot.ai` does not serve the
 * site yet. Publishing an origin that does not resolve would point search
 * engines and social cards at a dead domain. When the site moves, change this
 * one line (and SITE_HOST, which brand.test.ts keeps in step).
 */
export const SITE_URL = 'https://reviewer.shehzaib.com';

/** Bare deployment host, kept separate from the product's display name. */
export const SITE_HOST = 'reviewer.shehzaib.com';

/** Public source repository. */
export const GITHUB_REPO_URL =
  'https://github.com/muhammadshehzaib/ai-pr-reviewer';

/** Owned social profiles. */
export const TWITTER_URL = 'https://twitter.com/pullpilot';

/** Twitter/X handle, without the leading '@'. */
export const TWITTER_HANDLE = 'pullpilot';

export const LINKEDIN_URL = 'https://linkedin.com';
export const YOUTUBE_URL = 'https://youtube.com';

/** Asset paths, resolved against SITE_URL. */
export const LOGO_PATH = '/icon.svg';
export const FAVICON_PATH = '/favicon.svg';

/** Homepage <title>, used when a route does not supply its own. */
export const DEFAULT_TITLE = `${BRAND_NAME} | AI PR Reviewer | ${BRAND_TAGLINE}`;

/**
 * Route titles are branded by the root layout's Next `title.template`
 * (`%s | BRAND_NAME`), so route modules should supply a bare page name such as
 * `'Pricing'` and must NOT append the brand themselves -- doing so renders a
 * doubled title like `Pricing | PullPilot | PullPilot`.
 */

/** Resolve a site-absolute path against SITE_URL. */
export function absoluteUrl(path = '/'): string {
  return new URL(path, SITE_URL).toString();
}

/** The org entity published as JSON-LD in the root layout. */
export const ORGANIZATION_SAME_AS = [GITHUB_REPO_URL, TWITTER_URL] as const;
