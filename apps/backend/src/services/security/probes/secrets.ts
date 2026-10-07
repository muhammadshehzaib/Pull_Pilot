import { collectAddedLines } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
} from '../probe-types';

/**
 * Hardcoded-credential probe.
 *
 * Looks for obvious secret formats (AWS/Google/OpenAI/Anthropic/GitHub/Slack/
 * Stripe keys, PEM private keys, credentials in URLs and connection strings)
 * plus generic high-entropy assignments. Every finding is **redacted**: the
 * issue text shows the key prefix and a mask, never the secret itself, so a
 * leaked value cannot be copied straight out of a review comment or a stored
 * results blob.
 */

/** Masks a secret to `first4••••last2`; falls back to `[redacted]` when short. */
export function redact(secret: string): string {
  const s = secret.trim();
  if (s.length <= 6) return '[redacted]';
  return `${s.slice(0, 4)}••••${s.slice(-2)}`;
}

/** Shannon entropy of a token, in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER = /^(?:xxx+|your_?|abc+|test_?|sample|example|changeme|dummy|placeholder|fixme|todo|demo_?|redacted|token|secret|password|passwd|pwd|api-?key)$/i;

/** Whether a token is a recognizable placeholder rather than a real secret. */
export function isPlaceholder(token: string): boolean {
  const t = token.replace(/["'`]*/g, '').trim();
  if (PLACEHOLDER.test(t)) return true;
  if (/^x+$/i.test(t) && t.length <= 12) return true;
  return /^(your_)?[a-z_]+_(?:here|token|key|secret|hash)$/i.test(t);
}

/** Skip comment lines — annotations, doc examples, and inline `noSecret` mentions. */
function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return true;
  }
  return /\b(?:noprotect|noinspection|disable)\b/i.test(trimmed);
}

interface SecretsRule {
  key: string;
  name: string;
  description: string;
  remediation: string;
  severity: 'CRITICAL' | 'HIGH';
  pattern: RegExp;
  /** Index of the capture group holding the secret candidate. */
  capture: number;
  /** Extra verdict gate on the captured candidate. */
  validate?: (candidate: string) => boolean;
}

const SECRETS_RULES: SecretsRule[] = [
  {
    key: 'secrets-aws-access-key-id',
    name: 'AWS access key id',
    severity: 'CRITICAL',
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{12}\b/,
    capture: 0,
    description: 'An AWS access key id is hardcoded. Together with its secret it grants console and API access to the linked account.',
    remediation: 'Move the key to a secret store / environment and rotate the exposed credential now.',
  },
  {
    key: 'secrets-aws-secret-key',
    name: 'AWS secret access key',
    severity: 'CRITICAL',
    pattern: /(?:aws_secret_access_key|aws_secret_key)[^"'\s=:]*["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/i,
    capture: 1,
    description: 'An AWS secret access key is assigned in source — full-damage credential exposure.',
    remediation: 'Load the key from env/secret manager and rotate it immediately.',
  },
  {
    key: 'secrets-google-api-key',
    name: 'Google API key',
    severity: 'HIGH',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/,
    capture: 1,
    description: 'A Google API key is hardcoded. Exposed keys can be abused against paid APIs.',
    remediation: 'Move the key to env/secret storage and rotate/limit the key in Google Cloud console.',
  },
  {
    key: 'secrets-openai',
    name: 'OpenAI API key',
    severity: 'CRITICAL',
    pattern: /\b(sk-[A-Za-z0-9_-]{20,})\b/,
    capture: 1,
    description: 'An OpenAI API key is hardcoded — it can be used to bill the owning account.',
    remediation: 'Reference the key from the environment and rotate it via the OpenAI dashboard.',
  },
  {
    key: 'secrets-anthropic',
    name: 'Anthropic API key',
    severity: 'CRITICAL',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/,
    capture: 1,
    description: 'An Anthropic API key is hardcoded in source.',
    remediation: 'Load the key from env/secret storage and rotate it in the Anthropic console.',
  },
  {
    key: 'secrets-github-pat',
    name: 'GitHub token',
    severity: 'CRITICAL',
    pattern: /\b(ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/,
    capture: 1,
    description: 'A GitHub token is hardcoded — it grants write access to repositories and actions.',
    remediation: 'Revoke the token and load it from a secret manager at runtime.',
  },
  {
    key: 'secrets-slack',
    name: 'Slack token',
    severity: 'HIGH',
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,48})\b/,
    capture: 1,
    description: 'A Slack token is hardcoded; it can read and post to workspaces.',
    remediation: 'Rotate the token and store it in the environment/secret manager.',
  },
  {
    key: 'secrets-stripe',
    name: 'Stripe secret key',
    severity: 'CRITICAL',
    pattern: /\b(sk_live_[0-9a-zA-Z]{24,})\b/,
    capture: 1,
    description: 'A live Stripe secret key is hardcoded — billing access to payments.',
    remediation: 'Rotate the key via the Stripe dashboard and load secrets from the environment.',
  },
  {
    key: 'secrets-private-key',
    name: 'private key block',
    severity: 'CRITICAL',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?(?:PRIVATE KEY)-----/,
    capture: 0,
    description: 'A private key block is embedded in source. Anyone with repo access can impersonate the key owner.',
    remediation: 'Remove the key from the repo, rotate it, and use a secure keystore or SSH agent.',
  },
  {
    key: 'secrets-url-credentials',
    name: 'credentials in a URL',
    severity: 'CRITICAL',
    pattern: /\bhttps?:\/\/([A-Za-z0-9_.-]+:[^@\s/]+)@/,
    capture: 1,
    description: 'A URL embeds username:password credentials. They travel with the URL into logs, history, and downstream systems.',
    remediation: 'Use a credential provider / env-based auth and rotate the exposed password.',
  },
  {
    key: 'secrets-connection-string',
    name: 'password in a connection string',
    severity: 'CRITICAL',
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|amqp|amqps?|redis|mssql)\b[^"'`\n]{0,80}:\/\/(?:(\w+):[^@\s"'`]{6,})@/i,
    capture: 1,
    description: 'A database/message-queue connection string contains an inline password.',
    remediation: 'Source credentials from the environment and rotate the exposed password.',
  },
  {
    key: 'secrets-jwt-hmac',
    name: 'hardcoded JWT signing secret',
    severity: 'HIGH',
    pattern: /\b(?:jwt\.(?:sign|verify)|JWT_SECRET|SESSION_SECRET|SECRET_KEY)\s*\(?\s*["'`][^"'`]{6,}["'`]/i,
    capture: 0,
    description: 'A JWT/session signing secret is hardcoded — forged tokens become possible.',
    remediation: 'Load the secret from env and rotate it on a rotation cadence.',
  },
  {
    key: 'secrets-high-entropy',
    name: 'likely secret in an assignment',
    severity: 'HIGH',
    pattern: /(["'`]?)[A-Za-z0-9_.-]*?(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|APIKEY|API_KEY|AUTH_KEY|PRIVATE[_-]?KEY|ACCESS_KEY)\1\s*[:=]\s*(["'`]?)([A-Za-z0-9_.~+/-]{16,})\2/i,
    capture: 3,
    validate: validateGenericSecret,
    description: 'A high-entropy value is assigned to a secret-named key. Assumed real until proven otherwise.',
    remediation: 'Move it to a secret store, check git history, and rotate the value if it is real.',
  },
];

function validateGenericSecret(candidate: string): boolean {
  // Formats owned by other rules should not be re-reported generically.
  if (/^(AKIA|ASIA|A3T[A-Z0-9]|AIza|sk_live_|ghp_|gho_|github_pat_)/.test(candidate)) return false;
  // Pure hex values are frequently hashes, uids, or examples.
  if (/^[0-9a-fA-F]+$/.test(candidate)) return false;
  if (isPlaceholder(candidate)) return false;
  if (shannonEntropy(candidate) < 4.2) return false;
  return candidate.length >= 16;
}

/**
 * Scans the added lines of a diff for hardcoded credentials.
 */
export function scanSecrets(diff: string): SecurityProbeResult {
  const findings: SecuritySuggestion[] = [];
  const counts = new Map<string, number>();

  for (const line of collectAddedLines(diff)) {
    if (isCommentLine(line.text)) continue;

    for (const rule of SECRETS_RULES) {
      const match = rule.pattern.exec(line.text);
      if (!match) continue;
      const candidate = match[rule.capture] ?? '';
      if (rule.validate && !rule.validate(candidate)) continue;

      const hitCount = counts.get(rule.key) ?? 0;
      if (hitCount >= MAX_FINDINGS_PER_RULE) continue;
      counts.set(rule.key, hitCount + 1);

      findings.push({
        filePath: line.filename,
        lineNumber: line.lineNumber,
        agentType: 'SECURITY',
        source: 'SECRETS',
        ruleKey: rule.key,
        redacted: true,
        issue: `Potential ${rule.name} exposed — value redacted (${redact(candidate)}). ${rule.description}`,
        suggestion: rule.remediation,
        priority: rule.severity,
      });
    }
  }

  return {
    findings,
    checks: [checkForProbe('SECRETS', 'secrets', 'Hardcoded credentials scan', findings.length)],
  };
}