import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi } = vi.hoisted(() => ({
  mockApi: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: mockApi,
  BACKEND_URL: 'http://localhost:4000',
}));

import { UpgradeButton } from './UpgradeButton';

const originalLocation = window.location;

function setLocation(href = '') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href },
  });
}

describe('UpgradeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocation();
  });

  afterAll(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('posts the tier and billing cycle, then redirects to the Polar URL', async () => {
    mockApi.mockResolvedValueOnce({ url: 'https://polar.sh/checkout/abc' });
    const user = userEvent.setup();

    render(
      <UpgradeButton tier="INDIE" billingCycle="yearly">
        Subscribe Now
      </UpgradeButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Subscribe Now' }));

    await waitFor(() => {
      expect(mockApi).toHaveBeenCalledWith('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ tier: 'INDIE', billingCycle: 'yearly' }),
      });
      expect(window.location.href).toBe('https://polar.sh/checkout/abc');
    });
  });

  it('sends unauthenticated buyers through GitHub OAuth', async () => {
    mockApi.mockRejectedValueOnce({ status: 401, error: 'Unauthorized' });
    const user = userEvent.setup();

    render(
      <UpgradeButton tier="TEAM" billingCycle="monthly">
        Upgrade Team
      </UpgradeButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Upgrade Team' }));

    await waitFor(() => {
      expect(window.location.href).toBe('http://localhost:4000/api/auth/github');
    });
  });

  it('shows an error message when billing is unavailable', async () => {
    mockApi.mockRejectedValueOnce({ status: 503, error: 'Billing is not available right now' });
    const user = userEvent.setup();

    render(
      <UpgradeButton tier="INDIE" billingCycle="monthly">
        Subscribe Now
      </UpgradeButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Subscribe Now' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Checkout is unavailable right now');
    expect(window.location.href).toBe('');
    expect(screen.getByRole('button', { name: 'Subscribe Now' })).toBeEnabled();
  });

  it('shows a generic error for unexpected failures', async () => {
    mockApi.mockRejectedValueOnce(new Error('network down'));
    const user = userEvent.setup();

    render(
      <UpgradeButton tier="INDIE" billingCycle="monthly">
        Subscribe Now
      </UpgradeButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Subscribe Now' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start checkout. Please try again.');
  });
});