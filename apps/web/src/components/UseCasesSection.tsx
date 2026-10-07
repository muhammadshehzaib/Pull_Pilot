'use client';

import { useState } from 'react';
import { Users, ShieldAlert, Sparkles, Rocket, GitPullRequest, CheckCircle2, ArrowRight } from 'lucide-react';

interface UseCase {
  id: string;
  tabLabel: string;
  title: string;
  subtitle: string;
  badge: string;
  stats: { value: string; label: string }[];
  bullets: string[];
}

const USE_CASES: UseCase[] = [
  {
    id: 'startups',
    tabLabel: 'Fast-Growing Startups',
    title: 'Ship 3x Faster Without Review Bottlenecks',
    subtitle: 'Eliminate the 48-hour PR review backlog so your engineers can deploy features the moment code is ready.',
    badge: 'STARTUP AGILITY',
    stats: [
      { value: '78%', label: 'Shorter PR Cycle Time' },
      { value: '2.4s', label: 'Average Review Latency' },
      { value: '0', label: 'Configuration Required' },
    ],
    bullets: [
      'Instant automated feedback posted within seconds of opening any PR',
      'Catches obvious typos, unhandled promise rejections, and missing imports immediately',
      'Frees senior engineers to focus on architectural review instead of syntax nits',
    ],
  },
  {
    id: 'opensource',
    tabLabel: 'Open Source Maintainers',
    title: 'Automate First-Pass Review on Community PRs',
    subtitle: 'Provide polite, structured, line-by-line feedback to external contributors without burning out maintainers.',
    badge: '100% FREE FOR OSS',
    stats: [
      { value: 'Unlimited', label: 'Public Repo Reviews' },
      { value: '99.4%', label: 'Syntax Accuracy' },
      { value: '1-Click', label: 'GitHub App Auth' },
    ],
    bullets: [
      'Unlimited free review quota on all public repositories on GitHub',
      'Consistent, objective guidance for new contributors on project code standards',
      'Findings filtered by the severity threshold in your .aipr.yml config',
    ],
  },
  {
    id: 'security',
    tabLabel: 'Security & Compliance',
    title: 'Catch Vulnerabilities Before They Hit Production',
    subtitle: 'Prevent secrets leakage, timing attacks, SQL injection, and authorization bypasses before code merges.',
    badge: 'ENTERPRISE SECURITY',
    stats: [
      { value: 'OWASP', label: 'Top 10 Guardrails' },
      { value: 'AES-256', label: 'Key Vault Storage' },
      { value: 'Zero', label: 'Code Training Guarantee' },
    ],
    bullets: [
      'Full-codebase context analysis for timing attacks, memory leaks, and SSRF vulnerabilities',
      'API keys securely encrypted with AES-256-GCM and stored only in volatile RAM',
      'SOC-2 friendly posture with zero AI model training on customer code',
    ],
  },
  {
    id: 'solo',
    tabLabel: 'Solo & Indie Developers',
    title: 'A Senior Staff Engineer in Your Corner 24/7',
    subtitle: 'Never ship solo without a second pair of eyes reviewing your architecture, edge cases, and performance.',
    badge: 'INDIE SUPERPOWER',
    stats: [
      { value: '$2/mo', label: 'Unlimited Private Plan' },
      { value: '4+', label: 'AI Models Supported' },
      { value: '24/7', label: 'Always-On Reviewer' },
    ],
    bullets: [
      'Catch subtle race conditions and memory leaks before users notice in production',
      'Get one-click suggested patches directly inside your GitHub pull requests',
      'Switch seamlessly between Anthropic Claude, OpenAI, and Google Gemini models',
    ],
  },
];

export function UseCasesSection() {
  const [activeTab, setActiveTab] = useState<string>('startups');
  const current = USE_CASES.find((u) => u.id === activeTab) || USE_CASES[0];

  return (
    <section id="use-cases" style={{ maxWidth: 1140, margin: '0 auto', padding: '4rem 1.5rem 6rem' }}>
      {/* Section Header */}
      <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem' }}>
          <Users size={14} color="#2563eb" />
          <span>Tailored For Every Workflow</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          Built for High-Velocity Engineering
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 600, margin: '0 auto' }}>
          Whether you are a solo indie hacker or managing hundreds of repositories, PullPilot accelerates your delivery.
        </p>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '2.5rem',
        }}
      >
        {USE_CASES.map((uc) => (
          <button
            key={uc.id}
            onClick={() => setActiveTab(uc.id)}
            style={{
              padding: '0.55rem 1.25rem',
              borderRadius: 9999,
              fontSize: '0.9rem',
              fontWeight: 600,
              color: activeTab === uc.id ? '#ffffff' : '#475569',
              background: activeTab === uc.id ? '#0f172a' : '#f1f5f9',
              boxShadow: activeTab === uc.id ? '0 4px 12px rgba(15, 23, 42, 0.2)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            {uc.tabLabel}
          </button>
        ))}
      </div>

      {/* Active Tab Panel */}
      <div
        className="glass-card"
        style={{
          padding: '2.5rem',
          borderRadius: 24,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '2.5rem',
          alignItems: 'center',
        }}
      >
        {/* Left Column */}
        <div>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#2563eb',
              background: '#eff6ff',
              padding: '4px 10px',
              borderRadius: 9999,
              letterSpacing: '0.04em',
              display: 'inline-block',
              marginBottom: '1rem',
            }}
          >
            {current.badge}
          </span>
          <h3 style={{ fontSize: '1.75rem', marginBottom: '0.75rem', color: '#0f172a', lineHeight: 1.25 }}>
            {current.title}
          </h3>
          <p style={{ color: '#64748b', fontSize: '1rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
            {current.subtitle}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {current.bullets.map((b, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                <CheckCircle2 size={18} color="#10b981" style={{ flexShrink: 0, marginTop: 2 }} />
                <span style={{ fontSize: '0.92rem', color: '#334155' }}>{b}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: Stats Bento */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '1rem' }}>
          {current.stats.map((st, idx) => (
            <div
              key={idx}
              style={{
                background: '#f8fafc',
                borderRadius: 16,
                padding: '1.5rem 1.25rem',
                border: '1px solid rgba(0,0,0,0.05)',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  background: 'linear-gradient(135deg, #007fff 0%, #1211ff 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  marginBottom: '0.25rem',
                }}
              >
                {st.value}
              </div>
              <div style={{ fontSize: '0.8rem', fontWeight: 500, color: '#64748b' }}>{st.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
