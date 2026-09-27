import { describe, it, expect, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthService } from './auth.service';

// JWT_SECRET is injected via vitest.config.ts env block.

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

describe('AuthService', () => {
  const validPayload = { userId: 'user-123', githubId: 'gh-456' };

  describe('issueToken() — happy path', () => {
    it('returns a non-empty string token', () => {
      const token = AuthService.issueToken(validPayload);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('produces a token with three dot-separated segments (JWT shape)', () => {
      const token = AuthService.issueToken(validPayload);
      expect(token.split('.')).toHaveLength(3);
    });

    it('encodes the payload such that verifyToken returns it back', () => {
      const token = AuthService.issueToken(validPayload);
      const decoded = AuthService.verifyToken(token);
      expect(decoded.userId).toBe(validPayload.userId);
      expect(decoded.githubId).toBe(validPayload.githubId);
    });

    it('includes an exp claim (token is not eternal)', () => {
      const token = AuthService.issueToken(validPayload);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded).toHaveProperty('exp');
      expect(typeof decoded.exp).toBe('number');
    });
  });

  describe('verifyToken() — failure paths', () => {
    it('throws on a completely garbage token', () => {
      expect(() => AuthService.verifyToken('not-a-real-token')).toThrow();
    });

    it('throws on an empty string', () => {
      expect(() => AuthService.verifyToken('')).toThrow();
    });

    it('throws on a token signed with a different secret', () => {
      const foreignToken = jwt.sign(validPayload, 'some-other-attacker-secret');
      expect(() => AuthService.verifyToken(foreignToken)).toThrow();
    });

    it('throws on a tampered payload (signature mismatch)', () => {
      const token = AuthService.issueToken(validPayload);
      const [header, _payload, signature] = token.split('.');
      const fakePayload = Buffer.from(
        JSON.stringify({ userId: 'attacker', githubId: 'attacker' }),
      ).toString('base64url');
      const tampered = `${header}.${fakePayload}.${signature}`;

      expect(() => AuthService.verifyToken(tampered)).toThrow();
    });

    it('throws on an expired token', () => {
      // Issue a token that expired 1 second ago.
      const expired = jwt.sign(validPayload, process.env.JWT_SECRET!, {
        expiresIn: -1,
      });
      expect(() => AuthService.verifyToken(expired)).toThrow(/jwt expired/i);
    });

    it('throws when the algorithm has been swapped to "none"', () => {
      // Classic JWT "none" attack — make sure we reject it.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(validPayload)).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      expect(() => AuthService.verifyToken(noneToken)).toThrow();
    });
  });

  describe('issueToken() — additional edge cases', () => {
    it('includes an iat (issued-at) claim', () => {
      const token = AuthService.issueToken(validPayload);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded).toHaveProperty('iat');
      expect(typeof decoded.iat).toBe('number');
    });

    it('exp is strictly greater than iat (positive lifetime)', () => {
      const token = AuthService.issueToken(validPayload);
      const decoded = jwt.decode(token) as { iat: number; exp: number };
      expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });

    it('does not embed the secret in the decoded payload', () => {
      const token = AuthService.issueToken(validPayload);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      const serialized = JSON.stringify(decoded);
      expect(serialized).not.toContain(process.env.JWT_SECRET!);
    });

    it('two tokens issued back-to-back have identical core payload claims', () => {
      const a = jwt.decode(AuthService.issueToken(validPayload)) as Record<string, unknown>;
      const b = jwt.decode(AuthService.issueToken(validPayload)) as Record<string, unknown>;
      expect(a.userId).toBe(b.userId);
      expect(a.githubId).toBe(b.githubId);
    });

    it('uses HS256 algorithm in the header', () => {
      const token = AuthService.issueToken(validPayload);
      const header = JSON.parse(
        Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
      );
      expect(header.alg).toBe('HS256');
    });

    it('round-trips additional string fields without dropping them', () => {
      const payload = { userId: 'with-dashes-123', githubId: 'gh_456-XYZ' };
      const decoded = AuthService.verifyToken(AuthService.issueToken(payload));
      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.githubId).toBe(payload.githubId);
    });
  });

  describe('verifyToken() — additional failure paths', () => {
    it('throws on a malformed token with only two segments', () => {
      expect(() => AuthService.verifyToken('aaa.bbb')).toThrow();
    });

    it('throws when payload base64 is corrupted', () => {
      const token = AuthService.issueToken(validPayload);
      const [header, , signature] = token.split('.');
      const corrupted = `${header}.NOT_BASE64URL_!!!.${signature}`;
      expect(() => AuthService.verifyToken(corrupted)).toThrow();
    });

    it('throws when given undefined (defensive)', () => {
      expect(() => AuthService.verifyToken(undefined as unknown as string)).toThrow();
    });
  });

  describe('signing key validation', () => {
    it('refuses to sign when JWT_SECRET is unset', () => {
      delete process.env.JWT_SECRET;
      expect(() => AuthService.issueToken(validPayload)).toThrow(
        /JWT_SECRET is not set/,
      );
    });

    it('refuses to verify when JWT_SECRET is unset', () => {
      const token = AuthService.issueToken(validPayload);
      delete process.env.JWT_SECRET;
      expect(() => AuthService.verifyToken(token)).toThrow(
        /JWT_SECRET is not set/,
      );
    });

    it('refuses to sign when JWT_SECRET is an empty string', () => {
      process.env.JWT_SECRET = '';
      expect(() => AuthService.issueToken(validPayload)).toThrow(
        /JWT_SECRET is not set/,
      );
    });

    it('accepts any non-empty secret the operator provides', () => {
      process.env.JWT_SECRET = 'short';
      expect(() => AuthService.issueToken(validPayload)).not.toThrow();
    });

    it('rejects a token whose algorithm is not HS256', () => {
      process.env.JWT_SECRET = 'unit-test-secret-DO-NOT-USE-IN-PROD';
      const foreign = jwt.sign(validPayload, 'some-other-attacker-secret', {
        algorithm: 'HS256',
      });
      expect(() => AuthService.verifyToken(foreign)).toThrow();
    });
  });
});
