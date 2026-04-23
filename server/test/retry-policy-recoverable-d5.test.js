'use strict';

const RetryPolicy = require('../core/RetryPolicy');

describe('D5 — RetryPolicy recoverable errors', () => {
  const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500, jitterMs: 0 });

  test('prompt_too_long → transient + recoverable', () => {
    const c = policy.classify('prompt is too long for model');
    expect(c.transient).toBe(true);
    expect(c.recoverable).toBe(true);
    expect(c.tag).toBe('recoverable:context_exceeded');
  });

  test('request too large → recoverable', () => {
    const c = policy.classify('Error: Request too large for this model');
    expect(c.recoverable).toBe(true);
  });

  test('context_length_exceeded → recoverable', () => {
    const c = policy.classify('context length exceeded 200000 tokens');
    expect(c.recoverable).toBe(true);
  });

  test('rate_limit → transient pero NO recoverable', () => {
    const c = policy.classify('429 rate limit exceeded');
    expect(c.transient).toBe(true);
    expect(c.recoverable).toBe(false);
  });

  test('timeout → transient pero NO recoverable', () => {
    const c = policy.classify('Error: timeout waiting for response');
    expect(c.transient).toBe(true);
    expect(c.recoverable).toBe(false);
  });

  test('permanent errors → neither', () => {
    const c = policy.classify('Error: invalid API key');
    expect(c.transient).toBe(false);
    expect(c.recoverable).toBe(false);
    expect(c.tag).toBe('permanent');
  });

  test('shouldRetry marca recoverable en decision', () => {
    const d = policy.shouldRetry({ errorMessage: 'prompt_too_long', attempt: 0, usedTools: false });
    expect(d.retry).toBe(true);
    expect(d.recoverable).toBe(true);
    expect(d.reason).toBe('recoverable:context_exceeded');
  });

  test('shouldRetry transient normal sin flag recoverable', () => {
    const d = policy.shouldRetry({ errorMessage: 'Error: 429', attempt: 0, usedTools: false });
    expect(d.retry).toBe(true);
    expect(d.recoverable).toBe(false);
  });
});
