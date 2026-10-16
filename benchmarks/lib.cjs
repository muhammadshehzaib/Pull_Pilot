const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const findingId = (caseId, repetition, index, finding) => sha([caseId, repetition, index, finding]).slice(0, 24);

function estimateCost(usage, rates) {
  if (!usage.length || !rates) return null;
  let total = 0;
  for (const item of usage) {
    const rate = rates.models?.[`${item.provider}:${item.model}`];
    if (!rate || !Number.isFinite(rate.inputPerMillion) || rate.inputPerMillion < 0 ||
      !Number.isFinite(rate.outputPerMillion) || rate.outputPerMillion < 0 ||
      item.inputTokens === null || item.outputTokens === null) return null;
    // Missing cache metadata is not evidence that zero tokens were cached.
    if (item.cachedInputTokens === null || item.cacheWriteTokens === null || item.cacheWriteTokens > 0) return null;
    const cached = item.cachedInputTokens;
    if (cached > item.inputTokens || cached < 0) return null;
    if (cached && (!Number.isFinite(rate.cachedInputPerMillion) || rate.cachedInputPerMillion < 0)) return null;
    total += ((item.inputTokens - cached) * rate.inputPerMillion + item.outputTokens * rate.outputPerMillion +
      cached * (rate.cachedInputPerMillion ?? 0)) / 1_000_000;
  }
  return total;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

function labelTemplate(run, corpus) {
  const byId = new Map(corpus.cases.map(c => [c.id, c]));
  return { schemaVersion: 1, runId: run.id, corpusSha256: run.corpusSha256,
    reviewer: null, method: 'manual; keyword candidates are hints only',
    labels: run.results.flatMap(result => result.findings.map((finding, index) => ({
      findingId: findingId(result.caseId, result.repetition, index, finding), caseId: result.caseId,
      verdict: 'pending', bugId: null, rationale: '',
      candidates: byId.get(result.caseId).expectedBugs.filter(bug =>
        bug.terms.some(term => `${finding.issue} ${finding.suggestion}`.toLowerCase().includes(term.toLowerCase()))).map(b => b.id),
    }))) };
}

function score(run, corpus, labels) {
  if (run.corpusSha256 !== sha(JSON.stringify(corpus, null, 2) + '\n')) throw new Error('Corpus content does not match this run');
  if (labels.runId !== run.id || labels.corpusSha256 !== run.corpusSha256) throw new Error('Labels belong to another run or corpus');
  const byId = new Map(corpus.cases.map(c => [c.id, c]));
  const findings = new Map();
  const caseKeys = new Set();
  for (const result of run.results) {
    if (!byId.has(result.caseId)) throw new Error('Unknown case in run');
    const key = `${result.caseId}:${result.repetition}`;
    if (caseKeys.has(key)) throw new Error('Duplicate case/repetition in run');
    caseKeys.add(key);
    result.findings.forEach((finding, index) => findings.set(findingId(result.caseId, result.repetition, index, finding), result));
  }
  const decisions = new Map();
  const verdicts = new Set(['pending', 'tp', 'fp', 'duplicate', 'additional-tp', 'non-bug']);
  for (const label of labels.labels) {
    const result = findings.get(label.findingId);
    if (!result || result.caseId !== label.caseId || decisions.has(label.findingId) || !verdicts.has(label.verdict)) throw new Error('Invalid, unknown or duplicate adjudication');
    if (label.verdict !== 'pending' && (!labels.reviewer || !label.rationale?.trim())) throw new Error('Adjudication needs reviewer and rationale');
    if (['tp', 'duplicate'].includes(label.verdict) && !byId.get(result.caseId).expectedBugs.some(b => b.id === label.bugId)) throw new Error('True positive must reference a known bug in the same case');
    decisions.set(label.findingId, label);
  }
  function aggregate(results) {
    const detected = new Set(), successfulDetected = new Set();
    let knownBugs = 0, successfulKnownBugs = 0, tpComments = 0, fp = 0, duplicates = 0, additional = 0, nonBug = 0, pending = 0;
    let cleanCases = 0, cleanWithFalseComments = 0;
    for (const result of results) {
      const item = byId.get(result.caseId);
      knownBugs += item.expectedBugs.length;
      if (result.status === 'ok') successfulKnownBugs += item.expectedBugs.length;
      let cleanFp = false;
      if (item.variant === 'clean') cleanCases++;
      result.findings.forEach((finding, index) => {
        const decision = decisions.get(findingId(result.caseId, result.repetition, index, finding));
        if (!decision || decision.verdict === 'pending') { pending++; return; }
        if (decision.verdict === 'tp') {
          const key = `${result.caseId}:${result.repetition}:${decision.bugId}`;
          if (detected.has(key)) duplicates++; else { tpComments++; detected.add(key); }
          if (result.status === 'ok') successfulDetected.add(key);
        } else if (decision.verdict === 'fp') { fp++; cleanFp = true; }
        else if (decision.verdict === 'duplicate') duplicates++;
        else if (decision.verdict === 'additional-tp') additional++;
        else if (decision.verdict === 'non-bug') nonBug++;
      });
      if (item.variant === 'clean' && cleanFp) cleanWithFalseComments++;
    }
    // A 'duplicate' label cannot stand in for a confirmed first detection.
    const duplicateOrphans = results.some(result => result.findings.some((finding, index) => {
      const decision = decisions.get(findingId(result.caseId, result.repetition, index, finding));
      return decision?.verdict === 'duplicate' && !detected.has(`${result.caseId}:${result.repetition}:${decision.bugId}`);
    }));
    if (duplicateOrphans) throw new Error('Duplicate label has no confirmed detection');
    const judged = tpComments + additional + fp;
    const failures = results.filter(r => r.status !== 'ok').length;
    const complete = pending === 0;
    const costs = results.map(r => r.costUsd);
    return { cases: results.length, successfulCases: results.length - failures, failures,
      knownBugs, detectedBugs: detected.size, missedBugs: complete ? knownBugs - detected.size : null,
      adjudicationComplete: complete, pendingComments: pending, confirmedTrueComments: tpComments,
      additionalTrueComments: additional, falseComments: fp, duplicateComments: duplicates, nonBugComments: nonBug,
      recall: complete && knownBugs ? detected.size / knownBugs : null,
      successfulCaseRecall: complete && successfulKnownBugs ? successfulDetected.size / successfulKnownBugs : null,
      precision: complete && judged ? (tpComments + additional) / judged : null,
      precisionCountingDuplicatesAsNoise: complete && judged + duplicates ? (tpComments + additional) / (judged + duplicates) : null,
      cleanCases, cleanWithFalseComments, cleanCaseFalseCommentRate: complete && cleanCases ? cleanWithFalseComments / cleanCases : null,
      durationMs: { median: quantile(results.filter(r => r.status === 'ok').map(r => r.durationMs), .5),
        p95: quantile(results.filter(r => r.status === 'ok').map(r => r.durationMs), .95) },
      costUsd: costs.every(c => c !== null) ? costs.reduce((a, b) => a + b, 0) : null,
      knownCostSubtotalUsd: costs.filter(c => c !== null).reduce((a, b) => a + b, 0),
      casesWithUnknownCost: costs.filter(c => c === null).length,
    };
  }
  const overall = aggregate(run.results);
  overall.distinctKnownBugs = new Set(run.results.flatMap(r => byId.get(r.caseId).expectedBugs.map(b => `${r.caseId}:${b.id}`))).size;
  overall.distinctCases = new Set(run.results.map(r => r.caseId)).size;
  return { schemaVersion: 1, runId: run.id, mode: run.mode, reviewer: labels.reviewer, overall,
    byFamily: Object.fromEntries([...new Set(run.results.map(r => byId.get(r.caseId).family))].map(family => [family, aggregate(run.results.filter(r => byId.get(r.caseId).family === family))])),
    byCategory: Object.fromEntries([...new Set(run.results.map(r => byId.get(r.caseId).category))].map(category => [category, aggregate(run.results.filter(r => byId.get(r.caseId).category === category))])),
    byRepetition: Object.fromEntries([...new Set(run.results.map(r => r.repetition))].map(rep => [rep, aggregate(run.results.filter(r => r.repetition === rep))])),
  };
}

function markdown(run, report, corpus) {
  const m = report.overall;
  const pct = value => value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`;
  const rows = Object.entries(report.byCategory).map(([key, value]) => `| ${key} | ${value.knownBugs} | ${value.detectedBugs} | ${value.falseComments} | ${pct(value.recall)} |`).join('\n');
  return `# PullPilot review-quality benchmark\n\nRun: \`${run.id}\`  \nMode: **${run.mode}**  \nCorpus SHA-256: \`${run.corpusSha256}\`  \nReviewer: ${report.reviewer || 'pending'}\n\n` +
    `This is a review-core benchmark, not a deployed GitHub/queue throughput test. ${run.mode === 'scanners' ? '**AI was NOT run. These results measure only built-in offline security scanners.**' : 'See run.json for provider/model, exact scope, errors, token usage and pricing provenance.'}\n\n` +
    `| Metric | Result |\n| --- | --- |\n| Distinct cases / known bugs | ${m.distinctCases} / ${m.distinctKnownBugs} |\n| Case attempts, including repetitions | ${m.cases} |\n| Successful / failed | ${m.successfulCases} / ${m.failures} |\n| Known bug detections / opportunities, including repetitions | ${m.detectedBugs} / ${m.knownBugs} |\n| Recall (failed cases remain in denominator) | ${pct(m.recall)} |\n| Precision (adjudicated bug comments) | ${pct(m.precision)} |\n| Precision with duplicate noise | ${pct(m.precisionCountingDuplicatesAsNoise)} |\n| Incorrect / duplicate / non-bug comments | ${m.falseComments} / ${m.duplicateComments} / ${m.nonBugComments} |\n| Pending comments | ${m.pendingComments} |\n| Fixed-control attempts with incorrect comments | ${m.cleanWithFalseComments} / ${m.cleanCases} |\n| Median / p95 successful case duration | ${m.durationMs.median?.toFixed(1) ?? 'N/A'} / ${m.durationMs.p95?.toFixed(1) ?? 'N/A'} ms |\n| Estimated API cost, USD | ${m.costUsd === null ? 'unavailable (not zero)' : m.costUsd.toFixed(6)} |\n\n` +
    `| Category | Known bugs | Detected | Incorrect comments | Recall |\n| --- | --- | --- | --- | --- |\n${rows}\n\n` +
    `## Interpretation\n\nScanners are not expected to detect general logic or cross-file contract bugs. Historical cases reverse selected source changes from public merged fixes; they are not original bug-introducing PRs. Forward fixes are target-regression controls, not guarantees of globally clean code. Authored pairs are deliberately small and are not representative production traffic. Public fixes may have appeared in model training. Results must be reported separately by family.\n\n` +
    `Adjudication uses the concrete trigger and relevant code. Keyword matches are only suggestions. Unmatched comments remain pending until judged. False means an incorrect or unsupported bug claim; valid optional/style/test advice is counted separately as non-bug. New valid defects are separate additional true positives, not extra recall. An empty prediction set has unavailable precision. Reported model costs are estimates from supplied rates, not an invoice. Repetitions of the same case are not independent new bugs; inspect per-repetition metrics in report.json. This small convenience sample does not establish production accuracy or a statistically significant competitor advantage.\n\n` +
    `CodeRabbit: ${run.comparison || 'not run; no authenticated comparison runner/repository configured'}. Never infer competitor accuracy from an absent result.\n\n` +
    `## Source PRs\n\n${[...new Map(corpus.cases.filter(c => c.family === 'historical-pr').map(c => [c.provenance.url, c.provenance])).values()].map(p => `- [${p.repository}#${p.pullNumber}](${p.url}) — base \`${p.baseSha}\`, head \`${p.headSha}\``).join('\n')}\n`;
}
function compare(left, right, leftReport, rightReport) {
  if (left.corpusSha256 !== right.corpusSha256) throw new Error('Cannot compare different corpus versions');
  const inputs = run => new Map(run.results.map(r => [`${r.caseId}:${r.repetition}`, r.inputSha256]));
  const a = inputs(left), b = inputs(right);
  if (a.size !== b.size || [...a].some(([key, hash]) => !hash || b.get(key) !== hash)) throw new Error('Comparison requires identical case/repetition inputs');
  const complete = leftReport.overall.adjudicationComplete && rightReport.overall.adjudicationComplete;
  const timingComparable = left.timingScope === right.timingScope;
  return { corpusSha256: left.corpusSha256, pairedCaseAttempts: a.size, adjudicationComplete: complete,
    accuracyComparisonAvailable: complete, timingComparable,
    left: { runId: left.id, mode: left.mode, provider: left.provider, timingScope: left.timingScope, metrics: leftReport.overall },
    right: { runId: right.id, mode: right.mode, provider: right.provider, timingScope: right.timingScope, metrics: rightReport.overall },
    recallDifference: complete && leftReport.overall.recall !== null && rightReport.overall.recall !== null ? leftReport.overall.recall - rightReport.overall.recall : null,
    limitations: ['Matched input hashes do not prove identical external tool context/configuration. Record and audit vendor setup.',
      'No significance or superiority claim is made. Small public/repeated fixtures are not independent production samples.',
      ...(!timingComparable ? ['Timing scopes differ; do not compare their latency figures.'] : []),
      'API estimates and competitor subscription costs have different accounting; unknown costs remain unknown.'],
  };
}
module.exports = { sha, findingId, estimateCost, quantile, labelTemplate, score, markdown, compare };
