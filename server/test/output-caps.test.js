'use strict';

const outputCaps = require('../core/outputCaps');

function withEnv(patch, fn) {
  const orig = { ...process.env };
  Object.assign(process.env, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k];
  try { fn(); } finally { process.env = orig; }
}

describe('outputCaps — defaults y env overrides', () => {
  beforeEach(() => {
    delete process.env.BASH_MAX_OUTPUT_LENGTH;
    delete process.env.BASH_MAX_OUTPUT_UPPER_LIMIT;
    delete process.env.GREP_HEAD_LIMIT_DEFAULT;
    delete process.env.OUTPUT_CAPS_ENABLED;
  });

  test('bashMaxOutputLength default 30_000', () => {
    expect(outputCaps.bashMaxOutputLength()).toBe(30_000);
  });

  test('bashUpperLimit default 150_000', () => {
    expect(outputCaps.bashUpperLimit()).toBe(150_000);
  });

  test('grepHeadLimitDefault default 250', () => {
    expect(outputCaps.grepHeadLimitDefault()).toBe(250);
  });

  test('BASH_MAX_OUTPUT_LENGTH env override', () => {
    withEnv({ BASH_MAX_OUTPUT_LENGTH: '5000' }, () => {
      expect(outputCaps.bashMaxOutputLength()).toBe(5000);
    });
  });

  test('valor inválido en env → fallback al default', () => {
    withEnv({ BASH_MAX_OUTPUT_LENGTH: 'not-a-number' }, () => {
      expect(outputCaps.bashMaxOutputLength()).toBe(30_000);
    });
  });

  test('isEnabled default true', () => {
    expect(outputCaps.isEnabled()).toBe(true);
  });

  test('OUTPUT_CAPS_ENABLED=false → disabled', () => {
    withEnv({ OUTPUT_CAPS_ENABLED: 'false' }, () => {
      expect(outputCaps.isEnabled()).toBe(false);
    });
  });
});

describe('outputCaps.truncateBashOutput', () => {
  test('output chico no se trunca', () => {
    const out = outputCaps.truncateBashOutput('hola mundo');
    expect(out).toBe('hola mundo');
  });

  test('output grande se trunca con prefix', () => {
    const big = 'x'.repeat(50_000);
    const out = outputCaps.truncateBashOutput(big);
    expect(out).toMatch(/^\[truncado \d+ bytes — mostrando últimos 30000 bytes/);
    expect(out.length).toBeLessThan(50_000);
  });

  test('preserva el final del output (no el inicio)', () => {
    // Poner un marcador único al final para verificar que se preserva
    const big = 'x'.repeat(50_000) + 'TAIL_MARKER';
    const out = outputCaps.truncateBashOutput(big);
    expect(out).toMatch(/TAIL_MARKER/);
  });

  test('opts.maxLength override per-call', () => {
    const big = 'x'.repeat(10_000);
    const out = outputCaps.truncateBashOutput(big, { maxLength: 100 });
    expect(out.length).toBeLessThan(500); // prefix + 100 chars
  });

  test('respeta bashUpperLimit como techo absoluto', () => {
    withEnv({ BASH_MAX_OUTPUT_LENGTH: '1000000' /* 1MB */, BASH_MAX_OUTPUT_UPPER_LIMIT: '50000' }, () => {
      const big = 'x'.repeat(100_000);
      const out = outputCaps.truncateBashOutput(big);
      expect(out.length).toBeLessThan(52_000); // <= upper limit + prefix
    });
  });

  test('OUTPUT_CAPS_ENABLED=false → no trunca', () => {
    withEnv({ OUTPUT_CAPS_ENABLED: 'false' }, () => {
      const big = 'x'.repeat(50_000);
      expect(outputCaps.truncateBashOutput(big)).toBe(big);
    });
  });

  test('non-string input pasa sin tocar', () => {
    expect(outputCaps.truncateBashOutput(null)).toBeNull();
    expect(outputCaps.truncateBashOutput(undefined)).toBeUndefined();
    expect(outputCaps.truncateBashOutput(42)).toBe(42);
  });
});
