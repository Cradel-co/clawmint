import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ReconnectBanner from '../components/ReconnectBanner.jsx';

describe('ReconnectBanner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders nothing when connected', () => {
    const { container } = render(<ReconnectBanner connected={true} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows "Reconectando..." when disconnected', () => {
    render(<ReconnectBanner connected={false} />);
    expect(screen.getByText('Reconectando...')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('reconnect-warning');
  });

  it('shows success message briefly after reconnection', () => {
    const { rerender } = render(<ReconnectBanner connected={false} />);
    expect(screen.getByText('Reconectando...')).toBeInTheDocument();

    // Reconnect
    rerender(<ReconnectBanner connected={true} />);
    expect(screen.getByText('✓ Conexión restablecida')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('reconnect-success');

    // After 2s, banner disappears
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
