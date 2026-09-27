import jwt from 'jsonwebtoken';

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
    } as jwt.SignOptions);
  }

  static verifyToken(token: string): AuthTokenPayload {
    return jwt.verify(token, this.getSecret(), {
      algorithms: ALLOWED_ALGORITHMS,
    }) as AuthTokenPayload;
  }
}
