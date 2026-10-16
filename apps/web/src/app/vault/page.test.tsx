import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const { mockApi, authUser } = vi.hoisted(() => ({ mockApi: vi.fn(), authUser: { id: 'owner', username: 'owner' } }));
vi.mock('../../lib/api', () => ({ api: mockApi }));
vi.mock('../../lib/useAuth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }));
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => null }));
import VaultPage from './page';
beforeEach(() => { mockApi.mockReset(); });
describe('vault load states', () => {
  it('does not offer a replacement while the saved key is still loading', () => {
    mockApi.mockReturnValue(new Promise(() => {})); render(<VaultPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your saved key');
    expect(screen.queryByText('Add your first key')).toBeNull();
    expect(screen.queryByLabelText('API Key')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save key|Update key|Delete/ })).toBeNull();
  });
  it('requires a successful retry before offering changes to an existing key', async () => {
    mockApi.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ vault: { provider: 'CLAUDE', updatedAt: '2026-10-17T00:00:00Z' } });
    const user = userEvent.setup(); render(<VaultPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry before making changes');
    expect(screen.queryByText('Add your first key')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save key|Update key|Delete/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry vault' }));
    expect(await screen.findByText('Active provider: Anthropic Claude')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update key/ })).toBeEnabled();
    expect(mockApi.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });
  it('offers the first-key form only after a successful empty response', async () => {
    mockApi.mockResolvedValueOnce({ vault: null }); render(<VaultPage />);
    expect(await screen.findByText('Add your first key')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save key/ })).toBeEnabled());
  });
});
