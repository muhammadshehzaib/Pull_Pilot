'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Activity, Key, GitBranch, LogOut, History, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { AuthUser } from '../lib/useAuth';
import { BrandLogo } from './BrandLogo';
import { BRAND_NAME } from '../config/brand';

interface SidebarProps {
  user: AuthUser | null;
  isConnected?: boolean;
}

interface NavItem {
  href: string;
  label: string;
  Icon: typeof Activity;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', Icon: Activity },
  { href: '/repositories', label: 'Repositories', Icon: GitBranch },
  { href: '/rules', label: 'Engineering Rules', Icon: ShieldCheck },
  { href: '/history', label: 'History', Icon: History },
  { href: '/vault', label: 'API Key Vault', Icon: Key },
];

export function Sidebar({ user, isConnected }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      router.replace('/');
    } catch {
      setLogoutError('Sign out failed. You are still signed in. Please retry.');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <aside className="sidebar">
      <Link
        href="/dashboard"
        style={{
          marginBottom: '2rem',
          padding: '0 0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.65rem',
          textDecoration: 'none',
          cursor: 'pointer',
        }}
      >
        <BrandLogo size={24} />
        <span style={{ fontWeight: 700, fontSize: '0.95rem', letterSpacing: '-0.02em', color: '#0f172a' }}>
          {BRAND_NAME}
        </span>
      </Link>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV.map(({ href, label, Icon }) => {
          const active = pathname?.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className="nav-link"
              data-active={active ? 'true' : 'false'}
            >
              <Icon size={16} strokeWidth={2} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {typeof isConnected === 'boolean' && (
          <div className="status-badge" style={{ gap: '8px' }}>
            <div
              className="status-dot"
              style={{ background: isConnected ? 'var(--success)' : 'var(--danger)' }}
            />
            {isConnected ? 'Connected' : 'Offline'}
          </div>
        )}

        {user ? (
          <div className="user-card">
            {user.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt={user.username} className="avatar" />
            )}
            <div style={{ overflow: 'hidden' }}>
              <div
                style={{
                  fontWeight: 500,
                  fontSize: '0.85rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {user.username}
              </div>
              {logoutError && <p role="alert">{logoutError}</p>}
              <button onClick={handleLogout} className="link-button" disabled={loggingOut}>
                <LogOut size={11} /> Sign out
              </button>
            </div>
          </div>
        ) : (
          <div className="user-card sidebar-skeleton-user">
            <div className="skeleton skeleton-avatar" />
            <div className="sidebar-skeleton-text-group">
              <div className="skeleton skeleton-line-lg" />
              <div className="skeleton skeleton-line-md" />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
