import { describe, it, expect } from 'vitest';
import {
  BRAND_NAME,
  BRAND_AUTHOR,
  DEFAULT_TITLE,
  GITHUB_REPO_URL,
  SITE_HOST,
  SITE_URL,
  TWITTER_HANDLE,
  TWITTER_URL,
  absoluteUrl,
} from './brand';

describe('brand config', () => {
  it('keeps SITE_URL canonical and free of a trailing slash', () => {
    // A trailing slash makes `absoluteUrl('/pricing')` emit a double slash and
    // yields a different canonical URL than the sitemap.
    expect(SITE_URL.endsWith('/')).toBe(false);
    expect(() => new URL(SITE_URL)).not.toThrow();
  });

  it('derives SITE_HOST from SITE_URL so the two cannot drift', () => {
    expect(SITE_HOST).toBe(new URL(SITE_URL).host);
  });

  it('builds absolute URLs against the canonical origin', () => {
    expect(absoluteUrl('/pricing')).toBe(`${SITE_URL}/pricing`);
    expect(absoluteUrl()).toBe(`${SITE_URL}/`);
    expect(absoluteUrl('/sitemap.xml')).toBe(`${SITE_URL}/sitemap.xml`);
  });

  it('keeps the site host on the canonical origin', () => {
    // Guards the SEO footgun where metadata points at a different domain than
    // the one actually served, which de-indexes every page.
    expect(new URL(absoluteUrl('/')).host).toBe(new URL(SITE_URL).host);
  });

  it('derives the default title and author from the brand name', () => {
    expect(DEFAULT_TITLE).toContain(BRAND_NAME);
    expect(BRAND_AUTHOR).toBe(`${BRAND_NAME} Team`);
  });

  it('points owned profiles at the expected hosts', () => {
    expect(new URL(GITHUB_REPO_URL).host).toBe('github.com');
    expect(new URL(GITHUB_REPO_URL).pathname).toContain('ai-pr-reviewer');
    expect(new URL(TWITTER_URL).host).toBe('twitter.com');
  });

  it('keeps the twitter handle and profile URL in sync', () => {
    expect(TWITTER_URL.endsWith(`/${TWITTER_HANDLE}`)).toBe(true);
  });
});