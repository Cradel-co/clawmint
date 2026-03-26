import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Skeleton from '../components/Skeleton.jsx';

describe('Skeleton', () => {
  it('renders with default 3 lines', () => {
    const { container } = render(<Skeleton />);
    const lines = container.querySelectorAll('.skeleton-line');
    expect(lines).toHaveLength(3);
  });

  it('renders custom number of lines', () => {
    const { container } = render(<Skeleton lines={5} />);
    const lines = container.querySelectorAll('.skeleton-line');
    expect(lines).toHaveLength(5);
  });

  it('has aria-busy and aria-label for accessibility', () => {
    render(<Skeleton />);
    const container = screen.getByLabelText('Cargando...');
    expect(container).toHaveAttribute('aria-busy', 'true');
  });

  it('applies custom style', () => {
    const { container } = render(<Skeleton style={{ maxWidth: '200px' }} />);
    const el = container.querySelector('.skeleton-container');
    expect(el.style.maxWidth).toBe('200px');
  });
});
