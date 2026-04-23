'use strict';

/**
 * D3 — Verifica que applyCacheToSystem respete el flag `_cacheable` para poner
 * el breakpoint en el último bloque estable, dejando los bloques dinámicos
 * (memoryCtx, toolInstr) sin cache_control.
 */

const { _internal } = require('../providers/anthropic');
const { applyCacheToSystem } = _internal;

describe('D3 — applyCacheToSystem con _cacheable', () => {
  test('array con _cacheable en primer bloque → breakpoint va ahí, no al final', () => {
    const blocks = [
      { type: 'text', text: 'stable base prompt', _cacheable: true },
      { type: 'text', text: 'dynamic memoryCtx' },
      { type: 'text', text: 'dynamic toolInstr' },
    ];
    const out = applyCacheToSystem(blocks, '5m');
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(3);
    // El bloque estable tiene cache_control; los dinámicos NO
    expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(out[1].cache_control).toBeUndefined();
    expect(out[2].cache_control).toBeUndefined();
    // Flag interno strippeado
    expect(out[0]._cacheable).toBeUndefined();
  });

  test('_cacheable en último bloque → cache_control ahí', () => {
    const blocks = [
      { type: 'text', text: 'stable a', _cacheable: true },
      { type: 'text', text: 'stable b', _cacheable: true },
    ];
    const out = applyCacheToSystem(blocks, '5m');
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('TTL 1h se propaga al cache_control', () => {
    const blocks = [
      { type: 'text', text: 'stable', _cacheable: true },
      { type: 'text', text: 'dyn' },
    ];
    const out = applyCacheToSystem(blocks, '1h');
    expect(out[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('sin flags _cacheable → comportamiento legacy (último bloque)', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    const out = applyCacheToSystem(blocks, '5m');
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('string largo se wrappea en bloque cacheado', () => {
    const long = 'x'.repeat(2000);
    const out = applyCacheToSystem(long, '5m');
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('string corto no se cachea (pasthrough)', () => {
    const out = applyCacheToSystem('corto', '5m');
    expect(out).toBe('corto');
  });
});
