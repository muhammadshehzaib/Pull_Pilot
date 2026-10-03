import picomatch from 'picomatch';
import { AiPrConfig, SeverityLevel } from './config.service';
import { SEVERITY_RANK, normalizeSeverity } from './ai/finding-taxonomy';

export interface FileDiffChunk {
  filename: string;
  diff: string;
  isIgnored: boolean;
}

/**
 * Severity rank for the lowercase values used by .aipr.yml. Derived from the
 * shared taxonomy so config and model output always agree.
 */
const SEVERITY_RANKS: Record<SeverityLevel, number> = {
  info: SEVERITY_RANK.INFO,
  low: SEVERITY_RANK.LOW,
  medium: SEVERITY_RANK.MEDIUM,
  high: SEVERITY_RANK.HIGH,
  critical: SEVERITY_RANK.CRITICAL,
};

export class DiffFilterService {
  /**
   * Parses a combined unified diff string into distinct per-file chunks.
   */
  public static splitDiffByFile(rawDiff: string): { filename: string; content: string }[] {
    const fileChunks: { filename: string; content: string }[] = [];
    // Unified diff files start with "diff --git a/... b/..."
    const diffFileDelimiter = /^diff --git a\/(.+?) b\/(.+?)$/gm;

    const matches: { filename: string; index: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = diffFileDelimiter.exec(rawDiff)) !== null) {
      // match[2] is the destination filename 'b/...'
      matches.push({
        filename: match[2],
        index: match.index,
      });
    }

    if (matches.length === 0) {
      // Fallback: entire diff if no standard git header found
      return [{ filename: 'unknown', content: rawDiff }];
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const nextIndex = i + 1 < matches.length ? matches[i + 1].index : rawDiff.length;
      const content = rawDiff.slice(current.index, nextIndex).trim();

      fileChunks.push({
        filename: current.filename,
        content,
      });
    }

    return fileChunks;
  }

  /**
   * Filters out ignored files from a unified diff based on the glob patterns in AiPrConfig.
   * Returns both the filtered diff string and statistics on what was ignored.
   */
  public static filterDiff(
    rawDiff: string,
    config: AiPrConfig
  ): { filteredDiff: string; ignoredFiles: string[]; includedFiles: string[] } {
    if (!rawDiff || rawDiff.trim().length === 0) {
      return { filteredDiff: '', ignoredFiles: [], includedFiles: [] };
    }

    const isMatch = picomatch(config.ignore, { dot: true });
    const chunks = this.splitDiffByFile(rawDiff);

    const includedChunks: string[] = [];
    const ignoredFiles: string[] = [];
    const includedFiles: string[] = [];

    for (const chunk of chunks) {
      // Normalize path (remove leading slashes or ./ if any)
      const normalizedPath = chunk.filename.replace(/^\.\//, '');

      if (isMatch(normalizedPath)) {
        ignoredFiles.push(normalizedPath);
      } else {
        includedFiles.push(normalizedPath);
        includedChunks.push(chunk.content);
      }
    }

    const filteredDiff = includedChunks.join('\n\n');
    return {
      filteredDiff,
      ignoredFiles,
      includedFiles,
    };
  }

  /**
   * Checks if an AI review finding meets the minimum severity threshold.
   *
   * A missing or unrecognised severity is treated as INFO rather than being
   * dropped outright, so a model that invents a new level cannot silently
   * remove findings from a review.
   */
  public static isSeverityMet(findingSeverity: string | undefined, minSeverity: SeverityLevel): boolean {
    const normalized = normalizeSeverity(findingSeverity) ?? 'INFO';
    const itemRank = SEVERITY_RANK[normalized] ?? 0;
    const minRank = SEVERITY_RANKS[minSeverity] ?? SEVERITY_RANK.LOW;
    return itemRank >= minRank;
  }

  /**
   * Builds an augmented AI system prompt appending custom guidelines from .aipr.yml.
   */
  public static augmentPromptWithGuidelines(basePrompt: string, config: AiPrConfig): string {
    if (!config.guidelines || config.guidelines.length === 0) {
      return basePrompt;
    }

    const guidelinesList = config.guidelines.map((g, idx) => `${idx + 1}. ${g}`).join('\n');
    return `${basePrompt}\n\n### Repository-Specific Rules (.aipr.yml):\n${guidelinesList}\n`;
  }
}
