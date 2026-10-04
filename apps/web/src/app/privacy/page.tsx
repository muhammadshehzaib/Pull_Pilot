import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { BrandLogo } from '../../components/BrandLogo';
import { BRAND_NAME, SITE_HOST } from '../../config/brand';

export const metadata = {
  // Bare page name: the root layout's title template appends the brand.
  title: 'Privacy Policy',
  description: `How ${BRAND_NAME} protects your code, handles webhooks, and ensures zero AI model training.`,
};

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#ffffff' }}>
      {/* Floating Header */}
      <header className="nav-pill-wrapper">
        <nav className="nav-pill-container" style={{ position: 'relative' }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', textDecoration: 'none' }}>
            <BrandLogo size={28} />
            <span style={{ fontSize: '0.84rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#0f172a' }}>
              {SITE_HOST}
            </span>
          </Link>
          <Link href="/" className="btn-secondary-pill" style={{ fontSize: '0.84rem', padding: '0.45rem 1rem' }}>
            <ArrowLeft size={14} /> Back to Home
          </Link>
        </nav>
      </header>

      <main className="legal-container">
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: '#10b981', marginBottom: '1rem' }}>
          <ShieldCheck size={18} />
          <span className="section-label" style={{ color: '#10b981' }}>Data Privacy & Trust</span>
        </div>

        <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem', color: '#0f172a' }}>Privacy Policy</h1>
        <p style={{ color: '#64748b', fontSize: '0.92rem', marginBottom: '2.5rem' }}>
          Last updated: September 1, 2026 • Effective immediately
        </p>

        <div className="legal-prose">
          <h2>1. Zero AI Model Training Guarantee</h2>
          <p>
            We adhere to a strict <strong>zero-training policy</strong>. Your proprietary code, pull request diffs, commits, and repository metadata are <strong>never</strong> used to train, fine-tune, or improve public or private AI foundation models.
          </p>

          <h2>2. Code Handling & In-Memory Execution</h2>
          <p>
            When a GitHub webhook triggers a review job:
          </p>
          <ul>
            <li>Code diffs are fetched securely over TLS directly from the GitHub API using temporary installation access tokens.</li>
            <li>Diff content is held strictly in volatile worker memory (RAM) during parsing and analysis.</li>
            <li>Once analysis completes and findings are posted to GitHub, diff buffers are immediately released and purged from memory.</li>
            <li>We do not write your source code files to persistent disk storage or databases.</li>
          </ul>

          <h2>3. Encrypted API Key Vault</h2>
          <p>
            If you choose to provide custom API keys (e.g. for OpenAI, Anthropic Claude, or Google Gemini), your keys are encrypted at rest using <strong>AES-256-GCM</strong> with unique per-record initialization vectors and scrypt key derivation. Plaintext keys only exist in worker memory for the milliseconds required to complete the API request.
          </p>

          <h2>4. Data Collected & Stored</h2>
          <p>We collect and store only the minimal operational metadata required to provide the service:</p>
          <ul>
            <li><strong>Account Info:</strong> Your GitHub user ID, username, and avatar URL provided via GitHub OAuth.</li>
            <li><strong>Installation Data:</strong> Connected repository IDs and names authorized by your GitHub App installation.</li>
            <li><strong>Audit Logs:</strong> Timestamps, status (e.g. completed/failed), and high-level finding summaries (file path, line number, issue description) displayed on your dashboard.</li>
          </ul>

          <h2>5. Third-Party Service Providers</h2>
          <p>
            Depending on your configured provider, code diff snippets are sent via secure TLS to the designated AI provider (Anthropic, OpenAI, or Google AI) under enterprise API data protection terms that prohibit training on API data.
          </p>

          <h2>6. Contact Us</h2>
          <p>
            If you have questions about this privacy policy or our data security practices, please contact us at <a href="mailto:privacy@shehzaib.com" style={{ color: '#2563eb', textDecoration: 'underline' }}>privacy@shehzaib.com</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
