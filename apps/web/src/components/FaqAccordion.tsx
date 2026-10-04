'use client';

import { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: 'How does PullPilot review pull requests?',
    a: 'When you open or update a PR, GitHub sends a secure webhook to PullPilot. Our backend analyzes the AST and changed diff lines, evaluates your .aipr.yml rules, and posts actionable inline comments with one-click patches directly on the modified lines in GitHub.',
  },
  {
    q: 'Is my proprietary code stored or used to train AI models?',
    a: 'No, absolutely not. Code diffs are held in volatile RAM only for the duration of the review execution and are purged immediately. We never train, fine-tune, or retain any customer code.',
  },
  {
    q: 'How do I ignore certain files like generated lockfiles or dist directories?',
    a: 'Add a `.aipr.yml` file to the root of your repository with an ignore list:\n\n```yaml\nignore:\n  - "dist/**"\n  - "package-lock.json"\n  - "*.min.js"\n```',
  },
  {
    q: 'Do I need my own AI API key?',
    a: 'Yes. Bring your own Gemini, OpenAI, Anthropic Claude, or Grok key from the API Key Vault in your dashboard. Keys are encrypted at rest using AES-256-GCM.',
  },
  {
    q: 'So what exactly am I paying $2/month for?',
    a: 'Only the review engine. Your AI provider bills you directly at their own rate, and we add zero markup. The $2/month (or $10/year) platform fee covers the review pipeline, queue, GitHub App, inline suggestions, .aipr.yml rules, and review history.',
  },
  {
    q: 'What is included in the Free tier?',
    a: 'The Free tier gives you unlimited reviews on all public open-source repositories and up to 50 reviews per month on private repositories, with zero watermarks or credit cards required.',
  },
  {
    q: 'What is the difference between monthly and annual billing?',
    a: 'Monthly is $2/month ($24/year). Annual is $10/year — that is just $0.83/month, saving you $14 every year.',
  },
  {
    q: 'How does billing work?',
    a: 'Paid plans are billed securely through Polar, our merchant of record, which handles payment processing, taxes, and invoicing. You can upgrade, downgrade, or cancel anytime from the billing page. Your AI token usage is billed separately by your AI provider, never through us.',
  },
];

export function FaqAccordion() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  const toggle = (idx: number) => {
    setOpenIdx(openIdx === idx ? null : idx);
  };

  return (
    <section id="faq" style={{ maxWidth: 840, margin: '0 auto', padding: '4rem 1.5rem 6rem' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem' }}>
          <HelpCircle size={14} color="#2563eb" />
          <span>Got Questions?</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          Frequently Asked Questions
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 540, margin: '0 auto' }}>
          Everything you need to know about PullPilot AI PR Reviewer and GitHub App integration.
        </p>
      </div>

      {/* Accordion List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {FAQS.map((faq, idx) => {
          const isOpen = openIdx === idx;
          return (
            <div key={idx} className="faq-item">
              <button
                onClick={() => toggle(idx)}
                className="faq-question-btn"
                aria-expanded={isOpen}
              >
                <span>{faq.q}</span>
                <ChevronDown
                  size={18}
                  style={{
                    color: '#64748b',
                    transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease',
                    flexShrink: 0,
                    marginLeft: '1rem',
                  }}
                />
              </button>

              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                  >
                    <div className="faq-answer">
                      <div style={{ whiteSpace: 'pre-line' }}>{faq.a}</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}
