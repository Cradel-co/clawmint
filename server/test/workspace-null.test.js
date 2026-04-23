'use strict';

const WorkspaceProvider = require('../core/workspace/WorkspaceProvider');
const NullWorkspace = require('../core/workspace/NullWorkspace');

describe('WorkspaceProvider (interface abstracta)', () => {
  test('acquire no implementado → throw', async () => {
    const p = new WorkspaceProvider();
    await expect(p.acquire({})).rejects.toThrow(/no implementado/);
  });

  test('type default es className', () => {
    const p = new WorkspaceProvider();
    expect(p.type).toBe('WorkspaceProvider');
  });
});

describe('NullWorkspace', () => {
  test('acquire devuelve cwd del server + release no-op', async () => {
    const w = new NullWorkspace();
    const handle = await w.acquire({});
    expect(handle.id).toBe('null');
    expect(handle.cwd).toBe(process.cwd());
    expect(typeof handle.release).toBe('function');
    await expect(handle.release()).resolves.toBeUndefined();
  });

  test('cwd override por constructor', async () => {
    const w = new NullWorkspace({ cwd: '/custom/path' });
    const h = await w.acquire({});
    expect(h.cwd).toBe('/custom/path');
  });

  test('type es "NullWorkspace"', () => {
    expect(new NullWorkspace().type).toBe('NullWorkspace');
  });

  test('release es idempotente (llamar 2 veces no throwea)', async () => {
    const handle = await new NullWorkspace().acquire({});
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
