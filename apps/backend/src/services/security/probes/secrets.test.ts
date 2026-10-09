import { describe, it, expect } from 'vitest';
import { scanSecrets, redact, shannonEntropy, isPlaceholder } from './secrets';

function diffWith(filename: string, addedLines: string[]): string {
  const body = addedLines.map((l) => `+${l}`).join('\n');
  return (
    `diff --git a/${filename} b/${filename}\n` +
    `--- a/${filename}\n` +
    `+++ b/${filename}\n` +
    '@@ -1,1 +1,1 @@\n' +
    ' context\n' +
    body
  );
}

function keys(diff: string): string[] {
  return scanSecrets(diff).findings.map((f) => f.ruleKey);
}

describe('redact', () => {
  it('masks to first4••••last2', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA••••LE');
  });

  it('never returns the full secret for short values', () => {
    expect(redact('abc12')).toBe('[redacted]');
  });
});

describe('entropy helpers', () => {
  it('scores high entropy strings higher than with repeated characters', () => {
    expect(shannonEntropy('QweR9ty2Uiop5asdFgh7jkL')).toBeGreaterThan(shannonEntropy('AAAAAAAAAAAAAAAAAAAA'));
  });

  it('recognises common placeholders', () => {
    for (const candidate of ['your_password_here', 'changeme', 'xxx', 'sample', 'placeholder']) {
      expect(isPlaceholder(candidate)).toBe(true);
    }
  });
});

describe('secrets probe — provider formats', () => {
  it('flags AWS access key ids', () => {
    expect(keys(diffWith('env.ts', ['const KEY = "AKIAIOSFODNN7EXAMPLE";']))).toContain('secrets-aws-access-key-id');
  });

  it('flags AWS secret access key assignments', () => {
    const line = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    expect(keys(diffWith('env.py', [line]))).toContain('secrets-aws-secret-key');
  });

  it('flags Google API keys', () => {
    const dummyGoogleKey = `AIza${'0'.repeat(35)}`;
    expect(keys(diffWith('env.ts', [`const K = "${dummyGoogleKey}";`]))).toContain('secrets-google-api-key');
  });

  it('flags OpenAI, Anthropic, GitHub, Slack and Stripe keys', () => {
    const all = scanSecrets(
      diffWith('env.ts', [
        `const OAI = "sk-${'A'.repeat(24)}";`,
        `const AN = "sk-ant-${'B'.repeat(24)}";`,
        `const GH = "ghp_${'C'.repeat(36)}";`,
        'const SL = "xoxb-123456789012-123456789012-abcDEF";',
        `const ST = "sk_live_${'D'.repeat(24)}";`,
      ]),
    ).findings.map((f) => f.ruleKey);
    expect(all).toContain('secrets-openai');
    expect(all).toContain('secrets-anthropic');
    expect(all).toContain('secrets-github-pat');
    expect(all).toContain('secrets-slack');
    expect(all).toContain('secrets-stripe');
  });

  it('flags embedded private key blocks', () => {
    expect(keys(diffWith('keys.pem', ['-----BEGIN RSA PRIVATE KEY-----']))).toContain('secrets-private-key');
  });

  it('flags credentials embedded in URLs', () => {
    expect(keys(diffWith('conn.ts', ['const url = "https://user:pass123@example.com/api";']))).toContain('secrets-url-credentials');
  });

  it('flags passwords inside connection strings', () => {
    const line = 'mongodb://app:SuperSecret2024@cluster0.mongo.example.net/app';
    expect(keys(diffWith('conn.ts', [line]))).toContain('secrets-connection-string');
  });

  it('flags hardcoded JWT signing secrets', () => {
    const line = 'jwt.sign({ sub: userId }, "S3cret-Hmac-Key-12345")';
    expect(keys(diffWith('auth.ts', [line]))).toContain('secrets-jwt-hmac');
  });
});

describe('secrets probe — generic high-entropy detection', () => {
  it('flags a high-entropy value assigned to a secret-named key', () => {
    const line = 'const PASSWORD = "QweR9ty2Uiop5asdFgh7jkL"';
    expect(scanSecrets(diffWith('env.ts', [line])).findings.map((f) => f.ruleKey)).toContain('secrets-high-entropy');
  });

  it('does NOT flag placeholder or example values', () => {
    const line = 'const PASSWORD = "your_password_here"';
    expect(keys(diffWith('env.ts', [line]))).not.toContain('secrets-high-entropy');
  });

  it('does NOT flag pure hex (looks like a hash rather than a secret)', () => {
    const line = 'const SECRET_KEY = "deadbeefdeadbeefdeadbeef"';
    expect(keys(diffWith('env.ts', [line]))).not.toContain('secrets-high-entropy');
  });

  it('skips comment lines entirely', () => {
    const line = '# const PASSWORD = "QweR9ty2Uiop5asdFgh7jkL"';
    expect(scanSecrets(diffWith('env.py', [line])).findings).toHaveLength(0);
  });
});

describe('secrets probe — redaction guarantees', () => {
  const secret = `sk-${'A'.repeat(24)}`;

  it('never includes the raw secret in the finding', () => {
    const finding = scanSecrets(diffWith('env.ts', [`const KEY = "${secret}";`])).findings[0];
    expect(finding).toBeDefined();
    expect(finding.redacted).toBe(true);
    expect(finding.issue).not.toContain(secret);
    expect(finding.issue).toContain('••••');
  });
});