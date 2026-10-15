import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import prisma from '../config/prisma';

export class SessionUnavailableError extends Error {
  constructor() { super('Session verification is temporarily unavailable. Please retry.'); this.name = 'SessionUnavailableError'; }
}
export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

const ALLOWED_ALGORITHMS: jwt.Algorithm[] = ['HS256'];

export interface AuthTokenPayload {
  userId: string;
  githubId: string;
}

export class AuthService {
  private static getSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        'JWT_SECRET is not set. Refusing to sign or verify tokens without an explicit key.',
      );
    }
    return secret;
  }

  private static getExpiresIn(): string {
    return process.env.JWT_EXPIRES_IN || '7d';
  }

  static issueToken(payload: AuthTokenPayload): string {
    return jwt.sign(payload, this.getSecret(), {
      expiresIn: this.getExpiresIn(),
      algorithm: 'HS256',
      jwtid: randomUUID(),
    } as jwt.SignOptions);
  }

  static verifyToken(token: string): AuthTokenPayload {
    return jwt.verify(token, this.getSecret(), {
      algorithms: ALLOWED_ALGORITHMS,
    }) as AuthTokenPayload;
  }

  static async verifySession(token: string): Promise<AuthTokenPayload> {
    const payload = this.verifyToken(token);
    let revoked;
    try { revoked = await prisma.revokedSession.findUnique({ where: { tokenHash: sessionHash(token) } }); }
    catch { throw new SessionUnavailableError(); }
    if (revoked) throw new Error('Session revoked');
    return payload;
  }

  static async revokeToken(token: string): Promise<void> {
    let payload: jwt.JwtPayload;
    try { payload = jwt.verify(token, this.getSecret(), { algorithms: ALLOWED_ALGORITHMS }) as jwt.JwtPayload; }
    catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) return;
      throw error;
    }
    if (!Number.isSafeInteger(payload.exp)) throw new Error('Invalid session expiration');
    try {
      await prisma.revokedSession.upsert({ where: { tokenHash: sessionHash(token) },
        create: { tokenHash: sessionHash(token), expiresAt: new Date(payload.exp! * 1000) }, update: {} });
      // Expired tokens already fail signature/expiration verification.
      await prisma.revokedSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    } catch { throw new SessionUnavailableError(); }
  }
}
