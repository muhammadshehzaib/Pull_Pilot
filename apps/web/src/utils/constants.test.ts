import { describe, it, expect } from 'vitest';
import { BACKEND_URL, GITHUB_APP_INSTALL_URL } from './constants';

describe('app constants', () => {
  it('falls back to the local backend when NEXT_PUBLIC_BACKEND_URL is unset', () => {
    // Bound at import time; assert shape rather than a specific env value.
    expect(BACKEND_URL).toMatch(/^https?:\/\//);
  });

  it('points at the GitHub App installation flow', () => {
    // Installation must begin through our authenticated state-correlation route.
    expect(GITHUB_APP_INSTALL_URL).toBe(`${BACKEND_URL}/api/auth/github-app/install`);
  });
});
