'use strict';

const LoopDetector = require('../core/LoopDetector');

describe('LoopDetector', () => {
  test('3 iguales consecutivos → detected', () => {
    const d = new LoopDetector({ bufferSize: 5, threshold: 3 });
    expect(d.track('grep', { pattern: 'foo' }).detected).toBe(false);
    expect(d.track('grep', { pattern: 'foo' }).detected).toBe(false);
    const r = d.track('grep', { pattern: 'foo' });
    expect(r.detected).toBe(true);
    expect(r.consecutiveCount).toBe(3);
  });

  test('args distintos NO detectan loop', () => {
    const d = new LoopDetector({ threshold: 3 });
    expect(d.track('grep', { pattern: 'foo' }).detected).toBe(false);
    expect(d.track('grep', { pattern: 'bar' }).detected).toBe(false);
    expect(d.track('grep', { pattern: 'foo' }).detected).toBe(false);
  });

  test('diferente tool name NO detecta', () => {
    const d = new LoopDetector({ threshold: 3 });
    d.track('grep', { x: 1 });
    d.track('grep', { x: 1 });
    const r = d.track('glob', { x: 1 });
    expect(r.detected).toBe(false);
    expect(r.consecutiveCount).toBe(1);
  });

  test('romper racha resetea conteo', () => {
    const d = new LoopDetector({ threshold: 3 });
    d.track('grep', { x: 1 });
    d.track('grep', { x: 1 });
    d.track('grep', { x: 2 }); // rompe
    expect(d.track('grep', { x: 1 }).detected).toBe(false);
    expect(d.track('grep', { x: 1 }).detected).toBe(false);
    expect(d.track('grep', { x: 1 }).detected).toBe(true); // 3 nuevos
  });

  test('ring buffer no excede bufferSize', () => {
    const d = new LoopDetector({ bufferSize: 3, threshold: 2 });
    d.track('a', {});
    d.track('a', {});
    d.track('a', {});
    d.track('a', {});
    expect(d._ring).toHaveLength(3);
  });

  test('reset() limpia el buffer', () => {
    const d = new LoopDetector({ threshold: 2 });
    d.track('a', {});
    d.track('a', {});
    d.reset();
    expect(d.track('a', {}).detected).toBe(false);
  });

  test('args con circular refs no crashea', () => {
    const d = new LoopDetector();
    const circular = {};
    circular.self = circular;
    expect(() => d.track('x', circular)).not.toThrow();
  });

  test('hash estable para args equivalentes', () => {
    const d = new LoopDetector();
    const r1 = d.track('x', { a: 1, b: 2 });
    const r2 = d.track('x', { a: 1, b: 2 });
    expect(r1.argsHash).toBe(r2.argsHash);
  });

  test('threshold > bufferSize → error en construcción', () => {
    expect(() => new LoopDetector({ bufferSize: 3, threshold: 5 })).toThrow();
  });

  test('threshold < 2 → error', () => {
    expect(() => new LoopDetector({ threshold: 1 })).toThrow();
  });
});
