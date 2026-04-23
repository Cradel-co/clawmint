'use strict';

const ContextCompactor = require('../core/compact/ContextCompactor');

describe('ContextCompactor (interface abstracta)', () => {
  test('shouldCompact sin implementar → throw', () => {
    const c = new ContextCompactor();
    expect(() => c.shouldCompact({})).toThrow(/no implementado/);
  });

  test('compact sin implementar → rechaza', async () => {
    const c = new ContextCompactor();
    await expect(c.compact([], {})).rejects.toThrow(/no implementado/);
  });

  test('subclase que implementa ambos → funciona', async () => {
    class MyCompactor extends ContextCompactor {
      shouldCompact() { return true; }
      async compact(history) { return [...history, { compacted: true }]; }
    }
    const c = new MyCompactor();
    expect(c.shouldCompact({})).toBe(true);
    const r = await c.compact([{ a: 1 }], {});
    expect(r).toEqual([{ a: 1 }, { compacted: true }]);
  });

  test('name refleja className por default', () => {
    class FooCompactor extends ContextCompactor {
      shouldCompact() { return false; }
      async compact(h) { return h; }
    }
    expect(new FooCompactor().name).toBe('FooCompactor');
  });
});
