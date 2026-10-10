import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { handlers, disconnect, authUser } = vi.hoisted(() => ({ handlers: {} as Record<string, (value?: any) => void>, disconnect: vi.fn(),
  authUser: { id: 'owner', username: 'owner' } }));
vi.mock('socket.io-client', () => ({ default: () => ({ on: (event: string, fn: any) => { handlers[event] = fn; }, disconnect }) }));
vi.mock('../../lib/useAuth', () => ({ useAuth: () => ({ user: authUser, loading: false }) }));
vi.mock('../../components/Sidebar', () => ({ Sidebar: () => <div>Sidebar</div> }));
vi.mock('../../components/UsageMeter', () => ({ UsageMeter: () => <div>Usage quota</div> }));
vi.mock('../../components/EngineeringHealth', () => ({ EngineeringHealth: ({ refreshKey }: { refreshKey: number }) => <div>Health refresh {refreshKey}</div> }));
import DashboardPage from './page';
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('dashboard integration', () => {
  it('preserves live activity and quotas; debounces completion refresh and cleans up', () => {
    const { unmount } = render(<DashboardPage />);
    expect(screen.getByText('Engineering Health')).toBeInTheDocument(); expect(screen.getByText('Usage quota')).toBeInTheDocument();
    act(() => handlers['dashboard:activity']({ jobId: 'job', status: 'ANALYZING', message: 'Analyzing a review' }));
    expect(screen.getByText('Analyzing a review')).toBeInTheDocument(); expect(screen.getByText('Health refresh 0')).toBeInTheDocument();
    act(() => { for (let i = 0; i < 3; i++) handlers['dashboard:activity']({ jobId: 'job', status: 'COMPLETED', message: `Completed ${i}` }); });
    act(() => vi.advanceTimersByTime(1000)); expect(screen.getByText('Health refresh 1')).toBeInTheDocument();
    unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });
});
