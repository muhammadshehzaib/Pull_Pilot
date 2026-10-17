const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerIdentity } = require('./provider-identity.cjs');

test('Groq-hosted reviews identify the service separately from the reused Grok adapter', () => {
  assert.deepEqual(providerIdentity('GROK', 'https://api.groq.com/openai/v1'), { provider: 'GROQ', adapter: 'GROK' });
  assert.deepEqual(providerIdentity('GROK', 'https://api.x.ai/v1'), { provider: 'GROK' });
  assert.deepEqual(providerIdentity('GEMINI'), { provider: 'GEMINI' });
});

test('identity does not persist credentials or trust a lookalike hostname', () => {
  assert.deepEqual(providerIdentity('GROK', 'https://api.groq.com.evil.example/v1?key=private-value'), { provider: 'GROK' });
  assert.deepEqual(providerIdentity('GROK', 'private-value'), { provider: 'GROK' });
  assert.equal(JSON.stringify(providerIdentity('GROK', 'https://user:private-value@api.groq.com/openai/v1')).includes('private-value'), false);
});
