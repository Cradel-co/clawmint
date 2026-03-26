import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary.jsx';

function ThrowingComponent({ shouldThrow }) {
  if (shouldThrow) throw new Error('Test error');
  return <div>Normal content</div>;
}

describe('ErrorBoundary', () => {
  // Suppress console.error for expected errors
  const originalError = console.error;
  beforeEach(() => { console.error = vi.fn(); });
  afterEach(() => { console.error = originalError; });

  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Algo salió mal en este panel.')).toBeInTheDocument();
    expect(screen.getByText('Reintentar')).toBeInTheDocument();
  });

  it('recovers when Reintentar is clicked and child stops throwing', () => {
    // ErrorBoundary resets its internal state on click, but since the same
    // child would throw again, we need to control whether it throws.
    let shouldThrow = true;
    function Controlled() {
      if (shouldThrow) throw new Error('boom');
      return <div>Normal content</div>;
    }

    render(
      <ErrorBoundary>
        <Controlled />
      </ErrorBoundary>
    );
    expect(screen.getByText('Algo salió mal en este panel.')).toBeInTheDocument();

    // Stop throwing before clicking reintentar
    shouldThrow = false;
    fireEvent.click(screen.getByText('Reintentar'));
    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });
});
