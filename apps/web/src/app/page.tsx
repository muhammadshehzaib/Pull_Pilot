'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Cpu,
  GitBranch,
  Star,
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
  Zap,
  Sparkles,
  ArrowRight,
  Eye,
  Lock,
} from 'lucide-react';
import { BACKEND_URL, GITHUB_APP_INSTALL_URL } from '../utils/constants';
import { useAuth } from '../lib/useAuth';
import { Navbar } from '../components/Navbar';
import { MarqueeShowcase } from '../components/MarqueeShowcase';
import { InteractiveDiffPlayground } from '../components/InteractiveDiffPlayground';
import { BentoFeatures } from '../components/BentoFeatures';
import { ComparisonSection } from '../components/ComparisonSection';
import { UseCasesSection } from '../components/UseCasesSection';
import { TestimonialsSection } from '../components/TestimonialsSection';
import { FaqAccordion } from '../components/FaqAccordion';
import { UpgradeButton } from '../components/UpgradeButton';
import { BrandLogo } from '../components/BrandLogo';
import { Footer } from '../components/Footer';

export default function HomePage() {
  const { user } = useAuth(false);
  const [annualBilling, setAnnualBilling] = useState(false);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#ffffff' }}>
      {/* Floating Pill Navigation */}
      <Navbar user={user} />

      {/* Hero Section */}
      <section style={{ position: 'relative', width: '100%', overflow: 'hidden', paddingTop: '7.5rem', paddingBottom: '2rem' }}>
        {/* Sky Aura Radial Gradient Backdrop */}
        <div className="hero-aura-wrapper">
          <div className="hero-aura-gradient" />
          <div className="hero-aura-fade" />
        </div>

        {/* Hero Content Container */}
        <div
          style={{
            position: 'relative',
            maxWidth: 1140,
            margin: '0 auto',
            padding: '2.5rem 1.5rem 2rem',
            textAlign: 'center',
            zIndex: 1,
          }}
        >
          {/* Top Star Rating Pill */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.75rem' }}>
            <div className="badge-social-proof">
              <div style={{ display: 'flex', gap: '2px' }}>
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={14} fill="#ffc531" color="#ffc531" stroke="none" />
                ))}
              </div>
              <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>4.98 stars across 12,000+ reviews</span>
            </div>
          </div>

          {/* Main Hero Headline */}
          <h1
            className="hero-title-responsive"
            style={{
              fontSize: 'clamp(2.75rem, 6.2vw, 5.25rem)',
              fontWeight: 800,
              letterSpacing: '-0.04em',
              lineHeight: 1.05,
              color: '#ffffff',
              maxWidth: 960,
              margin: '0 auto 1.5rem',
              textShadow: '0 2px 20px rgba(0, 30, 100, 0.25)',
            }}
          >
            Get Flawless PR Reviews
            <br />
            by Default in Seconds
          </h1>

          {/* Platform Pills & Subtitle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
              fontSize: 'clamp(1.1rem, 2vw, 1.35rem)',
              fontWeight: 500,
              color: 'rgba(255, 255, 255, 0.95)',
              maxWidth: 780,
              margin: '0 auto 2.25rem',
              lineHeight: 1.5,
            }}
          >
            <span>Generate AI Reviews for</span>

            {/* Platform Icons with Aceternity subtle float */}
            <span className="animate-float" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', verticalAlign: 'middle' }}>
              {/* GitHub */}
              <span
                className="inline-platform-chip"
                title="GitHub"
                style={{ background: '#000000', transform: 'rotate(-6deg)' }}
              >
                <GitBranch size={19} />
              </span>
              {/* GitLab */}
              <span
                className="inline-platform-chip"
                title="GitLab"
                style={{ background: '#e24329', transform: 'rotate(4deg)', marginLeft: -6 }}
              >
                <Cpu size={19} />
              </span>
            </span>

            <span>that</span>

            {/* Zero bugs pill */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 12px',
                borderRadius: 9999,
                background: 'rgba(255, 255, 255, 0.25)',
                border: '1px solid rgba(255, 255, 255, 0.5)',
                backdropFilter: 'blur(8px)',
                fontWeight: 700,
                color: '#ffffff',
                fontSize: '0.92rem',
              }}
            >
              <Zap size={15} fill="#ffffff" /> ship zero bugs
            </span>
          </div>

          {/* Hero CTAs */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '1rem',
              flexWrap: 'wrap',
              marginBottom: '2rem',
            }}
          >
            <a
              href={GITHUB_APP_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary-pill btn-shimmer"
              style={{
                fontSize: '1.05rem',
                padding: '0.85rem 1.85rem',
                gap: '0.6rem',
              }}
            >
              <GitBranch size={19} />
              <span>Install GitHub App</span>
              <ChevronRight size={18} />
            </a>
            <a
              href="#demo"
              className="btn-secondary-pill"
              style={{
                fontSize: '1.05rem',
                padding: '0.85rem 1.75rem',
              }}
            >
              Explore Live Demo
            </a>
          </div>

          {/* Trust proof */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '0.85rem',
              flexWrap: 'wrap',
              fontSize: '0.88rem',
              color: '#1e293b',
              fontWeight: 600,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(8px)',
                padding: '5px 14px',
                borderRadius: 9999,
                border: '1px solid rgba(0, 0, 0, 0.08)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
              }}
            >
              <CheckCircle2 size={16} color="#10b981" /> Unlimited Public Repos
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(8px)',
                padding: '5px 14px',
                borderRadius: 9999,
                border: '1px solid rgba(0, 0, 0, 0.08)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
              }}
            >
              <CheckCircle2 size={16} color="#10b981" /> 50 Free Private Reviews/Mo
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(8px)',
                padding: '5px 14px',
                borderRadius: 9999,
                border: '1px solid rgba(0, 0, 0, 0.08)',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
              }}
            >
              <CheckCircle2 size={16} color="#10b981" /> Zero markup on your AI spend
            </span>
          </div>
        </div>
      </section>

      {/* Infinite Scrolling PR Review Marquee Showcase */}
      <MarqueeShowcase />

      {/* Interactive PR Diff Review Simulator */}
      <InteractiveDiffPlayground />

      {/* "Why PullPilot?" Bento Grid */}
      <BentoFeatures />

      {/* Competitor Comparison Section (CodeRabbit, Copilot PR) */}
      <ComparisonSection />

      {/* Use Cases Section */}
      <UseCasesSection />

      {/* Pricing Section */}
      <section id="pricing" className="bg-dot-pattern" style={{ maxWidth: 1140, margin: '0 auto', padding: '4rem 1.5rem 6rem', textAlign: 'center', borderRadius: 28 }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem', background: '#ffffff' }}>
          <Sparkles size={14} color="#2563eb" />
          <span>Platform Fee Only — Zero AI Markup</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          You pay for the AI. We charge for the platform.
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 620, margin: '0 auto 2rem' }}>
          Every review runs on your own Gemini, OpenAI, Claude, or Grok key — billed straight to you by
          that provider. We add nothing to your AI spend. All you pay here is the review engine itself.
        </p>

        {/* Monthly / Annual Switch */}
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '3rem' }}>
          <div className="pill-switch-container">
            <button
              onClick={() => setAnnualBilling(false)}
              className={`pill-switch-btn ${!annualBilling ? 'pill-switch-active' : ''}`}
            >
              Monthly Billing
            </button>
            <button
              onClick={() => setAnnualBilling(true)}
              className={`pill-switch-btn ${annualBilling ? 'pill-switch-active' : ''}`}
            >
              Annual Billing{' '}
              <span style={{ color: '#10b981', fontWeight: 700 }}>(Save up to 58%)</span>
            </button>
          </div>
        </div>

        {/* 3 Pricing Cards in 1 Row */}
        <div className="pricing-grid-3col">
          {/* Free Tier */}
          <div className="pricing-card-v2">
            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Free Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For open-source projects and solo side-project builders.
            </p>

            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '1.75rem' }}>
              $0 <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>/ forever</span>
            </div>

            <a
              href={`${BACKEND_URL}/api/auth/github`}
              className="btn-secondary-pill"
              style={{ width: '100%', marginBottom: '2rem' }}
            >
              Get Started Free
            </a>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#475569' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Your Own AI Key — <strong>0% markup</strong></li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Unlimited Public Repos</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> 50 Private Reviews / month</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> .aipr.yml Configuration</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Standard Queue Speed</li>
            </ul>
          </div>

          {/* Indie Tier (Featured) */}
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
              BEST VALUE
            </div>

            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Indie Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For professional solo devs shipping private code every day.
            </p>

            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '0.35rem' }}>
              {annualBilling ? '$10' : '$2'}{' '}
              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>
                {annualBilling ? '/ year' : '/ month'}
              </span>
            </div>

            {annualBilling ? (
              <p style={{ color: '#10b981', fontSize: '0.84rem', fontWeight: 700, marginBottom: '1.75rem' }}>
                Just $0.83/mo — you save $14 a year
              </p>
            ) : (
              <p style={{ color: '#64748b', fontSize: '0.84rem', marginBottom: '1.75rem' }}>
                Switch to annual and <strong style={{ color: '#10b981' }}>save $14 a year</strong>
              </p>
            )}

            <UpgradeButton
              tier="INDIE"
              billingCycle={annualBilling ? 'yearly' : 'monthly'}
              className="btn-primary-pill"
              style={{ marginBottom: '2rem' }}
            >
              Subscribe Now <ArrowRight size={14} />
            </UpgradeButton>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#334155' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Your Own AI Key — <strong>0% markup, always</strong></li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> <strong>Unlimited</strong> Private Reviews</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Unlimited Public Reviews</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Priority Review Queue</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Switch Models Anytime</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#2563eb" /> Email & GitHub Support</li>
            </ul>
          </div>

          {/* Team Tier */}
          <div className="pricing-card-v2">
            <h3 style={{ fontSize: '1.35rem', marginBottom: '0.5rem', color: '#0f172a' }}>Team Plan</h3>
            <p style={{ color: '#64748b', fontSize: '0.88rem', marginBottom: '1.75rem', minHeight: '2.6rem' }}>
              For engineering teams and growing SaaS companies.
            </p>

            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: '#0f172a', marginBottom: '1.75rem' }}>
              {annualBilling ? '$50' : '$5'} <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 400 }}>/ user{annualBilling ? ' / year' : ' / mo'}</span>
            </div>

            <UpgradeButton
              tier="TEAM"
              billingCycle={annualBilling ? 'yearly' : 'monthly'}
              className="btn-secondary-pill"
              style={{ marginBottom: '2rem' }}
            >
              Upgrade Team <ArrowRight size={14} />
            </UpgradeButton>

            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.88rem', color: '#475569' }}>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Everything in Indie Plan</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Org-Wide App Installation</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Seat Pooling & Shared Invoicing</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Centralized Team AI Keys</li>
              <li style={{ display: 'flex', gap: '0.6rem' }}><CheckCircle2 size={17} color="#10b981" /> Custom Security Policy Enforcement</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <TestimonialsSection />

      {/* FAQ Accordion */}
      <FaqAccordion />

      {/* Pre-Footer Radiant Sky CTA Banner */}
      <section style={{ maxWidth: 1140, margin: '0 auto 6rem', padding: '0 1.5rem', width: '100%' }}>
        <div className="cta-sky-banner" style={{ padding: '4rem 2rem', textAlign: 'center', color: '#ffffff' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '1.25rem' }}>
            <div className="badge-social-proof">
              <Sparkles size={14} color="#ffffff" />
              <span>Get Started in 60 Seconds</span>
            </div>
          </div>

          <h2
            style={{
              fontSize: 'clamp(2.25rem, 4.5vw, 3.5rem)',
              fontWeight: 800,
              color: '#ffffff',
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              maxWidth: 720,
              margin: '0 auto 1.25rem',
            }}
          >
            Ready to Review Code 10x Faster by Default?
          </h2>

          <p
            style={{
              color: 'rgba(255, 255, 255, 0.9)',
              fontSize: '1.1rem',
              maxWidth: 580,
              margin: '0 auto 2.25rem',
              lineHeight: 1.6,
            }}
          >
            Authorize the GitHub App with 1 click. Zero training on your codebase. Free forever for open-source.
          </p>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <a
              href={GITHUB_APP_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary-pill"
              style={{
                fontSize: '1.05rem',
                padding: '0.85rem 1.85rem',
                background: '#ffffff',
                color: '#0f172a !important',
                fontWeight: 700,
              }}
            >
              <GitBranch size={18} /> Install GitHub App
            </a>
            <Link
              href="/pricing"
              className="btn-secondary-pill"
              style={{
                fontSize: '1.05rem',
                padding: '0.85rem 1.75rem',
                background: 'rgba(255, 255, 255, 0.2)',
                color: '#ffffff !important',
                borderColor: 'rgba(255, 255, 255, 0.4)',
              }}
            >
              View All Plans
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <Footer />
    </div>
  );
}
