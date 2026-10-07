'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BRAND_NAME } from '../config/brand';
import {
  ShieldCheck,
  Zap,
  Cpu,
  CheckCircle2,
  Sparkles,
  RefreshCw,
  Sliders,
  Terminal,
  ArrowRight,
  GitPullRequest,
  Check,
  Scan,
} from 'lucide-react';

interface Preset {
  id: string;
  name: string;
  category: 'SECURITY' | 'PERFORMANCE' | 'TYPE_SAFETY' | 'ARCHITECTURE';
  file: string;
  prTitle: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  codeLinesBefore: { num: number; text: string; type: 'normal' | 'add' | 'del' }[];
  codeLinesAfter: { num: number; text: string; type: 'normal' | 'add' | 'del' }[];
  botFindingTitle: string;
  botExplanation: string;
  suggestedPatch: string;
}

const PRESETS: Preset[] = [
  {
    id: 'security',
    name: 'Security Audit',
    category: 'SECURITY',
    file: 'src/services/auth.service.ts',
    prTitle: 'PR #104 • Add HMAC signature verification',
    severity: 'CRITICAL',
    codeLinesBefore: [
      { num: 23, text: 'export function verifyHmacToken(secret: string, token: string) {', type: 'normal' },
      { num: 24, text: '  const expected = crypto.createHmac("sha256", secret).update("payload").digest("hex");', type: 'normal' },
      { num: 25, text: '- return expected === token; // ❌ Vulnerable to timing attack', type: 'del' },
      { num: 26, text: '}', type: 'normal' },
    ],
    codeLinesAfter: [
      { num: 23, text: 'export function verifyHmacToken(secret: string, token: string) {', type: 'normal' },
      { num: 24, text: '  const expected = crypto.createHmac("sha256", secret).update("payload").digest("hex");', type: 'normal' },
      { num: 25, text: '+ const expBuf = Buffer.from(expected);', type: 'add' },
      { num: 26, text: '+ const tokBuf = Buffer.from(token);', type: 'add' },
      { num: 27, text: '+ return expBuf.length === tokBuf.length && crypto.timingSafeEqual(expBuf, tokBuf);', type: 'add' },
      { num: 28, text: '}', type: 'normal' },
    ],
    botFindingTitle: 'Timing Attack on HMAC Token Comparison',
    botExplanation:
      'Standard JavaScript string equality (===) performs byte-by-byte comparison and returns immediately on first mismatch. Attackers can measure response latency down to sub-microseconds to reconstruct auth secrets.',
    suggestedPatch: 'return expBuf.length === tokBuf.length && crypto.timingSafeEqual(expBuf, tokBuf);',
  },
  {
    id: 'performance',
    name: 'Performance Audit',
    category: 'PERFORMANCE',
    file: 'src/api/routes/repositories.ts',
    prTitle: 'PR #215 • Batch retrieve team repositories',
    severity: 'HIGH',
    codeLinesBefore: [
      { num: 88, text: 'async function getTeamOverview(orgId: string) {', type: 'normal' },
      { num: 89, text: '  const repos = await db.repo.findMany({ where: { orgId } });', type: 'normal' },
      { num: 90, text: '- return repos.map(async (r) => await db.commits.findMany({ repoId: r.id })); // ❌ N+1 query', type: 'del' },
      { num: 91, text: '}', type: 'normal' },
    ],
    codeLinesAfter: [
      { num: 88, text: 'async function getTeamOverview(orgId: string) {', type: 'normal' },
      { num: 89, text: '  const repos = await db.repo.findMany({ where: { orgId } });', type: 'normal' },
      { num: 90, text: '+ const repoIds = repos.map((r) => r.id);', type: 'add' },
      { num: 91, text: '+ return db.commits.findMany({ where: { repoId: { in: repoIds } } }); // 🚀 1 roundtrip', type: 'add' },
      { num: 92, text: '}', type: 'normal' },
    ],
    botFindingTitle: 'N+1 Database Query Cascade in Repository Resolver',
    botExplanation:
      'Executing individual database calls inside Array.map generates 50-200 sequential network round trips, blowing out p99 API response times under load. Batch fetch using SQL WHERE IN.',
    suggestedPatch: 'return db.commits.findMany({ where: { repoId: { in: repoIds } } });',
  },
  {
    id: 'architecture',
    name: 'Memory Leak',
    category: 'ARCHITECTURE',
    file: 'src/workers/telemetry.stream.ts',
    prTitle: 'PR #388 • Live Server-Sent Events subscriber',
    severity: 'CRITICAL',
    codeLinesBefore: [
      { num: 42, text: 'function setupSubscriber(stream: SSEStream, emitter: EventEmitter) {', type: 'normal' },
      { num: 43, text: '- emitter.on("metric", (m) => stream.write(m)); // ❌ Retains dead client sockets', type: 'del' },
      { num: 44, text: '  return { status: "active" };', type: 'normal' },
      { num: 45, text: '}', type: 'normal' },
    ],
    codeLinesAfter: [
      { num: 42, text: 'function setupSubscriber(stream: SSEStream, emitter: EventEmitter) {', type: 'normal' },
      { num: 43, text: '+ const listener = (m: Metric) => stream.write(m);', type: 'add' },
      { num: 44, text: '+ emitter.on("metric", listener);', type: 'add' },
      { num: 45, text: '+ stream.on("close", () => emitter.removeListener("metric", listener));', type: 'add' },
      { num: 46, text: '  return { status: "active" };', type: 'normal' },
      { num: 47, text: '}', type: 'normal' },
    ],
    botFindingTitle: 'Unbounded SSE Event Listener Memory Leak',
    botExplanation:
      'Client socket disconnections never unsubscribe the anonymous listener from the singleton emitter. Node.js heap memory steadily grows until V8 OOM abort.',
    suggestedPatch: 'stream.on("close", () => emitter.removeListener("metric", listener));',
  },
];

export function InteractiveDiffPlayground() {
  const [activeTab, setActiveTab] = useState<string>('security');
  const [isFixed, setIsFixed] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);

  const currentPreset = PRESETS.find((p) => p.id === activeTab) || PRESETS[0];

  const handleTabChange = (id: string) => {
    setIsAnalyzing(true);
    setActiveTab(id);
    setIsFixed(false);
    setTimeout(() => setIsAnalyzing(false), 500);
  };

  const toggleFix = () => {
    setIsFixed(!isFixed);
  };

  return (
    <section id="demo" style={{ maxWidth: 1040, margin: '0 auto', padding: '4rem 1.5rem 6rem' }}>
      {/* Section Header */}
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <div className="badge-social-dark" style={{ marginBottom: '1rem' }}>
          <Sparkles size={14} color="#2563eb" />
          <span>Aceternity-Style Live Inspector</span>
        </div>
        <h2 style={{ fontSize: 'clamp(2rem, 3.5vw, 2.75rem)', marginBottom: '0.75rem' }}>
          Experience Inline AI Reviews in Real-Time
        </h2>
        <p style={{ color: '#64748b', fontSize: '1.05rem', maxWidth: 640, margin: '0 auto' }}>
          Watch how PullPilot scans pull request diffs, detects critical architectural and security flaws, and suggests drop-in fixes.
        </p>
      </div>

      {/* Preset Switcher Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1.25rem',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            padding: 4,
            background: '#f1f5f9',
            borderRadius: 9999,
            border: '1px solid rgba(0,0,0,0.06)',
          }}
        >
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handleTabChange(preset.id)}
              style={{
                padding: '0.45rem 1.1rem',
                borderRadius: 9999,
                fontSize: '0.85rem',
                fontWeight: 600,
                color: activeTab === preset.id ? '#0f172a' : '#64748b',
                background: activeTab === preset.id ? '#ffffff' : 'transparent',
                boxShadow: activeTab === preset.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.15s ease',
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>

        <button
          onClick={toggleFix}
          className="btn-primary-pill btn-shimmer"
          style={{
            fontSize: '0.84rem',
            padding: '0.45rem 1.1rem',
            background: isFixed ? 'linear-gradient(180deg, #10b981 0%, #059669 100%)' : undefined,
          }}
        >
          {isFixed ? (
            <>
              <Check size={14} /> Patch Applied
            </>
          ) : (
            <>
              <RefreshCw size={14} /> Apply 1-Click Patch
            </>
          )}
        </button>
      </div>

      {/* Terminal / Code Diff Card with Aceternity laser beam and dot background */}
      <div className="diff-box" style={{ position: 'relative' }}>
        {/* Laser scan beam when active */}
        {isAnalyzing && <div className="diff-laser-beam" />}

        {/* Diff Top Bar */}
        <div className="diff-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#ef4444' }} />
              <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#f59e0b' }} />
              <div style={{ width: 11, height: 11, borderRadius: '50%', background: '#10b981' }} />
            </div>
            <div style={{ height: 14, width: 1, background: 'rgba(255,255,255,0.1)' }} />
            <span className="mono" style={{ color: '#f8fafc', fontSize: '0.84rem', fontWeight: 600 }}>
              {currentPreset.file}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }} className="hidden-mobile">
              {currentPreset.prTitle}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                color: '#60a5fa',
                background: 'rgba(59, 130, 246, 0.15)',
                padding: '3px 10px',
                borderRadius: 9999,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                border: '1px solid rgba(59, 130, 246, 0.3)',
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} className="pulse-indicator" />
              <span>{BRAND_NAME} Bot Active</span>
            </span>
          </div>
        </div>

        {/* Code Lines Body */}
        <div style={{ padding: '0.75rem 0', position: 'relative' }}>
          {isAnalyzing ? (
            <div style={{ padding: '3.5rem 2rem', textAlign: 'center', color: '#94a3b8' }}>
              <RefreshCw size={24} className="spin" style={{ margin: '0 auto 1rem', color: '#3b82f6' }} />
              <p className="mono" style={{ fontSize: '0.86rem', color: '#cbd5e1' }}>
                PullPilot analyzing diff &amp; related code context...
              </p>
            </div>
          ) : (
            <>
              {/* Display code lines with line hover state */}
              {(isFixed ? currentPreset.codeLinesAfter : currentPreset.codeLinesBefore).map((line, idx) => {
                const isHovered = hoveredLine === idx;
                return (
                  <div
                    key={idx}
                    onMouseEnter={() => setHoveredLine(idx)}
                    onMouseLeave={() => setHoveredLine(null)}
                    className={`diff-code-row ${
                      line.type === 'add' ? 'diff-code-add' : line.type === 'del' ? 'diff-code-del' : ''
                    }`}
                    style={{
                      background: isHovered
                        ? line.type === 'add'
                          ? 'rgba(16, 185, 129, 0.22)'
                          : line.type === 'del'
                          ? 'rgba(239, 68, 68, 0.22)'
                          : 'rgba(255, 255, 255, 0.05)'
                        : undefined,
                      transition: 'background 0.1s ease',
                      cursor: 'default',
                    }}
                  >
                    <span className="diff-code-num">{line.num}</span>
                    <span style={{ color: line.type === 'normal' ? '#cbd5e1' : undefined }}>{line.text}</span>
                  </div>
                );
              })}

              {/* Inline Bot Comment with Aceternity glow */}
              <AnimatePresence>
                {!isFixed && (
                  <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.98 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    className="diff-comment-bubble"
                    style={{
                      boxShadow: '0 10px 30px -5px rgba(59, 130, 246, 0.2)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '0.6rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, #007fff 0%, #1211ff 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#ffffff',
                          }}
                        >
                          <Cpu size={12} />
                        </div>
                        <strong style={{ color: '#ffffff', fontSize: '0.86rem' }}>pullpilot-bot[bot]</strong>
                        <span
                          style={{
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background:
                              currentPreset.severity === 'CRITICAL'
                                ? 'rgba(239, 68, 68, 0.2)'
                                : 'rgba(245, 158, 11, 0.2)',
                            color: currentPreset.severity === 'CRITICAL' ? '#f87171' : '#fbbf24',
                          }}
                        >
                          {currentPreset.severity} • {currentPreset.category}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>reviewed in 1.4s</span>
                    </div>

                    <p style={{ color: '#e2e8f0', fontSize: '0.86rem', lineHeight: 1.5, marginBottom: '0.75rem' }}>
                      <strong>{currentPreset.botFindingTitle}:</strong> {currentPreset.botExplanation}
                    </p>

                    <div
                      style={{
                        background: '#090d16',
                        padding: '0.6rem 0.85rem',
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <code className="mono" style={{ color: '#34d399', fontSize: '0.8rem' }}>
                        + {currentPreset.suggestedPatch}
                      </code>
                      <button
                        onClick={toggleFix}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          color: '#60a5fa',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'rgba(59, 130, 246, 0.15)',
                          cursor: 'pointer',
                        }}
                      >
                        Apply <ArrowRight size={12} />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
