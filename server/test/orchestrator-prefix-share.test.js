'use strict';

const AgentOrchestrator = require('../core/AgentOrchestrator');

function mkAgents(map) {
  const m = new Map(Object.entries(map));
  return { get: (k) => m.get(k), list: () => Array.from(m.values()) };
}

describe('AgentOrchestrator prefix sharing (parked 7.5.7 → cerrado)', () => {
  test('createWorkflow acepta prefix extras', () => {
    const orch = new AgentOrchestrator({ agents: mkAgents({ claude: { key: 'claude' } }) });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot', {
      systemPrompt: 'SYS-COORD', provider: 'anthropic', model: 'claude-opus-4-7',
    });
    const wf = orch._workflows.get(wfId);
    expect(wf.coordinatorSystemPrompt).toBe('SYS-COORD');
    expect(wf.coordinatorProvider).toBe('anthropic');
    expect(wf.coordinatorModel).toBe('claude-opus-4-7');
  });

  test('captureCoordinatorPrefix actualiza solo valores vacíos', () => {
    const orch = new AgentOrchestrator({ agents: mkAgents({ claude: { key: 'claude' } }) });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot');
    expect(orch.captureCoordinatorPrefix(wfId, {
      systemPrompt: 'S1', provider: 'anthropic', model: 'm1',
    })).toBe(true);
    // Segunda captura no sobrescribe
    orch.captureCoordinatorPrefix(wfId, {
      systemPrompt: 'S2', provider: 'openai', model: 'm2',
    });
    const wf = orch._workflows.get(wfId);
    expect(wf.coordinatorSystemPrompt).toBe('S1');
    expect(wf.coordinatorProvider).toBe('anthropic');
  });

  test('captureCoordinatorPrefix retorna false si workflow no existe', () => {
    const orch = new AgentOrchestrator({ agents: mkAgents({}) });
    expect(orch.captureCoordinatorPrefix('nope', { systemPrompt: 'x' })).toBe(false);
  });

  test('getActiveWorkflowId encuentra workflow por chatId', () => {
    const orch = new AgentOrchestrator({ agents: mkAgents({ claude: { key: 'claude' } }) });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot');
    expect(orch.getActiveWorkflowId('c1')).toBe(wfId);
    expect(orch.getActiveWorkflowId('c2')).toBeNull();
    expect(orch.getActiveWorkflowId(null)).toBeNull();
  });

  test('delegateTask propaga _parentPrefix cuando subagente comparte cache', async () => {
    const calls = [];
    const convSvc = {
      processMessage: async (opts) => {
        calls.push(opts);
        return { text: 'ok' };
      },
    };
    const subagentResolver = {
      resolve: () => ({
        type: 'code', agentKey: 'claude', provider: 'anthropic', model: null,
        allowedToolPatterns: ['*'], maxDelegationDepth: 1,
        skipTranscript: false, skipCacheWrite: false,    // share → debe propagar prefix
        workspaceProvider: null, workspaceKey: 'null',
      }),
    };
    const orch = new AgentOrchestrator({
      agents: mkAgents({ claude: { key: 'claude', provider: 'anthropic' } }),
      subagentResolver,
    });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot', {
      systemPrompt: 'COORDINATOR-SYS', provider: 'anthropic', model: 'opus',
    });
    await orch.delegateTask(wfId, { subagentType: 'code', task: 'haz X' }, convSvc);
    expect(calls).toHaveLength(1);
    expect(calls[0]._parentPrefix).toEqual({
      systemPrompt: 'COORDINATOR-SYS',
      provider: 'anthropic',
      model: 'opus',
    });
  });

  test('delegateTask NO propaga _parentPrefix si subagente skipCacheWrite=true', async () => {
    const calls = [];
    const convSvc = { processMessage: async (opts) => { calls.push(opts); return { text: 'ok' }; } };
    const subagentResolver = {
      resolve: () => ({
        type: 'explore', agentKey: 'claude', provider: null, model: null,
        allowedToolPatterns: ['read_file'], maxDelegationDepth: 0,
        skipTranscript: true, skipCacheWrite: true,   // no share → prefix null
        workspaceProvider: null, workspaceKey: 'null',
      }),
    };
    const orch = new AgentOrchestrator({
      agents: mkAgents({ claude: { key: 'claude' } }),
      subagentResolver,
    });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot', {
      systemPrompt: 'COORD', provider: 'anthropic',
    });
    await orch.delegateTask(wfId, { subagentType: 'explore', task: 'busca X' }, convSvc);
    expect(calls[0]._parentPrefix).toBeNull();
  });

  test('delegateTask NO propaga prefix si provider del subagente difiere del coordinador', async () => {
    const calls = [];
    const convSvc = { processMessage: async (opts) => { calls.push(opts); return { text: 'ok' }; } };
    const subagentResolver = {
      resolve: () => ({
        type: 'researcher', agentKey: 'openai-agent', provider: 'openai', model: null,
        allowedToolPatterns: ['webfetch'], maxDelegationDepth: 0,
        skipTranscript: true, skipCacheWrite: false,
        workspaceProvider: null, workspaceKey: 'null',
      }),
    };
    const orch = new AgentOrchestrator({
      agents: mkAgents({
        claude: { key: 'claude', provider: 'anthropic' },
        'openai-agent': { key: 'openai-agent', provider: 'openai' },
      }),
      subagentResolver,
    });
    const wfId = orch.createWorkflow('c1', 'claude', 'web', 'bot', {
      systemPrompt: 'ANTH-SYS', provider: 'anthropic',
    });
    await orch.delegateTask(wfId, { subagentType: 'researcher', task: 'web' }, convSvc);
    expect(calls[0]._parentPrefix).toBeNull();
  });
});
