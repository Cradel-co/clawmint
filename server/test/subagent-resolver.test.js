'use strict';

const SubagentResolver = require('../core/SubagentResolver');

function mockAgents(agents) {
  const map = new Map(agents.map(a => [a.key, a]));
  return {
    get: (key) => map.get(key),
    list: () => Array.from(map.values()),
  };
}

describe('SubagentResolver', () => {
  test('construir sin agents → error', () => {
    expect(() => new SubagentResolver({})).toThrow(/agents/);
  });

  test('explore → config con Haiku y tools read-only', () => {
    const agents = mockAgents([{ key: 'claude', provider: 'anthropic' }]);
    const r = new SubagentResolver({ agents });
    const cfg = r.resolve('explore');
    expect(cfg.type).toBe('explore');
    expect(cfg.model).toBe('claude-haiku-4-5');
    expect(cfg.agentKey).toBe('claude');
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.allowedToolPatterns).not.toContain('write_file');
    expect(cfg.maxDelegationDepth).toBe(0);
  });

  test('code → Opus + wildcard + depth 1', () => {
    const agents = mockAgents([{ key: 'claude', provider: 'anthropic' }]);
    const r = new SubagentResolver({ agents });
    const cfg = r.resolve('code');
    expect(cfg.model).toBe('claude-opus-4-7');
    expect(cfg.allowedToolPatterns).toEqual(['*']);
    expect(cfg.maxDelegationDepth).toBe(1);
  });

  test('general hereda del coordinador', () => {
    const agents = mockAgents([
      { key: 'claude', provider: 'anthropic' },
      { key: 'coord',  provider: 'anthropic', role: 'coordinator' },
    ]);
    const r = new SubagentResolver({ agents });
    const cfg = r.resolve('general', { coordinatorAgentKey: 'coord' });
    expect(cfg.agentKey).toBe('coord');
    expect(cfg.allowedToolPatterns).toBeNull();
    expect(cfg.model).toBeNull();
  });

  test('agentKey override explícito en ctx', () => {
    const agents = mockAgents([
      { key: 'claude', provider: 'anthropic' },
      { key: 'custom', provider: 'gemini' },
    ]);
    const r = new SubagentResolver({ agents });
    const cfg = r.resolve('researcher', { agentKey: 'custom' });
    expect(cfg.agentKey).toBe('custom');
    expect(cfg.provider).toBe('gemini');
    // Model del tipo tiene prioridad sobre el del agente
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });

  test('tipo desconocido → error descriptivo', () => {
    const agents = mockAgents([{ key: 'claude' }]);
    const r = new SubagentResolver({ agents });
    expect(() => r.resolve('hacker')).toThrow(/desconocido/);
    expect(() => r.resolve('hacker')).toThrow(/explore, plan, code, researcher, general/);
  });

  test('case-insensitive en typeName', () => {
    const agents = mockAgents([{ key: 'claude', provider: 'anthropic' }]);
    const r = new SubagentResolver({ agents });
    expect(r.resolve('EXPLORE').type).toBe('explore');
    expect(r.resolve('Code').type).toBe('code');
  });

  test('agente default usado si no se pasa nada', () => {
    const agents = mockAgents([{ key: 'myDefault', provider: 'anthropic' }]);
    const r = new SubagentResolver({ agents, defaultAgentKey: 'myDefault' });
    const cfg = r.resolve('plan');
    expect(cfg.agentKey).toBe('myDefault');
  });

  test('Fase 7.5.7 — skipTranscript y skipCacheWrite propagados', () => {
    const agents = mockAgents([{ key: 'claude', provider: 'anthropic' }]);
    const r = new SubagentResolver({ agents });
    const explore = r.resolve('explore');
    expect(explore.skipTranscript).toBe(true);
    expect(explore.skipCacheWrite).toBe(true);

    const code = r.resolve('code');
    expect(code.skipTranscript).toBe(false);
    expect(code.skipCacheWrite).toBe(false);

    const researcher = r.resolve('researcher');
    expect(researcher.skipTranscript).toBe(true);
    expect(researcher.skipCacheWrite).toBe(false);

    const general = r.resolve('general', { coordinatorAgentKey: 'claude' });
    expect(general.skipTranscript).toBe(false);
    expect(general.skipCacheWrite).toBe(false);
  });

  test('allowedToolPatterns es una COPIA, no referencia al frozen original', () => {
    const agents = mockAgents([{ key: 'claude' }]);
    const r = new SubagentResolver({ agents });
    const cfg = r.resolve('explore');
    // Debe ser mutable (consumers pueden necesitar push de tools siempre visibles)
    expect(() => cfg.allowedToolPatterns.push('extra')).not.toThrow();
    // Sin afectar el registry global
    const cfg2 = r.resolve('explore');
    expect(cfg2.allowedToolPatterns).not.toContain('extra');
  });

  // Fase 8.4 — workspace resolution
  describe('workspace resolution (Fase 8.4)', () => {
    test('code resuelve a git-worktree si está registrado', () => {
      const agents = mockAgents([{ key: 'claude', provider: 'anthropic' }]);
      const gitWs = { acquire: async () => ({ id: 'w1', cwd: '/tmp/a', release: async () => {}, meta: {} }) };
      const r = new SubagentResolver({
        agents,
        workspaceRegistry: { 'null': {}, 'git-worktree': gitWs },
      });
      const cfg = r.resolve('code');
      expect(cfg.workspaceKey).toBe('git-worktree');
      expect(cfg.workspaceProvider).toBe(gitWs);
    });

    test('code cae a null si git-worktree no está habilitado', () => {
      const agents = mockAgents([{ key: 'claude' }]);
      const nullWs = { acquire: async () => ({ id: 'n', cwd: '/tmp', release: async () => {}, meta: {} }) };
      const r = new SubagentResolver({
        agents,
        workspaceRegistry: { 'null': nullWs, 'git-worktree': null },
      });
      const cfg = r.resolve('code');
      expect(cfg.workspaceKey).toBe('null');
      expect(cfg.workspaceProvider).toBe(nullWs);
    });

    test('explore/plan/researcher/general usan null workspace', () => {
      const agents = mockAgents([{ key: 'claude' }]);
      const nullWs = { acquire: async () => ({ id: 'n', cwd: '/tmp', release: async () => {} }) };
      const r = new SubagentResolver({
        agents,
        workspaceRegistry: { 'null': nullWs, 'git-worktree': {} },
      });
      for (const t of ['explore', 'plan', 'researcher', 'general']) {
        const cfg = r.resolve(t, { coordinatorAgentKey: 'claude' });
        expect(cfg.workspaceKey).toBe('null');
        expect(cfg.workspaceProvider).toBe(nullWs);
      }
    });

    test('resolveWithWorkspace acquire y retorna handle', async () => {
      const agents = mockAgents([{ key: 'claude' }]);
      const handle = { id: 'w-abc', cwd: '/tmp/ws', release: async () => {}, meta: {} };
      const ws = { acquire: jest.fn().mockResolvedValue(handle) };
      const r = new SubagentResolver({
        agents,
        workspaceRegistry: { 'null': ws, 'git-worktree': ws },
      });
      const { config, workspace } = await r.resolveWithWorkspace('code', { agentKey: 'claude' });
      expect(workspace).toBe(handle);
      expect(ws.acquire).toHaveBeenCalled();
      expect(config.type).toBe('code');
    });

    test('resolveWithWorkspace sin provider retorna workspace=null', async () => {
      const agents = mockAgents([{ key: 'claude' }]);
      const r = new SubagentResolver({ agents, workspaceRegistry: {} });
      const { config, workspace } = await r.resolveWithWorkspace('explore');
      expect(workspace).toBeNull();
      expect(config.workspaceProvider).toBeNull();
    });
  });
});
