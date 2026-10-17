// A configured OpenAI-compatible endpoint may host a different service from
// the adapter's name. Do not label Groq-hosted models as xAI Grok in results.
function providerIdentity(adapter, baseUrl) {
  if (adapter === 'GROK') {
    try {
      if (new URL(baseUrl).hostname === 'api.groq.com') return { provider: 'GROQ', adapter: 'GROK' };
    } catch { /* Never persist an arbitrary URL or its credentials. */ }
  }
  return { provider: adapter };
}
module.exports = { providerIdentity };
