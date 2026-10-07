import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  it('renders nothing when there is only one page', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the page indicator and the total when given', () => {
    render(<Pagination page={2} totalPages={5} total={123} noun="reviews" onChange={() => {}} />);
    expect(screen.getByText('Page 2 of 5 · 123 reviews')).toBeInTheDocument();
  });

  it('navigates backwards and forwards', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<Pagination page={2} totalPages={4} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onChange).toHaveBeenCalledWith(1);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('disables Prev on the first page and Next on the last', () => {
    const { rerender } = render(<Pagination page={1} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();

    rerender(<Pagination page={3} totalPages={3} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('locks both buttons while a page load is in flight', () => {
    render(<Pagination page={2} totalPages={3} onChange={() => {}} busy />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});
