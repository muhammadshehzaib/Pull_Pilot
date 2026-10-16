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
  it('reports a rules load failure without showing an empty list and retries', async () => {
    let failed = true;
    mockApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/repositories?')) return page([repo('first')]);
      if (failed) throw new Error('offline');
      return { rules: [] };
    });
    const user = userEvent.setup(); render(<RulesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rules could not be loaded');
    expect(screen.queryByText(/No rules for this repository/)).toBeNull();
    failed = false; await user.click(screen.getByRole('button', { name: 'Retry rules' }));
    expect(await screen.findByText(/No rules for this repository/)).toBeInTheDocument();
  });
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
    expect(mockApi).toHaveBeenCalledWith('/api/repositories/target/rules', expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/api/repositories/first/rules', expect.objectContaining({ signal: expect.any(AbortSignal) })));
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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const rule = (name: string) => ({ id: name, name, enabled: true, revision: 0, enforcement: 'LLM', severity: 'HIGH', category: 'BUG', guideline: 'Check it' });
describe('rules request ordering', () => {
  it.each(['resolve', 'reject'] as const)('ignores a late request %s after another repository finishes loading', async finish => {
    const first = deferred<any>();
    mockApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/repositories?')) return page([repo('first'), repo('second')]);
      if (path === '/api/repositories/first/rules') return first.promise;
      return { rules: [rule('Second repository rule')] };
    });
    const user = userEvent.setup(); render(<RulesPage />);
    await waitFor(() => expect(mockApi.mock.calls.some(([path]) => path === '/api/repositories/first/rules')).toBe(true));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'second');
    await screen.findByText('Second repository rule');
    await act(async () => { if (finish === 'resolve') first.resolve({ rules: [rule('Stale rule')] }); else first.reject(new Error('old failure')); });
    expect(screen.getByText('Second repository rule')).toBeInTheDocument();
    expect(screen.queryByText('Stale rule')).toBeNull();
    expect(screen.queryByText(/Loading rules/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps the newest response when switching away and back to the same repository', async () => {
    const old = deferred<any>(); let firstCalls = 0;
    mockApi.mockImplementation(async path => {
      if (path.startsWith('/api/repositories?')) return page([repo('first'), repo('second')]);
      if (path === '/api/repositories/first/rules') return ++firstCalls === 1 ? old.promise : { rules: [rule('Latest first rule')] };
      return { rules: [] };
    });
    const user = userEvent.setup(); render(<RulesPage />);
    await waitFor(() => expect(firstCalls).toBe(1));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'second');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'first');
    await screen.findByText('Latest first rule');
    await act(async () => old.resolve({ rules: [rule('Old first rule')] }));
    expect(screen.getByText('Latest first rule')).toBeInTheDocument();
    expect(screen.queryByText('Old first rule')).toBeNull();
  });
  it('does not let an old save refresh another repository or clear its new draft', async () => {
    const save = deferred<any>();
    mockApi.mockImplementation(async (path, init?: RequestInit) => {
      if (path.startsWith('/api/repositories?')) return page([repo('first'), repo('second')]);
      if (init?.method === 'POST') return save.promise;
      return { rules: [] };
    });
    const user = userEvent.setup(); render(<RulesPage />);
    await screen.findByText(/No rules for this repository/);
    await user.type(screen.getByLabelText('Rule name'), 'Rule for first');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Repository' }), 'second');
    await screen.findByText(/No rules for this repository/);
    await user.type(screen.getByLabelText('Rule name'), 'New second draft');
    await act(async () => save.resolve({}));
    expect(screen.getByLabelText('Rule name')).toHaveValue('New second draft');
    expect(screen.queryByText(/Rule "Rule for first" added/)).toBeNull();
    expect(mockApi.mock.calls.filter(([path, init]) => path === '/api/repositories/first/rules' && !init?.method)).toHaveLength(1);
  });
});
