import { describe, expect, it, vi } from 'vitest';
vi.mock('../../config/prisma', () => ({ default: { $transaction: vi.fn() } }));
import { createRuleFromFinding, ruleCreationKey, ruleSimilarityKey } from './rule-conversion.service';
describe('finding rule normalization and confirmation', () => {
  it('uses stable, bounded opaque creation keys and whitespace-insensitive similarity', () => {
    expect(ruleCreationKey('occ')).toMatch(/^[a-f0-9]{64}$/);
    expect(ruleCreationKey('occ')).toBe(ruleCreationKey('occ'));
    expect(ruleCreationKey('other')).not.toBe(ruleCreationKey('occ'));
    expect(ruleSimilarityKey({ name: 'A', guideline: ' Use  Existing\nNaming ' })).toBe('use existing naming');
  });
  it.each([
    {}, { confirmed: 'true' }, { confirmed: true, creationKey: 'fake' },
    { confirmed: true, creationKey: ruleCreationKey('occ'), enforcement: 'DETERMINISTIC', pattern: '(a+)+$' },
    { confirmed: true, creationKey: ruleCreationKey('occ'), enforcement: 'LLM', pattern: '.*' },
    { confirmed: true, creationKey: ruleCreationKey('occ'), enforcement: 'LLM', name: 'rule', guideline: 'x'.repeat(2001) },
  ])('rejects unsafe/unconfirmed payloads before a database write: %j', async body => {
    await expect(createRuleFromFinding('owner', 'job', 'occ', body)).rejects.toMatchObject({ status: 400 });
  });
});
