# Phase 8 — Historical Intelligence & Review Memory

## Overview

Historical Intelligence introduces an auditable, repository-scoped feedback loop that enables:
1. **Explicit Developer Feedback:** Developers can accept, reject (with structured reasons), flag for review, or reset feedback on individual finding occurrences.
2. **Recurring Pattern Detection:** Cross-PR pattern aggregation detects recurring issues across distinct pull requests with deduplication and retry inflation prevention.
3. **Opt-in Review Memory:** Bounded, relevant historical patterns are supplied as background context to future reviews of the same repository.
4. **Transparent Governance:** Clear safety boundaries guarantee that historical context never suppresses security checks or substitutes for concrete evidence in code changes.

> **Note on "Learning":** In this system, "learning" refers to retrieving and applying explicit developer feedback and historical patterns at inference time. It does **not** perform fine-tuning or model weight training.

---

## 1. Stable Identity & Grouping

A critical flaw in naive review feedback systems is attaching feedback to fragile attributes like line numbers or array indices. Phase 8 decouples occurrence identity from cross-review pattern identity:

### Finding Occurrence ID (`FindingOccurrence`)
- Uniquely identifies one finding within one specific review snapshot.
- Retrying a background analysis job marks previous attempts as superseded and assigns monotonic snapshot keys (`jobId:seq:index`), ensuring idempotency and preventing duplicate entries.

### Pattern Fingerprint (`fingerprint`)
- Generates a versioned (`fp_v1_...`), deterministic grouping key across different pull requests:
  - Scope: Normalised file/module path (extension-agnostic, lowercased, test prefixes stripped).
  - Detector rule key: Rule ID or detector probe name when available.
  - Category fallback: When detector ID is absent, combines category and stable signature.

---

## 2. Developer Feedback Lifecycle

Developer feedback is recorded against a specific finding occurrence with optimistic concurrency control.

### Dispositions
- `UNREVIEWED`: Initial default state. Silence is never interpreted as acceptance.
- `ACCEPTED`: Developer confirmed the finding was actionable or useful. (Does not prove the issue was fixed or tested).
- `REJECTED`: Finding was dismissed. Requires an explicit rejection reason.
- `NEEDS_REVIEW`: Flagged for subsequent review or team consultation.

### Rejection Reasons
- `FALSE_POSITIVE`: Detector error, impossible code path, or invalid assumption.
- `INTENDED_BEHAVIOR`: Deliberate design choice or approved architectural exception.
- `DUPLICATE`: Redundant finding flagged elsewhere in the review.
- `OUT_OF_SCOPE`: Pre-existing code defect unrelated to the pull request changes.
- `STYLE_PREFERENCE`: Stylistic suggestion conflicting with team preference.
- `OTHER`: Other reasons (optionally documented in note).

### Optimistic Concurrency & Audit Events
- Each feedback record carries a monotonic `revision` counter.
- Updates can specify `expectedRevision` to detect concurrent edits and return HTTP `409 Conflict`.
- Every feedback modification appends an immutable event to `finding_feedback_events` recording the actor ID, disposition, rejection reason, and timestamp.

---

## 3. Cross-PR Pattern Aggregation

The aggregation service (`aggregation.service.ts`) periodically rebuilds `historical_patterns`:

### Invariants & Counting Rules
- **Sliding Window:** Bounded to the last 90 days and up to 200 candidate completed jobs.
- **Distinct PR Support (`distinctPrCount`):** Only counts unique pull request numbers (`referenceId`). Repeated analysis runs or retries of the same PR never inflate distinct PR support.
- **Push Jobs:** Non-PR push audits contribute to total occurrence count but do not inflate distinct PR metrics.
- **Recurring Threshold:** Patterns supported by $\ge 3$ distinct PRs are classified as **recurring**.
- **False Positive Metrics:** Only explicitly rejected findings with reason `FALSE_POSITIVE` contribute to the reported false-positive rate.

---

## 4. Review Memory & Safety Boundaries

When a repository enables Historical Intelligence (`historicalIntelligenceEnabled: true`), the review pipeline supplies bounded historical patterns to future AI reviews.

### Retrieval & Bounding
- Evaluates changed file paths against pattern representative paths to prioritize relevant patterns.
- Retrieves up to **5 candidate patterns**.
- Bounded serialized context: up to **4,000 characters**.
- Free-text feedback notes are **never** injected into the model prompt to prevent prompt injection or credential leakage.

### Safety Boundaries
1. **Background Guidance Only:** Historical patterns inform what potential defects to inspect. They are **never** evidence that a current defect exists.
2. **Current-Code Evidence Mandatory:** Every reported finding must be anchored directly to a changed line in the current diff.
3. **No Automatic Suppression:** Past rejections never suppress deterministic security checks (SAST, secrets, dependency vulnerabilities) or repository rules.
4. **Risk Engine Integrity:** Risk scoring and blocking verdicts are never relaxed based on historical feedback alone.
5. **Fault Isolation:** Memory retrieval failure logs a warning and proceeds with normal review execution.

---

## 5. API Reference

All endpoints require authentication and enforce repository ownership scoping (`repository.userId = req.auth.userId`).

### Finding Occurrences & Feedback
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/jobs/:id/findings` | Lists stable findings with their current feedback state and revision. |
| `PUT` | `/api/jobs/:id/findings/:findingId/feedback` | Upserts feedback with optimistic concurrency (`expectedRevision`). |
| `GET` | `/api/jobs/:id/findings/:findingId/feedback/events` | Retrieves append-only audit trail for a finding. |
| `POST` | `/api/jobs/:id/findings/backfill` | Idempotent on-demand backfill for legacy reviews. |

### Repository Settings & Insights
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/repositories/:id/historical-intelligence/settings` | Gets opt-in review memory setting. |
| `PATCH` | `/api/repositories/:id/historical-intelligence/settings` | Updates `historicalIntelligenceEnabled` boolean. |
| `GET` | `/api/repositories/:id/historical-insights` | Retrieves recurring patterns, distinct PR counts, and summary metrics. |

---

## 6. Frontend UI Controls

- **Per-Finding Feedback Controls:** Integrated into `/history` finding cards (`FindingFeedbackControl.tsx`), providing 1-click Accept, structured Reject with reason selection, Needs Review, Reset, optional notes, and audit history viewer.
- **Repository Insights Panel:** Modal dialog (`RepositoryInsightsPanel.tsx`) showing overall occurrence stats, recurring patterns, distinct PR counts, affected file paths, feedback breakdowns, and settings toggles.
- **Attribution Banner:** Review detail cards clearly display attribution when historical review memory was supplied to an audit.

---

## 7. Privacy, Deletion, & Retention

- **Tenant Isolation:** Patterns and feedback are strictly isolated to the owning repository. Cross-repository or cross-user memory sharing is prohibited.
- **Repository Deletion:** Cascading foreign keys ensure that deleting a repository removes all occurrences, feedbacks, audit events, and historical patterns.
- **Data Minimization:** No entire source files are stored for historical memory; only bounded summaries ($\le 300$ chars) and fingerprints are preserved.
