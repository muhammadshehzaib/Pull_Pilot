'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X, HelpCircle, RotateCcw, History, AlertTriangle, Loader2 } from 'lucide-react';
import { api, type ApiError } from '../lib/api';

export type FeedbackDisposition = 'UNREVIEWED' | 'ACCEPTED' | 'REJECTED' | 'NEEDS_REVIEW';
export type RejectionReason =
  | 'FALSE_POSITIVE'
  | 'DUPLICATE'
  | 'INTENDED_BEHAVIOR'
  | 'OUT_OF_SCOPE'
  | 'STYLE_PREFERENCE'
  | 'OTHER';

export interface FindingFeedbackData {
  id?: string;
  disposition: FeedbackDisposition;
  rejectionReason: RejectionReason | null;
  note: string | null;
  revision: number;
  updatedAt?: string;
}

export interface FeedbackEventData {
  id: string;
  feedbackId: string;
  actorId: string;
  disposition: FeedbackDisposition;
  rejectionReason: RejectionReason | null;
  revision: number;
  createdAt: string;
}

export interface FindingFeedbackControlProps {
  jobId: string;
  findingId?: string;
  initialFeedback?: FindingFeedbackData;
  isLegacy?: boolean;
  onFeedbackChanged?: (updated: FindingFeedbackData) => void;
}

const REJECTION_REASONS: { value: RejectionReason; label: string; description: string }[] = [
  { value: 'FALSE_POSITIVE', label: 'False Positive', description: 'Incorrect detector logic or impossible edge-case' },
  { value: 'INTENDED_BEHAVIOR', label: 'Intended Behavior', description: 'Expected business logic or deliberate pattern' },
  { value: 'DUPLICATE', label: 'Duplicate', description: 'Identical issue flagged elsewhere in the review' },
  { value: 'OUT_OF_SCOPE', label: 'Out of Scope', description: 'Pre-existing codebase issue unrelated to this PR' },
  { value: 'STYLE_PREFERENCE', label: 'Style Preference', description: 'Opinionated suggestion that conflicts with team style' },
  { value: 'OTHER', label: 'Other', description: 'Other rationale (specify in note)' },
];

export function FindingFeedbackControl({
  jobId,
  findingId,
  initialFeedback,
  isLegacy = false,
  onFeedbackChanged,
}: FindingFeedbackControlProps) {
  const [feedback, setFeedback] = useState<FindingFeedbackData>(
    initialFeedback || {
      disposition: 'UNREVIEWED',
      rejectionReason: null,
      note: null,
      revision: 0,
    },
  );

  const [isEditingReject, setIsEditingReject] = useState(false);
  const [selectedReason, setSelectedReason] = useState<RejectionReason>(
    initialFeedback?.rejectionReason || 'FALSE_POSITIVE',
  );
  const [note, setNote] = useState<string>(initialFeedback?.note || '');
  const [showNoteInput, setShowNoteInput] = useState(Boolean(initialFeedback?.note));
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'saved' | 'conflict' | 'error'; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<FeedbackEventData[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    setFeedback(initialFeedback ?? { disposition: 'UNREVIEWED', rejectionReason: null, note: null, revision: 0 });
    setNote(initialFeedback?.note ?? '');
  }, [findingId, initialFeedback]);

  if (isLegacy || !findingId) {
    return (
      <div className="feedback-legacy-banner" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem', fontStyle: 'italic' }}>
        ℹ️ Legacy review — explicit feedback identity not recorded for this finding.
      </div>
    );
  }

  async function submitFeedback(
    newDisposition: FeedbackDisposition,
    reason?: RejectionReason,
    customNote?: string,
  ) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setStatusMessage(null);

    try {
      const res = await api<{ feedback: FindingFeedbackData }>(
        `/api/jobs/${jobId}/findings/${findingId}/feedback`,
        {
          method: 'PUT',
          body: JSON.stringify({
            disposition: newDisposition,
            rejectionReason: newDisposition === 'REJECTED' ? reason : undefined,
            note: (customNote ?? note).trim() || undefined,
            expectedRevision: feedback.revision,
          }),
        },
      );

      const updated = res.feedback;
      setFeedback(updated);
      setSelectedReason(updated.rejectionReason || 'FALSE_POSITIVE');
      setNote(updated.note || '');
      setIsEditingReject(false);
      setStatusMessage({ type: 'saved', text: 'Feedback saved' });
      onFeedbackChanged?.(updated);
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409) {
        setStatusMessage({
          type: 'conflict',
          text: 'Conflict: feedback was modified in another session. Please refresh.',
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: apiErr.error || 'Failed to update feedback. Please retry.',
        });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function loadHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setLoadingHistory(true);
    setShowHistory(true);
    try {
      const res = await api<{ events: FeedbackEventData[] }>(
        `/api/jobs/${jobId}/findings/${findingId}/feedback/events`,
      );
      setHistoryEvents(res.events);
    } catch {
      setHistoryEvents([]);
    } finally {
      setLoadingHistory(false);
    }
  }

  return (
    <div
      className="finding-feedback-container"
      data-testid={`finding-feedback-${findingId}`}
      style={{
        marginTop: '0.75rem',
        padding: '0.75rem',
        borderRadius: '8px',
        backgroundColor: 'var(--bg-subtle, #f8fafc)',
        border: '1px solid var(--border, rgba(0,0,0,0.08))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Developer Feedback:
          </span>
          {feedback.disposition === 'ACCEPTED' && (
            <span
              className="badge-accepted"
              style={{
                fontSize: '0.75rem',
                backgroundColor: 'var(--success-soft, #ecfdf5)',
                color: 'var(--success, #10b981)',
                padding: '2px 8px',
                borderRadius: '999px',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <Check size={12} /> Accepted
            </span>
          )}
          {feedback.disposition === 'REJECTED' && (
            <span
              className="badge-rejected"
              style={{
                fontSize: '0.75rem',
                backgroundColor: 'var(--danger-soft, #fef2f2)',
                color: 'var(--danger, #ef4444)',
                padding: '2px 8px',
                borderRadius: '999px',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <X size={12} /> Rejected ({feedback.rejectionReason?.replace(/_/g, ' ') || 'REJECTED'})
            </span>
          )}
          {feedback.disposition === 'NEEDS_REVIEW' && (
            <span
              className="badge-needs-review"
              style={{
                fontSize: '0.75rem',
                backgroundColor: 'var(--warning-soft, #fffbeb)',
                color: 'var(--warning, #f59e0b)',
                padding: '2px 8px',
                borderRadius: '999px',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <HelpCircle size={12} /> Needs Review
            </span>
          )}
          {feedback.disposition === 'UNREVIEWED' && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Unreviewed
            </span>
          )}
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title="Optimistic revision count">
            (rev {feedback.revision})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <button
            type="button"
            id={`accept-btn-${findingId}`}
            disabled={saving || feedback.disposition === 'ACCEPTED'}
            onClick={() => submitFeedback('ACCEPTED')}
            className="btn-feedback-accept"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 500,
              borderRadius: '6px',
              border: '1px solid var(--border, rgba(0,0,0,0.1))',
              background: feedback.disposition === 'ACCEPTED' ? 'var(--success-soft)' : 'var(--surface, #fff)',
              color: feedback.disposition === 'ACCEPTED' ? 'var(--success)' : 'var(--text-primary)',
              cursor: saving || feedback.disposition === 'ACCEPTED' ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Check size={13} color="var(--success, #10b981)" /> 👍 Helpful
          </button>

          <button
            type="button"
            id={`reject-btn-${findingId}`}
            disabled={saving}
            onClick={() => setIsEditingReject(!isEditingReject)}
            className="btn-feedback-reject"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 500,
              borderRadius: '6px',
              border: '1px solid var(--border, rgba(0,0,0,0.1))',
              background: feedback.disposition === 'REJECTED' ? 'var(--danger-soft)' : 'var(--surface, #fff)',
              color: feedback.disposition === 'REJECTED' ? 'var(--danger)' : 'var(--text-primary)',
              cursor: saving ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <X size={13} color="var(--danger, #ef4444)" /> 👎 Not useful
          </button>

          <button
            type="button"
            id={`needs-review-btn-${findingId}`}
            disabled={saving || feedback.disposition === 'NEEDS_REVIEW'}
            onClick={() => submitFeedback('NEEDS_REVIEW')}
            className="btn-feedback-needs-review"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 500,
              borderRadius: '6px',
              border: '1px solid var(--border, rgba(0,0,0,0.1))',
              background: feedback.disposition === 'NEEDS_REVIEW' ? 'var(--warning-soft)' : 'var(--surface, #fff)',
              color: feedback.disposition === 'NEEDS_REVIEW' ? 'var(--warning)' : 'var(--text-primary)',
              cursor: saving || feedback.disposition === 'NEEDS_REVIEW' ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <HelpCircle size={13} color="var(--warning, #f59e0b)" /> Needs Review
          </button>

          {feedback.disposition !== 'UNREVIEWED' && (
            <button
              type="button"
              id={`reset-btn-${findingId}`}
              disabled={saving}
              onClick={() => submitFeedback('UNREVIEWED', undefined, '')}
              className="btn-feedback-reset"
              title="Reset feedback state to unreviewed"
              style={{
                padding: '4px 8px',
                fontSize: '0.75rem',
                borderRadius: '6px',
                border: '1px solid var(--border, rgba(0,0,0,0.1))',
                background: 'var(--surface, #fff)',
                color: 'var(--text-secondary)',
                cursor: saving ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <RotateCcw size={12} /> Reset
            </button>
          )}

          <button
            type="button"
            id={`history-btn-${findingId}`}
            onClick={loadHistory}
            className="btn-feedback-history"
            title="View feedback audit trail"
            style={{
              padding: '4px 8px',
              fontSize: '0.75rem',
              borderRadius: '6px',
              border: '1px solid var(--border, rgba(0,0,0,0.1))',
              background: 'var(--surface, #fff)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
            }}
          >
            <History size={12} /> History
          </button>
        </div>
      </div>

      {isEditingReject && (
        <div
          className="reject-selector-box"
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem',
            backgroundColor: 'var(--surface, #fff)',
            borderRadius: '6px',
            border: '1px solid var(--border, rgba(0,0,0,0.1))',
          }}
        >
          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>
            Select Rejection Reason:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.35rem' }}>
            {REJECTION_REASONS.map((r) => (
              <label
                key={r.value}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '6px',
                  padding: '4px 6px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  backgroundColor: selectedReason === r.value ? 'var(--danger-soft, #fef2f2)' : 'transparent',
                }}
              >
                <input
                  type="radio"
                  name={`rejection-${findingId}`}
                  value={r.value}
                  checked={selectedReason === r.value}
                  onChange={() => setSelectedReason(r.value)}
                  style={{ marginTop: '2px' }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>{r.label}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{r.description}</div>
                </div>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={() => setIsEditingReject(false)}
              style={{
                padding: '4px 10px',
                fontSize: '0.75rem',
                borderRadius: '4px',
                border: '1px solid var(--border)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              id={`confirm-reject-btn-${findingId}`}
              disabled={saving}
              onClick={() => submitFeedback('REJECTED', selectedReason)}
              style={{
                padding: '4px 12px',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: '4px',
                border: 'none',
                background: 'var(--danger, #ef4444)',
                color: '#fff',
                cursor: saving ? 'default' : 'pointer',
              }}
            >
              Confirm Rejection
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: '0.4rem' }}>
        {!showNoteInput ? (
          <button
            type="button"
            onClick={() => setShowNoteInput(true)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: '0.72rem',
              color: 'var(--accent, #2563eb)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {feedback.note ? `Note: "${feedback.note}" (edit)` : '+ Add developer note'}
          </button>
        ) : (
          <div style={{ marginTop: '0.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              <span>Developer note (internal only, max 1,000 chars):</span>
              <span>{note.length} / 1000</span>
            </div>
            <textarea
              id={`note-input-${findingId}`}
              maxLength={1000}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="E.g., Verified false positive: checked by security team on 2026-10-10."
              style={{
                width: '100%',
                fontSize: '0.75rem',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid var(--border)',
                marginTop: '2px',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.4rem', marginTop: '0.2rem' }}>
              <button
                type="button"
                onClick={() => { setNote(feedback.note ?? ''); setShowNoteInput(false); }}
                style={{ fontSize: '0.7rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button type="button" disabled={saving} onClick={() => submitFeedback(feedback.disposition, feedback.rejectionReason ?? undefined)}>
                Save note
              </button>
            </div>
          </div>
        )}
      </div>

      {statusMessage && (
        <div
          className={`feedback-status-${statusMessage.type}`}
          style={{
            marginTop: '0.4rem',
            fontSize: '0.75rem',
            padding: '4px 8px',
            borderRadius: '4px',
            backgroundColor:
              statusMessage.type === 'saved'
                ? 'var(--success-soft, #ecfdf5)'
                : statusMessage.type === 'conflict'
                  ? 'var(--warning-soft, #fffbeb)'
                  : 'var(--danger-soft, #fef2f2)',
            color:
              statusMessage.type === 'saved'
                ? 'var(--success, #10b981)'
                : statusMessage.type === 'conflict'
                  ? 'var(--warning, #f59e0b)'
                  : 'var(--danger, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {statusMessage.type === 'conflict' && <AlertTriangle size={13} />}
          {statusMessage.text}
        </div>
      )}

      {showHistory && (
        <div
          className="feedback-history-drawer"
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem',
            backgroundColor: 'var(--surface, #fff)',
            borderRadius: '6px',
            border: '1px solid var(--border, rgba(0,0,0,0.1))',
          }}
        >
          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.35rem', color: 'var(--text-primary)' }}>
            Audit History:
          </div>
          {loadingHistory ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Loader2 size={12} className="spin" /> Loading audit history…
            </div>
          ) : historyEvents.length === 0 ? (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>No feedback history recorded yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {historyEvents.map((evt) => (
                <div
                  key={evt.id}
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-secondary)',
                    padding: '3px 6px',
                    borderRadius: '4px',
                    backgroundColor: 'var(--bg-subtle, #f8fafc)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>
                    rev {evt.revision}: <strong>{evt.disposition}</strong>
                    {evt.rejectionReason ? ` (${evt.rejectionReason})` : ''}
                  </span>
                  <span>{new Date(evt.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
