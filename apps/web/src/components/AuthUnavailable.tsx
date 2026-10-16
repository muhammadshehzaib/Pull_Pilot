'use client';

import { Sidebar } from './Sidebar';

export function AuthUnavailable({ error, retry }: { error: string; retry: () => void }) {
  return <div className="dashboard-grid">
    <Sidebar user={null} />
    <main className="main-content">
      <p role="alert">{error}</p>
      <button type="button" className="btn-secondary" onClick={retry}>Retry session check</button>
    </main>
  </div>;
}
