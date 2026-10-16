import type { AiSuggestion } from '../services/ai/finding-taxonomy';
import { reviewAnchors } from '../services/ai/review-anchors';

/** Test-only model citations tied to an explicit diff, not a production bypass. */
export function verifiedLocationFixture(findings: AiSuggestion[]) {
  const unique = new Map(findings.map(f => [JSON.stringify([f.filePath, f.lineNumber]), f]));
  const reviewedDiff = [...unique.values()].map(f => {
    const code = f.source === 'SAST' ? 'eval(req.body.code);' : f.source === 'SECRETS'
      ? `const TOKEN = "ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cD0fG3hJ6'}";` : 'const reviewedValue = value.name;';
    return `diff --git a/${f.filePath} b/${f.filePath}\n--- a/${f.filePath}\n+++ b/${f.filePath}\n@@ -${f.lineNumber},0 +${f.lineNumber},1 @@\n+${code}`;
  }).join('\n');
  const anchors = [...reviewAnchors(reviewedDiff).values()];
  return { reviewedDiff, suggestions: findings.map(f => ({ ...f,
    verifiedAnchor: anchors.find(a => a.filePath === f.filePath && a.lineNumber === f.lineNumber)?.id })) };
}
