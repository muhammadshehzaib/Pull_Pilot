import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthUser } from '../lib/useAuth';

const { mockReplace, mockPathname, mockApi } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockPathname: vi.fn(() => '/dashboard'),
  mockApi: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname(),
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
    Activity: stub('Activity'),
    Cpu: stub('Cpu'),
    Key: stub('Key'),
    GitBranch: stub('GitBranch'),
    LogOut: stub('LogOut'),
    History: stub('History'),
    ShieldCheck: stub('ShieldCheck'),
  };
});

vi.mock('../lib/api', () => ({ api: mockApi }));

import { Sidebar } from './Sidebar';

const user: AuthUser = {
  id: 'u-1',
  githubId: 'gh-1',
  username: 'octocat',
  email: 'octo@example.com',
  avatarUrl: 'https://example.com/avatar.png',
};

describe('<Sidebar />', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockApi.mockReset();
    mockPathname.mockReturnValue('/dashboard');
  });

  describe('rendering', () => {
    it('renders all five nav links', () => {
      render(<Sidebar user={user} />);

      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Repositories')).toBeInTheDocument();
      expect(screen.getByText('Engineering Rules')).toBeInTheDocument();
      expect(screen.getByText('History')).toBeInTheDocument();
      expect(screen.getByText('API Key Vault')).toBeInTheDocument();
    });

    it('marks the current pathname link as active', () => {
      mockPathname.mockReturnValue('/repositories');
      render(<Sidebar user={user} />);

      const link = screen.getByText('Repositories').closest('a')!;
      expect(link).toHaveAttribute('data-active', 'true');
    });

    it('marks non-current links as inactive', () => {
      mockPathname.mockReturnValue('/repositories');
      render(<Sidebar user={user} />);

      expect(screen.getByText('Dashboard').closest('a')).toHaveAttribute(
        'data-active',
        'false',
      );
    });

    it('matches the active link via startsWith (deep route stays active)', () => {
      mockPathname.mockReturnValue('/dashboard/some-sub-page');
      render(<Sidebar user={user} />);

      expect(screen.getByText('Dashboard').closest('a')).toHaveAttribute(
        'data-active',
        'true',
      );
    });

    it('shows the username when a user is supplied', () => {
      render(<Sidebar user={user} />);
      expect(screen.getByText('octocat')).toBeInTheDocument();
    });

    it('does NOT render the user card when user is null', () => {
      render(<Sidebar user={null} />);
      expect(screen.queryByText('octocat')).not.toBeInTheDocument();
      expect(screen.queryByText(/Sign out/i)).not.toBeInTheDocument();
    });

    it('renders the avatar img when avatarUrl is present', () => {
      render(<Sidebar user={user} />);
      const img = screen.getByAltText('octocat') as HTMLImageElement;
      expect(img.src).toBe(user.avatarUrl);
    });

    it('does NOT render an avatar img when avatarUrl is null', () => {
      render(<Sidebar user={{ ...user, avatarUrl: null }} />);
      expect(screen.queryByAltText('octocat')).not.toBeInTheDocument();
    });
  });

  describe('connection indicator', () => {
    it('shows "Connected" when isConnected=true', () => {
      render(<Sidebar user={user} isConnected={true} />);
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('shows "Offline" when isConnected=false', () => {
      render(<Sidebar user={user} isConnected={false} />);
      expect(screen.getByText('Offline')).toBeInTheDocument();
    });

    it('hides the indicator entirely when isConnected is undefined', () => {
      render(<Sidebar user={user} />);
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });
  });

  describe('logout', () => {
    it('calls /api/auth/logout with POST then redirects to /', async () => {
      mockApi.mockImplementation(() => Promise.resolve(null));

      render(<Sidebar user={user} />);
      await userEvent.click(screen.getByRole('button', { name: /Sign out/i }));

      expect(mockApi).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    it('keeps the user signed in and offers a retry when logout fails', async () => {
      mockApi.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(null);
      render(<Sidebar user={user} />);
      await userEvent.click(screen.getByRole('button', { name: /Sign out/i }));
      expect(mockReplace).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent('You are still signed in');
      await userEvent.click(screen.getByRole('button', { name: /Sign out/i }));
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });
});
