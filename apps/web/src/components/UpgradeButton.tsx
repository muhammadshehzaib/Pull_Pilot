'use client';

import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { BACKEND_URL } from '../utils/constants';

interface UpgradeButtonProps {
  tier: 'INDIE' | 'TEAM';
  billingCycle: 'monthly' | 'yearly';
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Starts a Polar checkout for a paid tier.
 *
 * Unauthenticated buyers are sent through GitHub OAuth first — the checkout
 * endpoint needs a session to attach the subscription to a PullPilot account.
 */
export function UpgradeButton({
  tier,
  billingCycle,
  className,
  style,
  children,
}: UpgradeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const { url } = await api<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ tier, billingCycle }),
      });
      window.location.href = url;
    } catch (err) {
      const status = (err as ApiError)?.status;
      if (status === 401) {
        window.location.href = `${BACKEND_URL}/api/auth/github`;
        return;
      }
      setError(
        status === 503
          ? 'Checkout is unavailable right now. Please try again shortly.'
          : 'Could not start checkout. Please try again.',
      );
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className={className}
        style={{ width: '100%', cursor: loading ? 'wait' : 'pointer', ...style }}
      >
        {loading ? 'Redirecting…' : children}
      </button>
      {error && (
        <p role="alert" style={{ color: '#dc2626', fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {error}
        </p>
      )}
    </>
  );
}