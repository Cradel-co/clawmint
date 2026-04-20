'use strict';

const { CAPS, get } = require('../providers/capabilities');

describe('caching capabilities — shape por provider (Fase 7.5.2)', () => {
  test('anthropic: explicit + 5m/1h + placements', () => {
    const c = get('anthropic').caching;
    expect(c.mode).toBe('explicit');
    expect(c.ttls).toEqual(expect.arrayContaining(['5m', '1h']));
    expect(c.placements).toEqual(expect.arrayContaining(['system', 'tools', 'history']));
    expect(c.hit_field).toBe('cache_read_input_tokens');
  });

  test('openai: automatic + minPrefixTokens + hit_field', () => {
    const c = get('openai').caching;
    expect(c.mode).toBe('automatic');
    expect(c.minPrefixTokens).toBe(1024);
    expect(c.hit_field).toBe('prompt_tokens_details.cached_tokens');
  });

  test('gemini: explicit + placements', () => {
    const c = get('gemini').caching;
    expect(c.mode).toBe('explicit');
    expect(c.ttls).toContain('1h');
  });

  test('deepseek: automatic con hit_field propio', () => {
    const c = get('deepseek').caching;
    expect(c.mode).toBe('automatic');
    expect(c.hit_field).toBe('prompt_cache_hit_tokens');
  });

  test('grok: automatic', () => {
    expect(get('grok').caching.mode).toBe('automatic');
  });

  test('ollama: none (local)', () => {
    expect(get('ollama').caching.mode).toBe('none');
  });

  test('caching inmutable', () => {
    expect(Object.isFrozen(CAPS.anthropic.caching)).toBe(true);
  });

  test('provider desconocido: no caching field', () => {
    const caps = get('nonexistent');
    expect(caps.caching).toBeUndefined();
  });
});
