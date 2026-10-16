import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const { mockApi, authUser } = vi.hoisted(() => ({ mockApi: vi.fn(), authUser: { id: 'owner', username: 'owner' } }));
vi.mock('../../lib/api', () => ({ api: mockApi }));
vi.mock('../../lib/useAuth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }));
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => null }));
import RepositoriesPage from './page';
beforeEach(() => { mockApi.mockReset(); });
describe('repository load errors', () => {
  it('distinguishes unavailable repositories from a confirmed empty account and retries', async () => {
    mockApi.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ repositories: [], activeCount: 0,
      pagination: { page: 1, totalPages: 1, total: 0, limit: 50 } });
    const user = userEvent.setup(); render(<RepositoriesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText('No repositories connected yet.')).toBeNull();
    expect(screen.queryByText('Connected (0)')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry repositories' }));
    expect(await screen.findByText('No repositories connected yet.')).toBeInTheDocument();
  });
});
