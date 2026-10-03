'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, ShieldCheck, Zap, Sparkles, ExternalLink, GitBranch } from 'lucide-react';
import { PullPilotLogo } from '../../components/PullPilotLogo';
import { Footer } from '../../components/Footer';
import { BACKEND_URL } from '../../lib/api';

export default function PricingPage() {
  const [annual, setAnnual] = useState(false);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#ffffff' }}>
      {/* Floating Pill Nav Header */}
      <header className="nav-pill-wrapper">
        <nav className="nav-pill-container" style={{ position: 'relative' }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}>
            <PullPilotLogo size={28} />
            <span style={{ fontSize: '0.84rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#0f172a' }}>
              pullpilot.ai
            </span>
          </Link>

          <Link href="/" className="btn-secondary-pill" style={{ fontSize: '0.84rem', padding: '0.45rem 1rem' }}>
            <ArrowLeft size={14} /> Back to Home
          </Link>
        </nav>
      </header>

      <main style={{ maxWidth: 1140, margin: '0 auto', padding: '7rem 1.5rem 6rem', textAlign: 'center' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem' }}>
          <Sparkles size={14} color="#2563eb" />
          <span>GitHub Marketplace Billing</span>
        </div>

        <h1 style={{ fontSize: 'clamp(2.25rem, 4vw, 3.25rem)', marginBottom: '0.75rem', color: '#0f172a' }}>
          Predictable Pricing for Developers & Teams
        </h1>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 600, margin: '0 auto 2.5rem' }}>
          You pay the AI providers directly at their own rates. We only charge for the review engine — no markup, ever.
        </p>

        {/* Toggle */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '3.5rem' }}>
          <div className="pill-switch-container">
            <button
              onClick={() => setAnnual(false)}
              className={`pill-switch-btn ${!annual ? 'pill-switch-active' : ''}`}
            >
              Monthly Billing
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`pill-switch-btn ${annual ? 'pill-switch-active' : ''}`}
            >
              Annual Billing <span style={{ color: '#10b981', fontWeight: 700 }}>(Save 58%)</span>
            </button>
          </div>
        </div>

        {/* Cards in 1 Row */}
        <div className="pricing-grid-3col">
          {/* Free */}
          <div className="pricing-card-v2">
            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Free Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For open-source projects and solo builders.
            </p>
            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '1.75rem' }}>
              $0 <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>/ forever</span>
            </div>

            <a href={`${BACKEND_URL}/api/auth/github`} className="btn-secondary-pill" style={{ width: '100%', marginBottom: '2rem' }}>
              Start for Free
            </a>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#475569' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Your Own AI Key — <strong>0% markup</strong></li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Unlimited Public Repositories</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> 50 Private Reviews / month</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> .aipr.yml Configuration</li>
            </ul>
          </div>

          {/* Indie (Featured) */}
          <div className="pricing-card-v2 pricing-card-featured-v2">
            <div
              style={{
                position: 'absolute',
                top: -14,
                right: 24,
                background: 'linear-gradient(135deg, #007fff 0%, #1211ff 100%)',
                color: '#ffffff',
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.25rem 0.85rem',
                borderRadius: 9999,
                boxShadow: '0 4px 12px rgba(18, 17, 255, 0.4)',
                letterSpacing: '0.04em',
              }}
            >
              MOST POPULAR
            </div>

            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Indie Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For professional solo devs shipping private code daily.
            </p>

            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '0.35rem' }}>
              {annual ? '$10' : '$2'}{' '}
              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>
                {annual ? '/ year' : '/ month'}
              </span>
            </div>

            {annual ? (
              <p style={{ color: '#10b981', fontSize: '0.84rem', fontWeight: 700, marginBottom: '1.75rem' }}>
                Just $0.83/mo — you save $14 a year
              </p>
            ) : (
              <p style={{ color: '#64748b', fontSize: '0.84rem', marginBottom: '1.75rem' }}>
                Switch to annual and get <strong style={{ color: '#10b981' }}>2 months free</strong>
              </p>
            )}

            <a
              href="https://github.com/marketplace/ai-pr-reviewer"
              target="_blank"
              rel="noreferrer"
              className="btn-primary-pill"
              style={{ width: '100%', marginBottom: '2rem' }}
            >
              Subscribe on GitHub <ExternalLink size={14} />
            </a>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#334155' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Your Own AI Key — <strong>0% markup, always</strong></li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> <strong>Unlimited</strong> Private Reviews</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Unlimited Public Reviews</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Priority Review Queue</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Email & GitHub Support</li>
            </ul>
          </div>

          {/* Team */}
          <div className="pricing-card-v2">
            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Team Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For organizations with multiple engineers and repositories.
            </p>

            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '1.75rem' }}>
              {annual ? '$100' : '$8'} <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>/ user{annual ? ' / year' : ' / mo'}</span>
            </div>

            <a
              href="https://github.com/marketplace/ai-pr-reviewer"
              target="_blank"
              rel="noreferrer"
              className="btn-secondary-pill"
              style={{ width: '100%', marginBottom: '2rem' }}
            >
              Upgrade Organization <ExternalLink size={14} />
            </a>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#475569' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Everything in Indie Plan</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Org-Wide Installation</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Shared Invoicing & Seat Pooling</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Centralized Team AI Keys</li>
            </ul>
          </div>
        </div>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}
