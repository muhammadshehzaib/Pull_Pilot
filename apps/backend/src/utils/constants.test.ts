import { describe, expect, it, vi } from 'vitest';

// Importing Prisma's generated runtime can load application .env files. Shared
// constants must work with only the environment already supplied by the caller.
vi.mock('@prisma/client', () => { throw new Error('Constants must not load the Prisma runtime'); });
vi.hoisted(() => {
  vi.stubEnv('GROK_BASE_URL', 'https://api.x.ai/v1');
  vi.stubEnv('GROK_MODEL', 'explicit-test-model');
});

import { GROK_BASE_URL, GROK_MODEL, VALID_PROVIDERS } from './constants';

describe('configuration isolation', () => {
  it('keeps provider configuration without importing the environment-loading database runtime', () => {
    expect(GROK_BASE_URL).toBe('https://api.x.ai/v1');
    expect(GROK_MODEL).toBe('explicit-test-model');
    expect([...VALID_PROVIDERS]).toEqual(['GEMINI', 'OPENAI', 'CLAUDE', 'GROK']);
  });
});
