import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { mockReplace, mockApi } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockApi: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('./api', () => ({ api: mockApi }));

import { useAuth } from './useAuth';

const sampleUser = {
  id: 'u-1',
  githubId: 'gh-1',
  username: 'octocat',
  email: 'octo@example.com',
  avatarUrl: 'https://example.com/a.png',
};

describe('useAuth()', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockApi.mockReset();
  });

  describe('happy path', () => {
    it('starts with loading=true and user=null', () => {
      mockApi.mockReturnValueOnce(new Promise(() => {})); // never resolves
      const { result } = renderHook(() => useAuth());

      expect(result.current.loading).toBe(true);
      expect(result.current.user).toBeNull();
    });

    it('populates user from /api/auth/me response', async () => {
      mockApi.mockImplementation(() => Promise.resolve({ user: sampleUser }));

      const { result } = renderHook(() => useAuth());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.user).toEqual(sampleUser);
    });

    it('calls /api/auth/me exactly once', async () => {
      mockApi.mockImplementation(() => Promise.resolve({ user: sampleUser }));

      renderHook(() => useAuth());

      await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
      expect(mockApi).toHaveBeenCalledWith('/api/auth/me');
    });

    it('does NOT redirect on success', async () => {
      mockApi.mockImplementation(() => Promise.resolve({ user: sampleUser }));

      renderHook(() => useAuth());

      await waitFor(() => expect(mockApi).toHaveBeenCalled());
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('failure path', () => {
    it.each([{ status: 503 }, { status: 500 }, new Error('network down')])('keeps the current route on a temporary failure: %j', async error => {
      mockApi.mockRejectedValueOnce(error);
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockReplace).not.toHaveBeenCalled();
      expect(result.current.error).toContain('retry');
      mockApi.mockResolvedValueOnce({ user: sampleUser });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.user).toEqual(sampleUser));
      expect(result.current.error).toBeNull();
      expect(mockApi).toHaveBeenCalledTimes(2);
    });

    it('retains a previously verified user when a retry fails temporarily', async () => {
      mockApi.mockResolvedValueOnce({ user: sampleUser });
      const { result } = renderHook(() => useAuth());
      await waitFor(() => expect(result.current.user).toEqual(sampleUser));
      mockApi.mockRejectedValueOnce({ status: 503 });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.user).toEqual(sampleUser);
      expect(mockReplace).not.toHaveBeenCalled();
    });
    it('redirects to "/" when /api/auth/me rejects (default redirectOnFail=true)', async () => {
      mockApi.mockImplementation(() => Promise.reject({ status: 401, error: 'Unauthorized' }));

      const { result } = renderHook(() => useAuth());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockReplace).toHaveBeenCalledWith('/');
      expect(result.current.user).toBeNull();
    });

    it('does NOT redirect when redirectOnFail=false', async () => {
      mockApi.mockImplementation(() => Promise.reject({ status: 401, error: 'Unauthorized' }));

      const { result } = renderHook(() => useAuth(false));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockReplace).not.toHaveBeenCalled();
      expect(result.current.user).toBeNull();
    });

    it('finishes loading even after a rejection', async () => {
      mockApi.mockImplementation(() => Promise.reject(new Error('network down')));

      const { result } = renderHook(() => useAuth(false));

      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });

  describe('cleanup', () => {
    it('does not update state after unmount (no act warnings)', async () => {
      // Promise that resolves AFTER unmount.
      let resolveLater!: (v: unknown) => void;
      mockApi.mockReturnValueOnce(
        new Promise((res) => {
          resolveLater = res;
        }),
      );

      const { result, unmount } = renderHook(() => useAuth());
      unmount();

      resolveLater({ user: sampleUser });

      // Wait a microtask tick — state must not have updated.
      await Promise.resolve();
      expect(result.current.user).toBeNull();
    });

    it('does not redirect if the request rejects AFTER unmount', async () => {
      let rejectLater!: (e: unknown) => void;
      mockApi.mockReturnValueOnce(
        new Promise((_, rej) => {
          rejectLater = rej;
        }),
      );

      const { unmount } = renderHook(() => useAuth(true));
      unmount();

      rejectLater(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();

      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});
