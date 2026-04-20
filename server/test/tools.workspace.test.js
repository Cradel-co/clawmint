'use strict';

const [WORKSPACE_STATUS] = require('../mcp/tools/workspace');

function adminCtx(extra = {}) {
  return {
    userId: 'admin-test',
    usersRepo: {
      findByIdentity: () => ({ id: 'admin-test', role: 'admin' }),
      getById: () => ({ id: 'admin-test', role: 'admin' }),
    },
    ...extra,
  };
}

function userCtx(extra = {}) {
  return {
    userId: 'user-test',
    usersRepo: {
      findByIdentity: () => ({ id: 'user-test', role: 'user' }),
      getById: () => ({ id: 'user-test', role: 'user' }),
    },
    ...extra,
  };
}

describe('workspace_status tool (Fase 8.4 parked → cerrado)', () => {
  test('rechaza no-admin', async () => {
    const r = await WORKSPACE_STATUS.execute({}, userCtx({ workspaceRegistry: {} }));
    expect(r).toContain('administradores');
  });

  test('sin workspaceRegistry en ctx → error', async () => {
    const r = await WORKSPACE_STATUS.execute({}, adminCtx());
    expect(r).toContain('workspaceRegistry');
  });

  test('lista providers con y sin entradas', async () => {
    const reg = {
      'null': { list: () => [] },
      'git-worktree': { list: () => [
        { id: 'a1', path: '/tmp/a', branch: 'sub/a', createdAt: Date.now(), lastAccessAt: Date.now() },
      ] },
      'docker': null, // no habilitado
    };
    const r = await WORKSPACE_STATUS.execute({}, adminCtx({ workspaceRegistry: reg }));
    expect(r).toContain('null: sin workspaces');
    expect(r).toContain('git-worktree: 1 workspace');
    expect(r).toContain('a1');
    expect(r).toContain('sub/a');
    expect(r).toContain('docker: no habilitado');
  });

  test('docker provider con entradas usa containerName/containerId', async () => {
    const reg = {
      'docker': { list: () => [
        { id: 'd1', containerId: 'abcdef1234567890', containerName: 'clawmint-ws-d1', hostPath: '/tmp/d', createdAt: Date.now(), lastAccessAt: Date.now() },
      ] },
    };
    const r = await WORKSPACE_STATUS.execute({}, adminCtx({ workspaceRegistry: reg }));
    expect(r).toContain('docker: 1 workspace');
    expect(r).toContain('container=abcdef123456');
  });

  test('provider sin list() método retorna mensaje genérico', async () => {
    const reg = { 'custom': {} };
    const r = await WORKSPACE_STATUS.execute({}, adminCtx({ workspaceRegistry: reg }));
    expect(r).toContain('custom: provider activo');
  });
});
