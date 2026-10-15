import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { AuthService, AuthTokenPayload, sessionHash } from '../services/auth.service';

/**
 * Sockets authenticate with the same JWT as the REST API: the `auth_token`
 * cookie set by the OAuth flow, or a token passed in the handshake `auth`
 * payload (non-browser clients).
 */
function extractToken(socket: Socket): string | undefined {
  const cookieHeader = socket.handshake.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).trim() === 'auth_token') {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  return typeof token === 'string' ? token : undefined;
}

export class SocketService {
  private static io: Server;

  static init(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    // Reject unauthenticated sockets at the handshake — job updates carry
    // per-user data and must never reach anonymous clients.
    this.io.use(async (socket, next) => {
      try {
        const token = extractToken(socket);
        if (!token) return next(new Error('Unauthorized: missing credentials'));
        socket.data.auth = await AuthService.verifySession(token);
        socket.data.sessionToken = token;
        socket.data.sessionHash = sessionHash(token);
        return next();
      } catch {
        return next(new Error('Unauthorized: invalid token'));
      }
    });

    this.io.on('connection', (socket) => {
      const auth = socket.data.auth as AuthTokenPayload;
      // One room per user, so workers can emit to the job owner only.
      socket.join(`user:${auth.userId}`);
      socket.join(`session:${socket.data.sessionHash}`);
      const expires = (AuthService.verifyToken(socket.data.sessionToken) as AuthTokenPayload & { exp: number }).exp;
      const expiration = setTimeout(() => socket.disconnect(true), Math.max(0, expires * 1000 - Date.now()));
      expiration.unref();
      console.log(`⚡ Websocket Client Connected: ${socket.id} (user ${auth.userId})`);

      socket.on('disconnect', () => {
        clearTimeout(expiration);
        console.log(`🔌 Client Disconnected: ${socket.id}`);
      });
    });

    console.log('📡 Socket.IO system ready for deployment.');
    return this.io;
  }

  static disconnectSession(hash: string) {
    this.io?.in(`session:${hash}`).disconnectSockets(true);
  }

  static async startProgressSubscriber() {
    const { subscribeReviewProgress } = await import('../services/review-progress.service');
    return subscribeReviewProgress(progress => this.emitStatus(progress.userId, progress.jobId, progress.message, progress.status, progress.data));
  }

  /**
   * Pushes live updates from workers to the job owner's clients only.
   */
  static async emitStatus(userId: string, jobId: string, message: string, status: string, data?: any) {
    if (!this.io) {
      try {
        const { publishReviewProgress } = await import('../services/review-progress.service');
        await publishReviewProgress({ userId, jobId, message, status, data });
      } catch { console.warn('Review progress publication unavailable'); }
      return;
    }

    const room = `user:${userId}`;

    await Promise.all([...this.io.sockets.adapter.rooms.get(room) ?? []].map(async id => {
      const socket = this.io.sockets.sockets.get(id);
      if (!socket) return;
      try { await AuthService.verifySession(socket.data.sessionToken); }
      catch { socket.disconnect(true); return; }
      socket.emit(`job-update:${jobId}`, { message, status, timestamp: new Date(), ...data });
      socket.emit('dashboard:activity', { jobId, message, status });
    }));
  }
}
