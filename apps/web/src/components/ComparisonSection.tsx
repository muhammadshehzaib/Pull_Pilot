'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CheckCircle2,
  X,
  Sparkles,
  Zap,
  ShieldCheck,
  Cpu,
  Lock,
  ArrowRight,
  GitBranch,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { BRAND_NAME } from '../config/brand';

interface CompetitorComparison {
  feature: string;
  category: string;
  pullpilot: { supported: boolean; detail: string };
  coderabbit: { supported: boolean; detail: string };
  copilotPr: { supported: boolean; detail: string };
  sourcery: { supported: boolean; detail: string };
}

const COMPARISON_DATA: CompetitorComparison[] = [
  {
    feature: 'Multi-Model Freedom (Claude 5, ChatGPT 5.6, Gemini 3.0, Grok 4)',
    category: 'AI Engine',
    pullpilot: { supported: true, detail: 'Choose any model or BYOK per repo' },
    coderabbit: { supported: false, detail: 'Vendor-locked model stack' },
    copilotPr: { supported: false, detail: 'Limited to default OpenAI base' },
    sourcery: { supported: false, detail: 'Proprietary model only' },
  },
  {
    feature: 'No Training On Your Code',
    category: 'Security & Privacy',
    pullpilot: { supported: true, detail: 'Never used to train any model' },
    coderabbit: { supported: true, detail: 'Encrypted storage policies' },
    copilotPr: { supported: false, detail: 'Telemetry collection opt-in' },
    sourcery: { supported: false, detail: 'Cloud index retention' },
  },
  {
    feature: '100% Auditable Open Core (GNU AGPL-3.0)',
    category: 'Transparency',
    pullpilot: { supported: true, detail: 'Inspect all prompts, workers & self-host' },
    coderabbit: { supported: false, detail: 'Closed proprietary black box' },
    copilotPr: { supported: false, detail: 'Closed proprietary SaaS' },
    sourcery: { supported: false, detail: 'Closed source' },
  },
  {
    feature: 'Git-Native Rules Config (.aipr.yml in repo root)',
    category: 'Workflow',
    pullpilot: { supported: true, detail: 'Version-controlled in git branch history' },
    coderabbit: { supported: true, detail: 'YAML & Web UI configuration' },
    copilotPr: { supported: false, detail: 'Limited organization rules' },
    sourcery: { supported: true, detail: 'YAML config file' },
  },
  {
    feature: 'Bring-Your-Own-Key (BYOK) AES-256 Vault',
    category: 'Cost Control',
    pullpilot: { supported: true, detail: 'Platform fee only — you pay AI at provider rates, 0% markup' },
    coderabbit: { supported: false, detail: 'Must purchase full price tier' },
    copilotPr: { supported: false, detail: 'Bundled GitHub subscription only' },
    sourcery: { supported: false, detail: 'Not supported' },
  },
  {
    feature: '1-Click Inline Mergable Code Patches',
    category: 'Developer Experience',
    pullpilot: { supported: true, detail: 'Native GitHub diff suggestions with single-click commit' },
    coderabbit: { supported: true, detail: 'Inline suggested changes' },
    copilotPr: { supported: true, detail: 'Inline suggestions' },
    sourcery: { supported: false, detail: 'High level comments only' },
  },
  {
    feature: 'Starting Price & Free Tier',
    category: 'Value',
    pullpilot: { supported: true, detail: '$0 free tier • $2/mo or $10/yr Indie' },
    coderabbit: { supported: false, detail: '$15–$24/user/mo minimum, AI bundled' },
    copilotPr: { supported: false, detail: '$19–$39/user/mo GitHub suite' },
    sourcery: { supported: false, detail: '$10–$20/user/mo' },
  },
];

export function ComparisonSection() {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  const categories = ['ALL', 'AI Engine', 'Security & Privacy', 'Transparency', 'Cost Control', 'Value'];

  const filteredData =
    selectedCategory === 'ALL'
      ? COMPARISON_DATA
      : COMPARISON_DATA.filter((item) => item.category === selectedCategory);

  return (
    <section
      id="compare"
      style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: '5rem 1.5rem 6rem',
      }}
    >
      {/* Section Header */}
      <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem', background: '#ffffff' }}>
          <Sparkles size={14} color="#2563eb" />
          <span>Transparent Competitive Advantage</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          How PullPilot Compares to CodeRabbit &amp; Copilot
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 640, margin: '0 auto' }}>
          See why fast-moving engineering teams choose PullPilot over legacy, expensive black-box review bots.
        </p>
      </div>

      {/* Filter Tabs */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
          marginBottom: '2.5rem',
        }}
      >
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            style={{
              padding: '0.45rem 1rem',
              borderRadius: 9999,
              fontSize: '0.84rem',
              fontWeight: 600,
              color: selectedCategory === cat ? '#ffffff' : '#64748b',
              background: selectedCategory === cat ? '#0f172a' : '#f1f5f9',
              boxShadow: selectedCategory === cat ? '0 4px 12px rgba(15,23,42,0.2)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Comparison Table / Matrix */}
      <div
        className="aceternity-glow-card"
        style={{
          padding: 0,
          overflowX: 'auto',
          borderRadius: 20,
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            textAlign: 'left',
            minWidth: 720,
          }}
        >
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <th style={{ padding: '1.25rem 1.5rem', fontSize: '0.88rem', color: '#64748b', fontWeight: 600, width: '34%' }}>
                Capability
              </th>
              {/* PullPilot (Hero Column) */}
              <th
                style={{
                  padding: '1.25rem 1.5rem',
                  fontSize: '0.95rem',
                  color: '#0f172a',
                  fontWeight: 800,
                  background: 'linear-gradient(180deg, rgba(37,99,235,0.08) 0%, rgba(37,99,235,0.02) 100%)',
                  borderLeft: '2px solid #2563eb',
                  borderRight: '2px solid #2563eb',
                  width: '26%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <BrandLogo size={22} />
                  <span>{BRAND_NAME}</span>
                  <span
                    style={{
                      fontSize: '0.65rem',
                      background: '#2563eb',
                      color: '#ffffff',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontWeight: 700,
                    }}
                  >
                    YOU ARE HERE
                  </span>
                </div>
              </th>
              <th style={{ padding: '1.25rem 1.25rem', fontSize: '0.88rem', color: '#64748b', fontWeight: 600, width: '20%' }}>
                CodeRabbit
              </th>
              <th style={{ padding: '1.25rem 1.25rem', fontSize: '0.88rem', color: '#64748b', fontWeight: 600, width: '20%' }}>
                GitHub Copilot PR
              </th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {filteredData.map((row, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: '1px solid rgba(0,0,0,0.05)',
                    background: idx % 2 === 0 ? '#ffffff' : '#fafafa',
                  }}
                >
                  {/* Feature Title */}
                  <td style={{ padding: '1.2rem 1.5rem' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#0f172a', marginBottom: '2px' }}>
                      {row.feature}
                    </div>
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {row.category}
                    </span>
                  </td>

                  {/* PullPilot Column */}
                  <td
                    style={{
                      padding: '1.2rem 1.5rem',
                      background: 'rgba(37,99,235,0.02)',
                      borderLeft: '2px solid #2563eb',
                      borderRight: '2px solid #2563eb',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      <CheckCircle2 size={18} color="#10b981" style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <strong style={{ fontSize: '0.85rem', color: '#0f172a', display: 'block' }}>Supported</strong>
                        <span style={{ fontSize: '0.78rem', color: '#2563eb', fontWeight: 500 }}>{row.pullpilot.detail}</span>
                      </div>
                    </div>
                  </td>

                  {/* CodeRabbit */}
                  <td style={{ padding: '1.2rem 1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      {row.coderabbit.supported ? (
                        <CheckCircle2 size={16} color="#64748b" style={{ flexShrink: 0, marginTop: 2 }} />
                      ) : (
                        <X size={16} color="#94a3b8" style={{ flexShrink: 0, marginTop: 2 }} />
                      )}
                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{row.coderabbit.detail}</span>
                    </div>
                  </td>

                  {/* GitHub Copilot PR */}
                  <td style={{ padding: '1.2rem 1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      {row.copilotPr.supported ? (
                        <CheckCircle2 size={16} color="#64748b" style={{ flexShrink: 0, marginTop: 2 }} />
                      ) : (
                        <X size={16} color="#94a3b8" style={{ flexShrink: 0, marginTop: 2 }} />
                      )}
                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{row.copilotPr.detail}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {/* Summary Highlight Callout Banner */}
      <div
        style={{
          marginTop: '2.5rem',
          padding: '1.75rem 2rem',
          borderRadius: 16,
          background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
          border: '1px solid rgba(37,99,235,0.2)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1.25rem',
        }}
      >
        <div>
          <h3 style={{ fontSize: '1.1rem', color: '#1e3a8a', marginBottom: '0.25rem' }}>
            Looking for a transparent CodeRabbit alternative?
          </h3>
          <p style={{ fontSize: '0.88rem', color: '#3b82f6' }}>
            Switch in 60 seconds with our zero-configuration GitHub App installation.
          </p>
        </div>

        <a
          href="#demo"
          className="btn-primary-pill btn-shimmer"
          style={{ fontSize: '0.88rem', padding: '0.6rem 1.35rem' }}
        >
          <span>Try Interactive Demo</span>
          <ArrowRight size={15} />
        </a>
      </div>
    </section>
  );
}
