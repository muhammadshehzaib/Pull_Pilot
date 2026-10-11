import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextDiscoveryCard } from './ContextDiscoveryCard';
const report = { version: 1, status: 'PARTIAL', indexedFiles: 100, eligibleFiles: 200, selectedFiles: 0, reasons: ['DOWNLOAD_LIMIT'] };
describe('repository context coverage', () => {
  it('discloses partial discovery even when no background files were selected', () => {
    render(<ContextDiscoveryCard report={report} />);
    expect(screen.getByText('Repository context: Partial')).toBeTruthy();
    expect(screen.getByText(/100 of 200/)).toBeTruthy();
    expect(screen.getByText('Discovery reached its download limit.')).toBeTruthy();
    expect(screen.getByText(/do not prove function calls/)).toBeTruthy();
  });
  it('does not display an unavailable inventory as zero files successfully checked', () => {
    render(<ContextDiscoveryCard report={{ ...report, status: 'UNAVAILABLE', indexedFiles: 0, eligibleFiles: 0, reasons: ['TREE_UNAVAILABLE'] }} />);
    expect(screen.getByText('Repository context: Unavailable')).toBeTruthy();
    expect(screen.queryByText(/0 of 0/)).toBeNull();
  });
  it.each([undefined, {}, { ...report, version: 2 }, { ...report, indexedFiles: -1 }, { ...report, reasons: null }])('tolerates legacy or invalid metadata', value => {
    expect(render(<ContextDiscoveryCard report={value} />).container.textContent).toBe('');
  });
});
