'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Cpu, ChevronRight, Menu, X, GitBranch, ArrowUpRight } from 'lucide-react';
import { BACKEND_URL, GITHUB_APP_INSTALL_URL } from '../utils/constants';
import { BRAND_NAME, SITE_HOST } from '../config/brand';

import { BrandLogo } from './BrandLogo';

interface NavbarProps {
  user?: { username: string; avatarUrl?: string | null } | null;
}

export function Navbar({ user }: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <header className="nav-pill-wrapper">
        <nav className={`nav-pill-container ${scrolled ? 'nav-pill-scrolled' : ''}`}>
          {/* Brand */}
          <Link
            href="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              textDecoration: 'none',
            }}
          >
            <BrandLogo size={28} />
            <span
              style={{
                fontSize: '0.84rem',
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: '#0f172a',
              }}
            >
              {SITE_HOST}
            </span>
          </Link>

          {/* Desktop Links */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
            className="hidden-mobile"
          >
            <a href="#demo" className="nav-link-item">
              Live Demo
            </a>
            <a href="#why-pullpilot" className="nav-link-item">
              Why {BRAND_NAME}
            </a>
            <a href="#compare" className="nav-link-item">
              Compare
            </a>
            <a href="#use-cases" className="nav-link-item">
              Use Cases
            </a>
            <Link href="/pricing" className="nav-link-item">
              Pricing
            </Link>
            <a href="#faq" className="nav-link-item">
              FAQ
            </a>
            <a
              href="https://github.com/muhammadshehzaib/ai-pr-reviewer"
              target="_blank"
              rel="noreferrer"
              className="nav-link-item"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
            >
              GitHub <ArrowUpRight size={13} style={{ opacity: 0.6 }} />
            </a>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {user ? (
              <Link
                href="/dashboard"
                className="btn-primary-pill"
                style={{ fontSize: '0.85rem', padding: '0.5rem 1.1rem' }}
              >
                Dashboard <ChevronRight size={15} />
              </Link>
            ) : (
              <>
                <a
                  href={`${BACKEND_URL}/api/auth/github`}
                  className="nav-link-item hidden-mobile"
                  style={{ fontWeight: 600, fontSize: '0.86rem' }}
                >
                  Sign In
                </a>
                <a
                  href={GITHUB_APP_INSTALL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary-pill btn-shimmer"
                  style={{
                    fontSize: '0.85rem',
                    padding: '0.5rem 1.15rem',
                    gap: '0.4rem',
                  }}
                >
                  <GitBranch size={15} />
                  <span>Install App</span>
                  <ChevronRight size={15} />
                </a>
              </>
            )}

            {/* Mobile Toggle */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="mobile-only-btn"
              aria-label="Toggle Navigation Menu"
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                display: 'none',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.04)',
                color: '#0f172a',
              }}
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </nav>
      </header>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99,
            background: 'rgba(15, 23, 42, 0.4)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            padding: '5rem 1.5rem 2rem',
          }}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: 20,
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              boxShadow: '0 20px 40px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <a
              href="#demo"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              Live Demo
            </a>
            <a
              href="#why-pullpilot"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              Why {BRAND_NAME}
            </a>
            <a
              href="#compare"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              Compare
            </a>
            <a
              href="#use-cases"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              Use Cases
            </a>
            <Link
              href="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              Pricing
            </Link>
            <a
              href="#faq"
              onClick={() => setMobileMenuOpen(false)}
              className="nav-link-item"
              style={{ fontSize: '1.05rem', padding: '0.6rem 0.5rem' }}
            >
              FAQ
            </a>
            <div style={{ height: 1, background: 'rgba(0,0,0,0.06)', margin: '0.5rem 0' }} />
            <a
              href={GITHUB_APP_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary-pill"
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <GitBranch size={16} /> Install GitHub App
            </a>
          </div>
        </div>
      )}

      <style jsx global>{`
        @media (max-width: 768px) {
          .hidden-mobile {
            display: none !important;
          }
          .mobile-only-btn {
            display: flex !important;
          }
        }
      `}</style>
    </>
  );
}
