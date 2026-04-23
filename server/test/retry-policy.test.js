'use strict';

const RetryPolicy = require('../core/RetryPolicy');

describe('RetryPolicy.classify', () => {
  const p = new RetryPolicy();

  test('timeout → transient', () => {
    expect(p.classify('Error: timeout after 60s')).toMatchObject({ transient: true, tag: 'transient:timeout' });
  });

  test('429 → transient rate_limit', () => {
    expect(p.classify('429 Too Many Requests')).toMatchObject({ transient: true, tag: 'transient:rate_limit' });
  });

  test('rate limit frase → transient', () => {
    expect(p.classify('rate limit exceeded')).toMatchObject({ transient: true, tag: 'transient:rate_limit' });
  });

  test('502 → transient 5xx', () => {
    expect(p.classify('HTTP 502 Bad Gateway')).toMatchObject({ transient: true, tag: 'transient:5xx' });
  });

  test('ECONNRESET → transient network', () => {
    expect(p.classify('Error: ECONNRESET')).toMatchObject({ transient: true, tag: 'transient:network' });
  });

  test('overloaded (Anthropic) → transient', () => {
    expect(p.classify('overloaded_error: Anthropic API is overloaded')).toMatchObject({ transient: true, tag: 'transient:overloaded' });
  });

  test('401 Unauthorized → permanent', () => {
    expect(p.classify('401 Unauthorized')).toMatchObject({ transient: false, tag: 'permanent' });
  });

  test('invalid_request → permanent', () => {
    expect(p.classify('invalid_request_error: bad params')).toMatchObject({ transient: false, tag: 'permanent' });
  });
});

describe('RetryPolicy.shouldRetry', () => {
  test('transient + attempt 0 + no tools → retry con delay', () => {
    const p = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1000, jitterMs: 0 });
    const d = p.shouldRetry({ errorMessage: '429', attempt: 0, usedTools: false });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBeGreaterThanOrEqual(1000);
    expect(d.reason).toBe('transient:rate_limit');
  });

  test('usedTools=true → NO retry aunque sea transient', () => {
    const p = new RetryPolicy();
    const d = p.shouldRetry({ errorMessage: 'timeout', attempt: 0, usedTools: true });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('tools_already_executed');
    expect(d.delayMs).toBe(0);
  });

  test('attempt al límite → NO retry', () => {
    const p = new RetryPolicy({ maxRetries: 3 });
    const d = p.shouldRetry({ errorMessage: '429', attempt: 2, usedTools: false });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('max_retries_reached');
  });

  test('error permanente → NO retry', () => {
    const p = new RetryPolicy();
    const d = p.shouldRetry({ errorMessage: '401 Unauthorized', attempt: 0, usedTools: false });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('permanent');
  });

  test('backoff exponencial crece', () => {
    const p = new RetryPolicy({ baseDelayMs: 1000, jitterMs: 0, maxDelayMs: 60_000 });
    const d0 = p.shouldRetry({ errorMessage: 'timeout', attempt: 0, usedTools: false });
    const d1 = p.shouldRetry({ errorMessage: 'timeout', attempt: 1, usedTools: false });
    expect(d1.delayMs).toBeGreaterThan(d0.delayMs);
  });

  test('delay capped a maxDelayMs', () => {
    const p = new RetryPolicy({ baseDelayMs: 1000, jitterMs: 0, maxDelayMs: 2000, maxRetries: 10 });
    const d = p.shouldRetry({ errorMessage: 'timeout', attempt: 5, usedTools: false });
    expect(d.delayMs).toBeLessThanOrEqual(2000);
  });

  test('jitter dentro de rango', () => {
    const p = new RetryPolicy({ baseDelayMs: 1000, jitterMs: 500, maxDelayMs: 10_000 });
    const samples = Array.from({ length: 50 }, () => p.shouldRetry({ errorMessage: 'timeout', attempt: 0, usedTools: false }).delayMs);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1500);
  });
});
