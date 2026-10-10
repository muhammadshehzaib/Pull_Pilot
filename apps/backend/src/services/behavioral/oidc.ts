import { createPublicKey, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';

const ISSUER = 'https://token.actions.githubusercontent.com';
let cache: { expires: number; keys: JsonWebKey[] } | undefined;
async function githubKeys(): Promise<JsonWebKey[]> {
  if (cache && cache.expires > Date.now()) return cache.keys;
  const response = await fetch(`${ISSUER}/.well-known/jwks`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('OIDC key lookup failed');
  const body = await response.text();
  if (body.length > 50_000) throw new Error('Invalid OIDC key response');
  const data = JSON.parse(body);
  if (!Array.isArray(data.keys) || data.keys.length > 32) throw new Error('Invalid OIDC key response');
  cache = { expires: Date.now() + 300_000, keys: data.keys };
  return cache.keys;
}
export interface CiIdentity { runId: string }
export async function verifyCiToken(token: string, expected: { repositoryId: string; workflowRef: string; workflowSha: string; audience: string }, keys = githubKeys): Promise<CiIdentity> {
  if (token.length > 16_000 || !expected.audience) throw new Error('CI authentication unavailable');
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || decoded.header.alg !== 'RS256' || !decoded.header.kid) throw new Error('Invalid CI identity');
  const key = (await keys()).find(k => (k as JsonWebKey & { kid?: string }).kid === decoded.header.kid && k.kty === 'RSA');
  if (!key) throw new Error('Unknown CI signing key');
  const publicKey = createPublicKey({ key, format: 'jwk' });
  const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: ISSUER, audience: expected.audience, maxAge: '10m' }) as jwt.JwtPayload;
  if (claims.repository_id !== expected.repositoryId || claims.workflow_ref !== expected.workflowRef || claims.workflow_sha !== expected.workflowSha || claims.sha !== expected.workflowSha || claims.event_name !== 'workflow_dispatch' || claims.run_attempt !== '1' || !/^\d{1,20}$/.test(String(claims.run_id)) || typeof claims.exp !== 'number') throw new Error('CI workflow identity does not match the approved run');
  return { runId: String(claims.run_id) };
}
