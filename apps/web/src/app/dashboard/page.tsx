'use client';

import { useEffect, useState } from 'react';
import io from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Activity, CheckCircle2, AlertCircle } from 'lucide-react';
import { Sidebar } from '../../components/Sidebar';
import { UsageMeter } from '../../components/UsageMeter';
import { EngineeringHealth } from '../../components/EngineeringHealth';
import { useAuth } from '../../lib/useAuth';
import { AuthUnavailable } from '../../components/AuthUnavailable';
import { BACKEND_URL } from '../../utils/constants';
import { isInProgress, isTerminalFailure, statusLabel } from '../../lib/review';

interface ActivityLog {
  id: string;
  jobId: string;
  message: string;
  status: string;
  timestamp: Date;
}

/**
 * A failed run used to render exactly like a running one — same neutral colour,
 * same pulsing icon — which made the difference between "working" and "broken"
 * invisible in the one feed meant to explain what the system is doing.
 */
function feedAccent(status: string): { color: string; failed: boolean } {
  if (status === 'COMPLETED' || status === 'SKIPPED') {
    return { color: 'var(--success)', failed: false };
  }
  if (isTerminalFailure(status)) {
    return { color: 'var(--danger)', failed: true };
  }
  return { color: isInProgress(status) ? 'var(--accent)' : 'var(--text-secondary)', failed: false };
}

export default function DashboardPage() {
  const { user, loading: authLoading, error: authError, retry: retryAuth } = useAuth();
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [healthRefresh, setHealthRefresh] = useState(0);

  useEffect(() => {
    if (!user) return;
    const socket = io(BACKEND_URL, { withCredentials: true });
    let healthTimer: ReturnType<typeof setTimeout> | undefined;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('dashboard:activity', (data) => {
      const newEntry: ActivityLog = {
        id: Math.random().toString(36).slice(2, 11),
        jobId: data.jobId,
        message: data.message,
        status: data.status,
        timestamp: new Date(),
      };
      setLogs((prev) => [newEntry, ...prev].slice(0, 20));
      if (data.status === 'COMPLETED' && !healthTimer) healthTimer = setTimeout(() => {
        setHealthRefresh(n => n + 1); healthTimer = undefined;
      }, 1000);
    });

    return () => {
      socket.disconnect();
      clearTimeout(healthTimer);
    };
  }, [user]);

  if (authError && !user) return <AuthUnavailable error={authError} retry={retryAuth} />;

  if (authLoading || !user) {
    return <div style={{ padding: '3rem', color: 'var(--text-secondary)' }}>Loading…</div>;
  }

  return (
    <div className="dashboard-grid">
      <Sidebar user={user} isConnected={isConnected} />

      <main className="main-content">
        <header style={{ marginBottom: '1.75rem' }}>
          <h1 className="page-title">Engineering Health</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Evidence-backed PR trends, review activity, and usage across your connected repositories.
          </p>
        </header>

        <UsageMeter />
        <EngineeringHealth key={user.id} refreshKey={healthRefresh} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '2rem' }}>
          <div>
            <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
              <Terminal size={16} strokeWidth={2} />
              <span className="section-label" style={{ marginBottom: 0 }}>Live feed</span>
            </div>

            <div className="glass-card" style={{ minHeight: '500px', padding: '1rem' }}>
              {logs.length === 0 && (
                <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <Activity size={20} strokeWidth={2} style={{ opacity: 0.25, marginBottom: '1rem' }} />
                  <p>No activity yet — reviews stream here in real time.</p>
                </div>
              )}

              <AnimatePresence initial={false}>
                {logs.map((log) => {
                  const accent = feedAccent(log.status);
                  return (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="feed-item"
                    style={{ borderLeftColor: accent.color }}
                  >
                    <div
                      className="mono"
                      style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: 'var(--text-secondary)', fontSize: '0.75rem' }}
                    >
                      <span>Job #{log.jobId.slice(0, 8)}</span>
                      <span title={statusLabel(log.status)}>{log.timestamp.toLocaleTimeString()}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {accent.failed ? (
                        <AlertCircle size={16} strokeWidth={2} color="var(--danger)" />
                      ) : log.status === 'COMPLETED' ? (
                        <CheckCircle2 size={16} strokeWidth={2} color="var(--success)" />
                      ) : (
                        <Activity size={16} strokeWidth={2} />
                      )}
                      <span style={{ color: accent.color }}>
                        {log.message}
                      </span>
                    </div>
                  </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="glass-card">
              <div className="section-label" style={{ marginBottom: '0.75rem' }}>Live updates</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 600 }}>{logs.length}</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>events this session</p>
            </div>

            <div className="glass-card">
              <AlertCircle size={18} strokeWidth={2} style={{ marginBottom: '0.75rem' }} />
              <h3 className="card-title">Trigger a review</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.5rem 0 1rem' }}>
                Pick a connected repository and start a review.
              </p>
              <a href="/repositories" className="btn-secondary" style={{ display: 'inline-flex', textDecoration: 'none' }}>
                Go to repositories
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
