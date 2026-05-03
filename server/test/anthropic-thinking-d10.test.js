'use strict';

const { _internal } = require('../providers/anthropic');
const { resolveThinking, _adaptiveBudget, _estimateHistoryTokens, _hashUserId, _buildBetas } = _internal;

describe('D10 — resolveThinking', () => {
  test('Haiku model → null forzado (API rechaza thinking)', () => {
    const r = resolveThinking('adaptive', null, { model: 'claude-haiku-4-5-20251001' });
    expect(r).toBeNull();
  });

  test('Haiku con número → null', () => {
    const r = resolveThinking(4096, null, { model: 'claude-haiku' });
    expect(r).toBeNull();
  });

  test('Opus + adaptive + history chico → budget mínimo 2048', () => {
    const r = resolveThinking('adaptive', null, { model: 'claude-opus-4-6', historyTokens: 100, maxOutputTokens: 16000 });
    expect(r).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  test('Opus + adaptive + history 50k → budget ~5000', () => {
    const r = resolveThinking('adaptive', null, { model: 'claude-opus-4-6', historyTokens: 50_000, maxOutputTokens: 16000 });
    expect(r.budget_tokens).toBeGreaterThanOrEqual(5000);
    expect(r.budget_tokens).toBeLessThan(16000);
  });

  test('Opus + adaptive + history gigante → capado a maxOutputTokens-1', () => {
    const r = resolveThinking('adaptive', null, { model: 'claude-opus-4-6', historyTokens: 1_000_000, maxOutputTokens: 16000 });
    expect(r.budget_tokens).toBe(15999);
  });

  test('Opus + number → shorthand', () => {
    const r = resolveThinking(4096, null, { model: 'claude-opus-4-6' });
    expect(r).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  test('false → null', () => {
    expect(resolveThinking(false)).toBeNull();
    expect(resolveThinking(undefined)).toBeNull();
  });
});

describe('D10 — _estimateHistoryTokens', () => {
  test('string content', () => {
    const tokens = _estimateHistoryTokens([
      { role: 'user', content: 'a'.repeat(400) },
    ]);
    expect(tokens).toBe(100); // 400/4
  });

  test('array content con text + thinking', () => {
    const tokens = _estimateHistoryTokens([
      { role: 'assistant', content: [
        { type: 'text', text: 'a'.repeat(200) },
        { type: 'thinking', thinking: 'b'.repeat(400) },
      ]},
    ]);
    expect(tokens).toBe(50 + 100);
  });

  test('vacío', () => {
    expect(_estimateHistoryTokens([])).toBe(0);
    expect(_estimateHistoryTokens(null)).toBe(0);
  });
});

describe('D10 — _adaptiveBudget', () => {
  test('pisa suelo 2048', () => {
    expect(_adaptiveBudget(100, 16000)).toBe(2048);
  });
  test('escala a ~10%', () => {
    expect(_adaptiveBudget(50_000, 16000)).toBe(5000);
  });
  test('capa a max-1', () => {
    expect(_adaptiveBudget(500_000, 16000)).toBe(15999);
  });
});

describe('D8 — metadata + betas', () => {
  test('_hashUserId determinista + prefijado con u_', () => {
    const a = _hashUserId('user123');
    const b = _hashUserId('user123');
    expect(a).toBe(b);
    expect(a.startsWith('u_')).toBe(true);
    expect(a.length).toBeLessThan(25);
    expect(_hashUserId(null)).toBeUndefined();
  });

  test('_buildBetas según flags', () => {
    expect(_buildBetas({})).toEqual([]);
    expect(_buildBetas({ enableCache: true })).toContain('prompt-caching-2024-07-31');
    expect(_buildBetas({ enableThinking: true })).toContain('extended-thinking-2024-10-24');
    expect(_buildBetas({ contextWindow1M: true })).toContain('context-1m-2024-11');
    expect(_buildBetas({ enableCache: true, enableThinking: true }).length).toBe(2);
  });
});
