'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiError } from './api';

export interface AuthUser {
  id: string;
  githubId: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Checks /api/auth/me on mount. If `redirectOnFail` is true (default for
 * protected pages), bounces to the landing page when unauthenticated.
 */
export function useAuth(redirectOnFail = true): AuthState {
  const { replace } = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt(n => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    api<{ user: AuthUser }>('/api/auth/me')
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if ((err as ApiError | null)?.status === 401) {
          setUser(null);
          if (redirectOnFail) replace('/');
        } else {
          setError('Your session could not be checked. Please retry.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [replace, redirectOnFail, attempt]);

  return { user, loading, error, retry };
}
