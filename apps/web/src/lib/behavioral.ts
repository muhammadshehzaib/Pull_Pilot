export type BehavioralStatus = 'PASSED' | 'FAILED' | 'NOT_RUN' | 'TIMED_OUT' | 'ERROR';
export interface BehavioralReport {
  version: 1;
  executor: 'OWNER_CI';
  reason?: string;
  runId?: string;
  headSha?: string;
  ciRunId?: string;
  scenarios: { id: string; filePath: string; description: string; stage: 'GENERATED' | 'EXECUTED' | 'VERIFIED'; status: BehavioralStatus }[];
}
export function normalizeBehavioral(raw: unknown): BehavioralReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || r.executor !== 'OWNER_CI' || !Array.isArray(r.scenarios)) return null;
  const scenarios: BehavioralReport['scenarios'] = [];
  for (const value of r.scenarios.slice(0, 8)) {
    if (!value || typeof value !== 'object') continue;
    const s = value as Record<string, unknown>;
    if (typeof s.id !== 'string' || typeof s.filePath !== 'string' || typeof s.description !== 'string') continue;
    const status = ['PASSED', 'FAILED', 'NOT_RUN', 'TIMED_OUT', 'ERROR'].includes(String(s.status)) ? s.status as BehavioralStatus : 'NOT_RUN';
    // A legacy/malformed stage never upgrades NOT_RUN to verified.
    const stage = status === 'PASSED' && s.stage === 'VERIFIED' ? 'VERIFIED' : s.stage === 'EXECUTED' && status !== 'NOT_RUN' ? 'EXECUTED' : 'GENERATED';
    scenarios.push({ id: s.id.slice(0, 24), filePath: s.filePath.slice(0, 300), description: s.description.slice(0, 300), stage, status });
  }
  return { version: 1, executor: 'OWNER_CI', scenarios, ...(typeof r.reason === 'string' ? { reason: r.reason.slice(0, 200) } : {}), ...(typeof r.headSha === 'string' ? { headSha: r.headSha.slice(0, 40) } : {}), ...(typeof r.ciRunId === 'string' && /^\d+$/.test(r.ciRunId) ? { ciRunId: r.ciRunId } : {}) };
}
