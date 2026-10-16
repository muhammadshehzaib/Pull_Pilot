import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApi, authUser } = vi.hoisted(() => ({ mockApi: vi.fn(), authUser: { id: 'owner', username: 'owner' } }));
vi.mock('../../lib/api', () => ({ api: mockApi }));
vi.mock('../../lib/useAuth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }));
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => null }));
import RulesPage from './page';

const repo = (id: string, isActive = true) => ({ id, fullName: `owner/${id}`, isActive });
const page = (repositories: ReturnType<typeof repo>[], totalPages = 1) => ({ repositories, pagination: { totalPages } });
beforeEach(() => { mockApi.mockReset(); window.history.replaceState(null, '', '/rules'); });
afterEach(() => window.history.replaceState(null, '', '/rules'));

describe('rules repository selection', () => {
  it('resolves a deep link beyond the newest 50 repositories without opening the first repo', async () => {
    window.history.replaceState(null, '', '/rules?repo=target');
    let finish!: (value: unknown) => void;
    mockApi.mockImplementation(async (path: string) => {
      if (path === '/api/repositories?limit=100&page=1') return page(Array.from({ length: 50 }, (_, i) => repo(`repo-${i}`)), 2);
      if (path === '/api/repositories?limit=100&page=2') return new Promise(resolve => { finish = resolve; });
      if (path === '/api/repositories/target/rules') return { rules: [] };
      throw new Error(`Unexpected path: ${path}`);
    });
    render(<RulesPage />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(mockApi.mock.calls.some(([path]) => path.endsWith('/rules'))).toBe(false);
    await act(async () => finish(page([repo('target')], 2)));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('target'));
    expect(mockApi).toHaveBeenCalledWith('/api/repositories/target/rules');
  });

  it.each(['missing', 'inactive'])('does not silently substitute another repository for a %s deep link', async target => {
    window.history.replaceState(null, '', `/rules?repo=${target}`);
    mockApi.mockImplementation(async (path: string) => path.startsWith('/api/repositories?')
      ? page([repo('first'), repo('inactive', false)]) : { rules: [] });
    const user = userEvent.setup(); render(<RulesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('requested repository is missing or inactive');
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('');
    expect(mockApi.mock.calls.some(([path]) => path.endsWith('/rules'))).toBe(false);
    expect(screen.getByRole('button', { name: /Add rule/ })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'first');
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/api/repositories/first/rules'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports repository load failure and retries without pretending the account is empty', async () => {
    mockApi.mockRejectedValueOnce(new Error('offline')).mockImplementation(async path => path.startsWith('/api/repositories?') ? page([repo('first')]) : { rules: [] });
    const user = userEvent.setup(); render(<RulesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText(/No connected repositories/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry repositories' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('first'));
  });
});
