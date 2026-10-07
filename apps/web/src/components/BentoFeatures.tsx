'use client';

import { CODE_HANDLING_BADGE, NO_TRAINING_CLAIM, codeHandlingSummary } from '../config/privacy';
import { useState, useEffect } from 'react';
import {
  Key,
  ShieldCheck,
  Sliders,
  Activity,
  Lock,
  Zap,
  CheckCircle2,
  Sparkles,
  Copy,
  Check,
  Play,
  Star,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ModelInfo {
  name: string;
  provider: string;
  latency: string;
  tag: string;
}

const MODELS: ModelInfo[] = [
  { name: 'ChatGPT 5.6', provider: 'OpenAI', latency: '360ms', tag: 'Next-Gen' },
  { name: 'Claude 5 Sonnet', provider: 'Anthropic', latency: '340ms', tag: 'Recommended' },
  { name: 'Gemini 3.0 Pro', provider: 'Google AI', latency: '290ms', tag: 'High Speed' },
  { name: 'Grok 4 Reasoning', provider: 'xAI', latency: '380ms', tag: 'Reasoning' },
  { name: 'DeepSeek R2', provider: 'DeepSeek', latency: '420ms', tag: 'Open Weights' },
  { name: 'Claude 5 Opus', provider: 'Anthropic', latency: '410ms', tag: 'Deep Audit' },
];

export function BentoFeatures() {
  // State for Card 1: Selected model
  const [selectedModel, setSelectedModel] = useState<string>('ChatGPT 5.6');

  // State for Card 2: Cipher scrambling
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [cipherText, setCipherText] = useState('aes256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // State for Card 3: YAML copy
  const [copied, setCopied] = useState(false);

  // State for Card 4: Telemetry simulator
  const [queueItems, setQueueItems] = useState([
    { id: 'job-984', repo: 'acme/auth', status: 'COMPLETED', time: 'Just now' },
    { id: 'job-985', repo: 'stripe/checkout', status: 'RUNNING', time: '1s ago' },
  ]);

  // State for Card 6: Star counter
  const [stars, setStars] = useState(1482);
  const [hasStarred, setHasStarred] = useState(false);

  const handleCopyYaml = () => {
    const yaml = `# .aipr.yml repository config\nmin_severity: medium\nignore:\n  - "dist/**"\n  - "package-lock.json"\nguidelines:\n  - "No console.log in production paths"`;
    navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTriggerMockWebhook = () => {
    const newId = `job-${Math.floor(100 + Math.random() * 900)}`;
    const newJob = { id: newId, repo: 'user/next-app', status: 'RUNNING', time: 'Just now' };
    setQueueItems((prev) => [newJob, ...prev.slice(0, 2)]);
    setTimeout(() => {
      setQueueItems((prev) =>
        prev.map((item) => (item.id === newId ? { ...item, status: 'COMPLETED' } : item))
      );
    }, 1500);
  };

  const handleStar = () => {
    if (!hasStarred) {
      setStars((prev) => prev + 1);
      setHasStarred(true);
    } else {
      setStars((prev) => prev - 1);
      setHasStarred(false);
    }
  };

  return (
    <section id="why-pullpilot" style={{ maxWidth: 1200, margin: '0 auto', padding: '4rem 1.5rem 6rem' }}>
      {/* Section Header */}
      <div style={{ textAlign: 'center', marginBottom: '3.5rem' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem' }}>
          <Sparkles size={14} color="#2563eb" />
          <span>Aceternity-Grade Precision</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          Why Developers Choose PullPilot
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 600, margin: '0 auto' }}>
          Stop letting critical bugs slip into main. PullPilot turns noisy PR reviews into automated, precision feedback.
        </p>
      </div>

      {/* 3x2 Bento Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '1.75rem',
        }}
      >
        {/* =========================================================================
            Card 1: Multi-Model (Interactive Selector with live telemetry)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div className="bento-header-misted bg-dot-pattern" style={{ height: 230, position: 'relative' }}>
            {/* Grid of interactive model pills */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
                padding: '1rem',
                width: '100%',
                maxWidth: 360,
                zIndex: 2,
              }}
            >
              {MODELS.map((m) => {
                const isSelected = selectedModel === m.name;
                return (
                  <button
                    key={m.name}
                    onClick={() => setSelectedModel(m.name)}
                    style={{
                      padding: '8px 6px',
                      borderRadius: 10,
                      border: isSelected ? '1.5px solid #2563eb' : '1px dashed rgba(37, 99, 235, 0.35)',
                      background: isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
                      backdropFilter: 'blur(6px)',
                      boxShadow: isSelected ? '0 8px 16px -4px rgba(37, 99, 235, 0.25)' : 'none',
                      textAlign: 'center',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      transform: isSelected ? 'scale(1.04)' : 'scale(1)',
                    }}
                  >
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: isSelected ? '#1d4ed8' : '#1e3a8a' }}>
                      {m.name.split(' ')[0]} {m.name.split(' ')[1]}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: isSelected ? '#2563eb' : '#64748b' }}>
                      {m.provider}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Live active selection readout pill */}
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                padding: '4px 14px',
                borderRadius: 9999,
                background: '#0f172a',
                color: '#ffffff',
                fontSize: '0.72rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: 3,
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} className="pulse-indicator" />
              <span>Active: {selectedModel}</span>
            </div>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Multi-Model AI Engine
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              Click any model above to switch. Choose Claude 5 Sonnet for deep security analysis, ChatGPT 5.6 for complex refactoring, or Gemini 3.0 Pro for lightning execution.
            </p>
          </div>
        </div>

        {/* =========================================================================
            Card 2: AES-256 Key Vault (Interactive Cipher Scrambler)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div
            className="bento-header-misted bg-dot-pattern"
            style={{
              height: 230,
              background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
              flexDirection: 'column',
              gap: '12px',
              padding: '1.5rem',
            }}
          >
            {/* Animated Shield Icon */}
            <motion.div
              whileHover={{ rotate: 10, scale: 1.1 }}
              style={{
                width: 58,
                height: 58,
                borderRadius: 18,
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 10px 20px -5px rgba(16, 185, 129, 0.4)',
                cursor: 'pointer',
              }}
              onClick={() => setIsEncrypted(!isEncrypted)}
            >
              <ShieldCheck size={30} />
            </motion.div>

            {/* Cipher Stream Box */}
            <div
              className="mono"
              style={{
                background: 'rgba(255, 255, 255, 0.9)',
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: '0.72rem',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                color: '#065f46',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                maxWidth: '90%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <Lock size={12} color="#10b981" />
              <span>{isEncrypted ? 'aes256-gcm:••••••••••••••••' : 'RAM-only: decrypted 1.2ms'}</span>
            </div>

            <span style={{ fontSize: '0.68rem', color: '#059669', fontWeight: 600 }}>
              Hardware-grade scrypt key derivation
            </span>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Encrypted API Key Vault
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              User provider keys are encrypted at rest with hardware-grade AES-256-GCM. Plaintext keys only exist in ephemeral RAM during diff execution.
            </p>
          </div>
        </div>

        {/* =========================================================================
            Card 3: .aipr.yml Rules (Interactive YAML with 1-Click Copy)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div className="bento-header-dark" style={{ height: 230, position: 'relative' }}>
            {/* Top Editor Bar */}
            <div
              style={{
                background: 'rgba(255,255,255,0.06)',
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Terminal size={13} color="#38bdf8" />
                <span className="mono" style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>
                  .aipr.yml
                </span>
              </div>
              <button
                onClick={handleCopyYaml}
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  padding: '3px 8px',
                  borderRadius: 4,
                  fontSize: '0.68rem',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {copied ? (
                  <>
                    <Check size={11} color="#34d399" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy size={11} /> Copy
                  </>
                )}
              </button>
            </div>

            {/* YAML Code with line highlights */}
            <div
              className="mono"
              style={{
                padding: '0.75rem 1rem',
                fontSize: '0.74rem',
                color: '#94a3b8',
                lineHeight: 1.6,
              }}
            >
              <div><span style={{ color: '#f43f5e' }}>min_severity</span>: <span style={{ color: '#34d399' }}>medium</span></div>
              <div><span style={{ color: '#f43f5e' }}>ignore</span>:</div>
              <div style={{ paddingLeft: '1rem', color: '#cbd5e1' }}>- <span style={{ color: '#fbbf24' }}>&quot;dist/**&quot;</span></div>
              <div style={{ paddingLeft: '1rem', color: '#cbd5e1' }}>- <span style={{ color: '#fbbf24' }}>&quot;package-lock.json&quot;</span></div>
              <div><span style={{ color: '#f43f5e' }}>guidelines</span>:</div>
              <div style={{ paddingLeft: '1rem', color: '#cbd5e1' }}>- <span style={{ color: '#a78bfa' }}>&quot;No console.log&quot;</span></div>
            </div>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Declarative Repository Rules
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              Drop a simple YAML file into your repository to enforce team-specific coding standards, ignore generated lockfiles, or silence minor syntax nits.
            </p>
          </div>
        </div>

        {/* =========================================================================
            Card 4: Live Telemetry Stream (Interactive Mock Event Trigger)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div
            className="bento-header-misted bg-dot-pattern"
            style={{
              height: 230,
              background: 'linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%)',
              flexDirection: 'column',
              padding: '1rem 1.25rem',
              justifyContent: 'space-between',
            }}
          >
            {/* Header + Trigger Button */}
            <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="section-label" style={{ color: '#7e22ce', fontSize: '0.68rem' }}>
                BullMQ Pipeline
              </span>
              <button
                onClick={handleTriggerMockWebhook}
                style={{
                  background: '#7e22ce',
                  color: '#ffffff',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: 9999,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  boxShadow: '0 2px 6px rgba(126, 34, 206, 0.3)',
                }}
              >
                <Play size={10} fill="#fff" /> Simulate PR
              </button>
            </div>

            {/* Queue rows */}
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <AnimatePresence>
                {queueItems.map((q) => (
                  <motion.div
                    key={q.id}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={{
                      background: '#ffffff',
                      padding: '6px 10px',
                      borderRadius: 8,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.03)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      border: '1px solid rgba(126, 34, 206, 0.15)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: q.status === 'COMPLETED' ? '#10b981' : '#a855f7',
                        }}
                      />
                      <span className="mono" style={{ fontSize: '0.74rem', color: '#1e293b' }}>
                        {q.repo} ({q.id})
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        color: q.status === 'COMPLETED' ? '#10b981' : '#7e22ce',
                      }}
                    >
                      {q.status}
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <span style={{ fontSize: '0.68rem', color: '#6b21a8' }}>
              Real-time socket.io duplex stream
            </span>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Real-Time WebSocket Streaming
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              Watch background review workers execute live on your dashboard with sub-second BullMQ event telemetry and live progress indicators.
            </p>
          </div>
        </div>

        {/* =========================================================================
            Card 5: Zero AI Model Training (Interactive Compliance Seal)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div
            className="bento-header-misted bg-dot-pattern"
            style={{
              height: 230,
              background: 'linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%)',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <motion.div
              whileHover={{ scale: 1.1, rotate: -5 }}
              style={{
                width: 62,
                height: 62,
                borderRadius: 20,
                background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 10px 22px -5px rgba(249, 115, 22, 0.4)',
              }}
            >
              <Lock size={30} />
            </motion.div>

            <div
              style={{
                padding: '5px 14px',
                borderRadius: 9999,
                background: '#ffffff',
                border: '1px solid rgba(249, 115, 22, 0.25)',
                fontSize: '0.76rem',
                fontWeight: 700,
                color: '#c2410c',
                boxShadow: '0 2px 8px rgba(249, 115, 22, 0.1)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <CheckCircle2 size={13} color="#ea580c" /> {CODE_HANDLING_BADGE}
            </div>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Strict Privacy & Security
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              {NO_TRAINING_CLAIM} {codeHandlingSummary()}
            </p>
          </div>
        </div>

        {/* =========================================================================
            Card 6: 100% AGPL-3.0 Open Core (Interactive GitHub Star Button)
            ========================================================================= */}
        <div className="aceternity-glow-card">
          <div
            className="bento-header-misted bg-dot-pattern"
            style={{
              height: 230,
              background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '14px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 18px',
                borderRadius: 14,
                background: '#ffffff',
                boxShadow: '0 8px 20px -4px rgba(2, 132, 199, 0.15)',
                border: '1px solid rgba(2, 132, 199, 0.2)',
              }}
            >
              <Zap size={22} color="#0284c7" />
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#0f172a' }}>GNU AGPL-3.0</div>
                <div style={{ fontSize: '0.72rem', color: '#64748b' }}>100% Auditable Source</div>
              </div>
            </div>

            {/* Interactive Star Button */}
            <button
              onClick={handleStar}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 14px',
                borderRadius: 9999,
                background: hasStarred ? '#0284c7' : '#ffffff',
                color: hasStarred ? '#ffffff' : '#0f172a',
                border: '1px solid rgba(2, 132, 199, 0.3)',
                fontSize: '0.78rem',
                fontWeight: 600,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Star size={13} fill={hasStarred ? '#ffffff' : '#ffc531'} color={hasStarred ? '#ffffff' : '#ffc531'} />
              <span>{hasStarred ? 'Starred!' : 'Star on GitHub'}</span>
              <span
                style={{
                  background: hasStarred ? 'rgba(255,255,255,0.25)' : '#f1f5f9',
                  padding: '1px 6px',
                  borderRadius: 9999,
                  fontSize: '0.7rem',
                }}
              >
                {stars.toLocaleString()}
              </span>
            </button>
          </div>

          <div className="bento-content">
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#0f172a' }}>
              Transparent Open Core
            </h3>
            <p style={{ color: '#64748b', fontSize: '0.92rem', lineHeight: 1.6 }}>
              Inspect every line of review prompt logic, backend workers, and cryptographic routines. Host your own instance or use our managed cloud fleet.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
