import type { PaginationMeta } from './api';
export interface RiskPoint { start: string; end: string; averageRisk: number | null; scoredPRs: number; reviewedPRs: number; partialBucket: boolean }
export interface HealthReview { jobId: string; repositoryId: string; repository: string; referenceId: string; completedAt: string;
  criticalCount: number; securityCount: number; testGapCount: number | null; riskScore: number | null; reportedFixed: boolean }
export interface HealthRepository { id: string; fullName: string; reviewedPRs: number | null; criticalFindings: number | null;
  securityFindings: number | null; averageRisk: number | null; scoredPRs: number }
export interface Page<T> { items: T[]; pagination: PaginationMeta }
export interface EngineeringHealthReport {
  version: number;
  scope: { range: string; bucket: string; repositoryId: string | null; start: string; end: string; previousStart: string; timezone: string };
  generatedAt: string;
  metrics: { repositories: number; reviewedPRs: number | null; criticalFindings: number | null; securityFindings: number | null;
    suggestedTestGaps: number | null; developerReportedFixes: number | null; averageRisk: number | null };
  coverage: { capturedPRs: number; scoredPRs: number; testGapScannedPRs: number; legacyJobsWithoutCompletionDate: number; approximatePRs: number;
    unscoredPRs: number; fixCoverageComplete: boolean; workflowQueryLimited: boolean; queryLimited: boolean; repositoryListLimited: boolean;
    trackingStartedAt: string; partial: boolean };
  comparison: { available: boolean; reason: string | null; currentAverage: number | null; previousAverage: number | null;
    currentScoredPRs: number; previousScoredPRs: number; percentageChange: number | null };
  trend: RiskPoint[]; repositories: Page<HealthRepository>; repositoryOptions: { id: string; fullName: string }[]; reviews: Page<HealthReview>;
}
