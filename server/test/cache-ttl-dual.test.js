'use strict';

const anthropic = require('../providers/anthropic');
const { resolveCacheTtl, applyCacheToSystem, applyCacheToTools } = anthropic._internal;

describe('resolveCacheTtl — Fase 7.5.3', () => {
  test('main_thread → 1h', () => {
    expect(resolveCacheTtl('main_thread')).toBe('1h');
  });

  test('sdk → 1h', () => {
    expect(resolveCacheTtl('sdk')).toBe('1h');
  });

  test('microcompact → 5m', () => {
    expect(resolveCacheTtl('microcompact')).toBe('5m');
  });

  test('consolidator → 5m', () => {
    expect(resolveCacheTtl('consolidator')).toBe('5m');
  });

  test('reactive_compact → 5m', () => {
    expect(resolveCacheTtl('reactive_compact')).toBe('5m');
  });

  test('source desconocido → 5m (default conservador)', () => {
    expect(resolveCacheTtl('unknown_source')).toBe('5m');
  });

  test('source undefined/null → 5m', () => {
    expect(resolveCacheTtl(undefined)).toBe('5m');
    expect(resolveCacheTtl(null)).toBe('5m');
  });

  test('case insensitive', () => {
    expect(resolveCacheTtl('MAIN_THREAD')).toBe('1h');
    expect(resolveCacheTtl('Main_Thread')).toBe('1h');
  });
});

describe('applyCacheToSystem con TTL dinámico', () => {
  test('default ttl=5m → cache_control sin ttl explícito', () => {
    const result = applyCacheToSystem('x'.repeat(1500));
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('ttl=1h → cache_control con ttl=1h', () => {
    const result = applyCacheToSystem('x'.repeat(1500), '1h');
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('ttl=5m explícito → sin ttl field (Anthropic lo asume por default)', () => {
    const result = applyCacheToSystem('x'.repeat(1500), '5m');
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('array de bloques → aplica TTL al último', () => {
    const blocks = [
      { type: 'text', text: 'intro' },
      { type: 'text', text: 'main content' },
    ];
    const result = applyCacheToSystem(blocks, '1h');
    expect(result[0]).toEqual({ type: 'text', text: 'intro' });
    expect(result[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('prompt corto (<1000 chars) NO cachea', () => {
    const result = applyCacheToSystem('corto');
    expect(result).toBe('corto');
  });
});

describe('applyCacheToTools con TTL dinámico', () => {
  test('ttl=1h inyectado en última tool', () => {
    const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const result = applyCacheToTools(tools, '1h');
    expect(result[0]).toEqual({ name: 'a' });
    expect(result[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('array vacío → passthrough', () => {
    expect(applyCacheToTools([], '1h')).toEqual([]);
  });
});
