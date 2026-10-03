'use client';

import { useEffect, useState } from 'react';
import { Sparkles, ArrowUpRight, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';

interface BillingUsageResponse {
  plan: 'FREE' | 'INDIE' | 'TEAM';
  billingCycle: string;
  marketplaceStatus: string;
  marketplaceUrl: string;
  usage: {
    billingMonth: string;
    publicReviewsUsed: number;
    privateReviewsUsed: number;
    privateReviewLimit: number | null;
    privateReviewsRemaining: number | null;
    isLimitReached: boolean;
  };
}

export function UsageMeter() {
  const [data, setData] = useState<BillingUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    api<BillingUsageResponse>('/api/billing/usage')
      .then((res) => {
        if (isMounted) setData(res);
      })
      .catch((err) => console.warn('Could not load billing usage:', err))
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  if (loading || !data) return null;

  const { plan, usage, marketplaceUrl } = data;
  const isFree = plan === 'FREE';
  const limit = usage.privateReviewLimit || 50;
  const used = usage.privateReviewsUsed;
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  let barColor = 'var(--accent)';
  if (percentage >= 100) barColor = 'var(--danger)';
  else if (percentage >= 75) barColor = 'var(--warning)';

  return (
    <div className="usage-meter-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isFree ? (
            <Sparkles size={16} color="var(--accent)" />
          ) : (
            <ShieldCheck size={16} color="var(--success)" />
          )}
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {plan === 'FREE' ? 'Free Tier Quota' : `${plan} Plan Active`}
          </span>
        </div>

        <a
          href={marketplaceUrl}
          target="_blank"
          rel="noreferrer"
          className="link-button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}
        >
          {isFree ? 'Upgrade Plan' : 'Manage on GitHub'} <ArrowUpRight size={12} />
        </a>
      </div>

      {isFree ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>
              {used} of {limit} private reviews used ({usage.privateReviewsRemaining ?? 0} left)
            </span>
            <span>{percentage}%</span>
          </div>

          <div className="progress-track">
            <div
              className="progress-bar-fill"
              style={{
                width: `${percentage}%`,
                background: barColor,
              }}
            />
          </div>

          {usage.isLimitReached ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.5rem 0.75rem',
                background: 'rgba(229, 72, 77, 0.12)',
                borderRadius: '6px',
                fontSize: '0.8rem',
                color: '#ff8588',
                marginTop: '0.5rem',
              }}
            >
              <AlertTriangle size={14} />
              <span>
                Monthly private quota reached. Upgrade to <strong>Indie</strong> ($2/mo or $10/yr) for unlimited reviews.
              </span>
            </div>
          ) : (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Public open-source repositories always have <strong>unlimited free reviews</strong>.
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          <CheckCircle2 size={15} color="var(--success)" />
          <span>
            Unlimited private & public reviews active ({used} private reviews run this cycle).
          </span>
        </div>
      )}
    </div>
  );
}
