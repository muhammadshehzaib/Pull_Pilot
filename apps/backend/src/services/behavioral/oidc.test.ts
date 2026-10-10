import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { verifyCiToken } from './oidc';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = async () => [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }];
const expected = { repositoryId: '42', workflowRef: 'o/r/.github/workflows/aipr-behavioral.yml@refs/heads/main', workflowSha: 'a'.repeat(40), audience: 'aipr-ci' };
const claims = { repository_id: '42', workflow_ref: expected.workflowRef, workflow_sha: expected.workflowSha, sha: expected.workflowSha, event_name: 'workflow_dispatch', run_attempt: '1', run_id: '123' };
const token = (extra = {}) => jwt.sign({ ...claims, ...extra }, privateKey, { algorithm: 'RS256', keyid: 'test', issuer: 'https://token.actions.githubusercontent.com', audience: 'aipr-ci', expiresIn: '5m' });
describe('owner CI identity', () => {
  it('authenticates the pinned owner workflow, repository and audience', async () => expect(await verifyCiToken(token(), expected, keys)).toEqual({ runId: '123' }));
  it.each([{ repository_id: '99' }, { workflow_sha: 'b'.repeat(40) }, { workflow_ref: 'o/fork/workflow' }, { event_name: 'pull_request' }, { run_attempt: '2' }, { aud: 'other' }, { exp: 1 }])('rejects mismatched or expired claims %j', async extra => {
    const signed = jwt.sign({ ...claims, iss: 'https://token.actions.githubusercontent.com', aud: 'aipr-ci', exp: Math.floor(Date.now() / 1000) + 300, ...extra }, privateKey, { algorithm: 'RS256', keyid: 'test' });
    await expect(verifyCiToken(signed, expected, keys)).rejects.toThrow();
  });
});
