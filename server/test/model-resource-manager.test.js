'use strict';

const ModelResourceManager = require('../core/ModelResourceManager');

// Crear instancia fresca para cada test (el módulo exporta singleton)
let mgr;
beforeEach(() => {
  mgr = new (ModelResourceManager.constructor || Object.getPrototypeOf(ModelResourceManager).constructor)();
});

describe('ModelResourceManager', () => {
  test('acquire establece current', async () => {
    await mgr.acquire('whisper', () => {});
    expect(mgr.current).toBe('whisper');
  });

  test('acquire mismo nombre no descarga', async () => {
    let unloaded = false;
    await mgr.acquire('whisper', () => { unloaded = true; });
    await mgr.acquire('whisper', () => {});
    expect(unloaded).toBe(false);
    expect(mgr.current).toBe('whisper');
  });

  test('acquire diferente descarga el anterior', async () => {
    let unloaded = false;
    await mgr.acquire('whisper', () => { unloaded = true; });
    await mgr.acquire('embeddings', () => {});
    expect(unloaded).toBe(true);
    expect(mgr.current).toBe('embeddings');
  });

  test('release libera el slot', async () => {
    await mgr.acquire('whisper', () => {});
    mgr.release('whisper');
    expect(mgr.current).toBe(null);
  });

  test('release con nombre incorrecto no hace nada', async () => {
    await mgr.acquire('whisper', () => {});
    mgr.release('embeddings');
    expect(mgr.current).toBe('whisper');
  });

  test('checkMemory retorna boolean', () => {
    expect(typeof mgr.checkMemory(1024)).toBe('boolean');
    expect(mgr.checkMemory(1024)).toBe(true); // 1KB siempre cabe
  });

  test('checkMemory falla con valor enorme', () => {
    expect(mgr.checkMemory(999 * 1024 * 1024 * 1024)).toBe(false); // 999 GB
  });

  test('memoryInfo retorna valores positivos', () => {
    const info = mgr.memoryInfo();
    expect(info.freeMB).toBeGreaterThan(0);
    expect(info.heapUsedMB).toBeGreaterThan(0);
    expect(info.heapAvailableMB).toBeGreaterThan(0);
  });

  test('concurrent acquires se serializan', async () => {
    const order = [];
    const p1 = mgr.acquire('a', async () => { order.push('unload-a'); });
    await p1;
    const p2 = mgr.acquire('b', async () => { order.push('unload-b'); });
    await p2;
    expect(order).toContain('unload-a');
    expect(mgr.current).toBe('b');
  });
});
