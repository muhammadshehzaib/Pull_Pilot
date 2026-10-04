import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: mockApi,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('lucide-react', () => {
  const stub = (name: string) => (props: any) => (
    <span data-testid={`icon-${name}`} aria-label={name} {...props} />
  );
  return {
    Sparkles: stub('Sparkles'),
    ArrowUpRight: stub('ArrowUpRight'),
    CheckCircle2: stub('CheckCircle2'),
    AlertTriangle: stub('AlertTriangle'),
    ShieldCheck: stub('ShieldCheck'),
  };
});

import { UsageMeter } from './UsageMeter';

describe('UsageMeter component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when API is loading or fails', async () => {
    mockApi.mockRejectedValueOnce(new Error('Network error'));
    const { container } = render(<UsageMeter />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders Free Tier quota with remaining count and progress bar', async () => {
    mockApi.mockResolvedValueOnce({
      plan: 'FREE',
      billingCycle: 'monthly',
      subscriptionStatus: 'active',
      usage: {
        billingMonth: '2026-09',
        publicReviewsUsed: 5,
        privateReviewsUsed: 20,
        privateReviewLimit: 50,
        privateReviewsRemaining: 30,
        isLimitReached: false,
      },
    });

    render(<UsageMeter />);

    await waitFor(() => {
      expect(screen.getByText('Free Tier Quota')).toBeInTheDocument();
      expect(screen.getByText(/20 of 50 private reviews used/)).toBeInTheDocument();
      expect(screen.getByText('40%')).toBeInTheDocument();
      expect(screen.getByText('Upgrade Plan')).toBeInTheDocument();
    });
  });

  it('displays warning alert banner when monthly free quota is reached', async () => {
    mockApi.mockResolvedValueOnce({
      plan: 'FREE',
      billingCycle: 'monthly',
      subscriptionStatus: 'active',
      usage: {
        billingMonth: '2026-09',
        publicReviewsUsed: 12,
        privateReviewsUsed: 50,
        privateReviewLimit: 50,
        privateReviewsRemaining: 0,
        isLimitReached: true,
      },
    });

    render(<UsageMeter />);

    await waitFor(() => {
      expect(screen.getByText(/Monthly private quota reached/i)).toBeInTheDocument();
      expect(screen.getByText('100%')).toBeInTheDocument();
    });
  });

  it('renders active plan status for paid INDIE plan', async () => {
    mockApi.mockResolvedValueOnce({
      plan: 'INDIE',
      billingCycle: 'monthly',
      subscriptionStatus: 'active',
      usage: {
        billingMonth: '2026-09',
        publicReviewsUsed: 40,
        privateReviewsUsed: 120,
        privateReviewLimit: null,
        privateReviewsRemaining: null,
        isLimitReached: false,
      },
    });

    render(<UsageMeter />);

    await waitFor(() => {
      expect(screen.getByText('INDIE Plan Active')).toBeInTheDocument();
      expect(screen.getByText(/Unlimited private & public reviews active/i)).toBeInTheDocument();
      expect(screen.getByText('Manage Billing')).toBeInTheDocument();
    });
  });
});
