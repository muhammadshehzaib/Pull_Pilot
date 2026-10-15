import { Request, Response, NextFunction } from 'express';
import { AuthService, AuthTokenPayload, SessionUnavailableError } from '../services/auth.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const cookieToken = req.cookies?.auth_token;
  const headerToken = (() => {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return undefined;
  })();
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing credentials' });
  }

  try {
    req.auth = await AuthService.verifySession(token);
    return next();
  } catch (error) {
    if (error instanceof SessionUnavailableError) return res.status(503).json({ error: error.message });
    return res.status(401).json({ error: 'Unauthorized: invalid token' });
  }
};
