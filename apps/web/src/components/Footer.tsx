'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  Terminal,
  Zap,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { BRAND_NAME } from '../config/brand';
import { CODE_HANDLING_BADGE } from '../config/privacy';

export function Footer() {
  const [isWatermarkHovered, setIsWatermarkHovered] = useState(false);

  return (
    <footer
      style={{
        background: '#ffffff',
        borderTop: '1px solid rgba(0, 0, 0, 0.06)',
        paddingTop: '5rem',
        paddingBottom: '0rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 1.5rem' }}>
        {/* Top 8-Column Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))',
            gap: '2.5rem 1.5rem',
            marginBottom: '3.5rem',
          }}
        >
          {/* Brand Column */}
          <div style={{ gridColumn: 'span 2', minWidth: 220 }}>
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                textDecoration: 'none',
                marginBottom: '1rem',
              }}
            >
              <BrandLogo size={28} />
              <span
                style={{
                  fontSize: '0.82rem',
                  fontWeight: 800,
                  letterSpacing: '0.16em',
                  color: '#0f172a',
                }}
              >
                {BRAND_NAME}
              </span>
            </Link>

            <p
              style={{
                color: '#64748b',
                fontSize: '0.88rem',
                lineHeight: 1.5,
                marginBottom: '1.25rem',
                maxWidth: 240,
              }}
            >
              Get Flawless PR Reviews by Default in Seconds
            </p>

            {/* Live Operational Status Badge */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 12px',
                borderRadius: 9999,
                background: '#f8fafc',
                border: '1px solid rgba(0, 0, 0, 0.06)',
                fontSize: '0.74rem',
                fontWeight: 600,
                color: '#334155',
                marginBottom: '1.5rem',
              }}
            >
              <div
                style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981' }}
                className="pulse-indicator"
              />
              <span>Review Fleet Operational</span>
            </div>

            {/* Social Icons with interactive hover physics */}
            <div style={{ display: 'flex', gap: '0.65rem', alignItems: 'center' }}>
              {/* GitHub */}
              <motion.a
                whileHover={{ y: -3, scale: 1.08 }}
                whileTap={{ scale: 0.95 }}
                href="https://github.com/muhammadshehzaib/ai-pr-reviewer"
                target="_blank"
                rel="noreferrer"
                className="footer-social-icon"
                title="GitHub Repository"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
              </motion.a>

              {/* Twitter / X */}
              <motion.a
                whileHover={{ y: -3, scale: 1.08 }}
                whileTap={{ scale: 0.95 }}
                href="https://twitter.com"
                target="_blank"
                rel="noreferrer"
                className="footer-social-icon"
                title="Follow on Twitter / X"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </motion.a>

              {/* LinkedIn */}
              <motion.a
                whileHover={{ y: -3, scale: 1.08 }}
                whileTap={{ scale: 0.95 }}
                href="https://linkedin.com"
                target="_blank"
                rel="noreferrer"
                className="footer-social-icon"
                title="Connect on LinkedIn"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
                  <rect width="4" height="12" x="2" y="9" />
                  <circle cx="4" cy="4" r="2" />
                </svg>
              </motion.a>

              {/* YouTube */}
              <motion.a
                whileHover={{ y: -3, scale: 1.08 }}
                whileTap={{ scale: 0.95 }}
                href="https://youtube.com"
                target="_blank"
                rel="noreferrer"
                className="footer-social-icon"
                title="YouTube Demos"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
                  <polygon points="10 15 15 12 10 9 10 15" fill="currentColor" />
                </svg>
              </motion.a>
            </div>
          </div>

          {/* Column 1: Product */}
          <div>
            <h4 className="footer-col-title">Product</h4>
            <ul className="footer-links-list">
              <li><a href="#demo">AI PR Reviewer</a></li>
              <li><a href="#why-pullpilot">Codebase Context Review</a></li>
              <li><a href="#why-pullpilot">Performance Auditor</a></li>
              <li><a href="#demo">Inline Diff Patches</a></li>
              <li><Link href="/pricing">Pricing Plans</Link></li>
            </ul>
          </div>

          {/* Column 2: Platforms */}
          <div>
            <h4 className="footer-col-title">Platforms</h4>
            <ul className="footer-links-list">
              <li><a href="#why-pullpilot">GitHub App</a></li>
              <li><a href="#why-pullpilot">GitHub Actions</a></li>
              <li><a href="#why-pullpilot">GitLab CI/CD</a></li>
              <li><a href="#why-pullpilot">Bitbucket</a></li>
              <li><a href="#why-pullpilot">Self-Hosted Docker</a></li>
            </ul>
          </div>

          {/* Column 3: Review Modes */}
          <div>
            <h4 className="footer-col-title">Review Modes</h4>
            <ul className="footer-links-list">
              <li><a href="#why-pullpilot">ChatGPT 5.6</a></li>
              <li><a href="#why-pullpilot">Claude 5 Sonnet</a></li>
              <li><a href="#why-pullpilot">Gemini 3.0 Pro</a></li>
              <li><a href="#why-pullpilot">Grok 4 Reasoning</a></li>
              <li><a href="#why-pullpilot">Claude 5 Opus</a></li>
            </ul>
          </div>

          {/* Column 4: Free Tools */}
          <div>
            <h4 className="footer-col-title">Free Tools</h4>
            <ul className="footer-links-list">
              <li><a href="#why-pullpilot">.aipr.yml Generator</a></li>
              <li><a href="#demo">Diff Context Viewer</a></li>
              <li><a href="#demo">Security Rule Tester</a></li>
              <li><a href="#pricing">Token Cost Estimator</a></li>
              <li><a href="#demo">All Free Tools</a></li>
            </ul>
          </div>

          {/* Column 5: Compare */}
          <div>
            <h4 className="footer-col-title">Compare</h4>
            <ul className="footer-links-list">
              <li><a href="#why-pullpilot">vs CodeRabbit</a></li>
              <li><a href="#why-pullpilot">vs Copilot PR</a></li>
              <li><a href="#why-pullpilot">vs Sourcery</a></li>
              <li><a href="#why-pullpilot">vs Qodo</a></li>
              <li><a href="#why-pullpilot">vs Greptile</a></li>
            </ul>
          </div>

          {/* Column 6: Resources */}
          <div>
            <h4 className="footer-col-title">Resources</h4>
            <ul className="footer-links-list">
              <li><Link href="/support">Documentation</Link></li>
              <li><Link href="/privacy">Zero-Training Guarantee</Link></li>
              <li><Link href="/support">Webhook REST API</Link></li>
              <li><a href="https://github.com/muhammadshehzaib/ai-pr-reviewer" target="_blank" rel="noreferrer">Self-Hosting Guide</a></li>
              <li><Link href="/support">Changelog</Link></li>
            </ul>
          </div>

          {/* Column 7: Company */}
          <div>
            <h4 className="footer-col-title">Company</h4>
            <ul className="footer-links-list">
              <li><Link href="/support">About</Link></li>
              <li><Link href="/pricing">Pricing</Link></li>
              <li><Link href="/support">Docs</Link></li>
              <li><Link href="/privacy">Privacy</Link></li>
              <li><Link href="/terms">Terms</Link></li>
              <li><Link href="/support">Contact</Link></li>
            </ul>
          </div>
        </div>

        {/* Divider Line & Sub-Footer */}
        <div
          style={{
            borderTop: '1px solid rgba(0, 0, 0, 0.08)',
            paddingTop: '1.75rem',
            paddingBottom: '1.75rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1.25rem',
            fontSize: '0.84rem',
            color: '#94a3b8',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span>© {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.</span>
            <span style={{ color: '#cbd5e1' }}>•</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#10b981', fontWeight: 600 }}>
              <CheckCircle2 size={13} /> {CODE_HANDLING_BADGE}
            </span>
            <span style={{ color: '#cbd5e1' }}>•</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#2563eb', fontWeight: 600 }}>
              <ShieldCheck size={13} /> AES-256 GCM Encrypted
            </span>
          </div>

          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <Link href="/privacy" style={{ color: '#64748b' }} className="footer-bottom-link">Privacy Policy</Link>
            <Link href="/terms" style={{ color: '#64748b' }} className="footer-bottom-link">Terms of Service</Link>
            <Link href="/support" style={{ color: '#64748b' }} className="footer-bottom-link">Support & FAQ</Link>
            <a
              href="https://github.com/muhammadshehzaib/ai-pr-reviewer"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
              className="footer-bottom-link"
            >
              GitHub <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>

      {/* Signature videocaptions.ai Giant Watermark Typography with Interactive Radiant Hover */}
      <motion.div
        onMouseEnter={() => setIsWatermarkHovered(true)}
        onMouseLeave={() => setIsWatermarkHovered(false)}
        animate={{
          color: isWatermarkHovered ? '#2563eb' : '#94a3b8',
          scale: isWatermarkHovered ? 1.015 : 1,
        }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        style={{
          fontSize: 'clamp(3.5rem, 13vw, 15rem)',
          fontWeight: 900,
          letterSpacing: '-0.04em',
          textAlign: 'center',
          userSelect: 'none',
          lineHeight: 0.75,
          marginTop: '2.5rem',
          marginBottom: '-1rem',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-inter), sans-serif',
          cursor: 'pointer',
          transition: 'color 0.35s ease',
        }}
      >
        {BRAND_NAME}
      </motion.div>
    </footer>
  );
}
