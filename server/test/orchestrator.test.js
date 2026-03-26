'use strict';

const AgentOrchestrator = require('../core/AgentOrchestrator');
const EventBus = require('../core/EventBus');

// Mock de agents
const mockAgents = {
  get: (key) => ({ claude: { key: 'claude', description: 'Claude', role: undefined }, coder: { key: 'coder', description: 'Coder', prompt: 'Sos un coder' }, reviewer: { key: 'reviewer', description: 'Reviewer' } })[key] || null,
  list: () => [
    { key: 'claude', description: 'Claude' },
    { key: 'coder', description: 'Coder', prompt: 'Sos un coder' },
    { key: 'reviewer', description: 'Reviewer' },
  ],
};

// Mock de ConversationService
function mockConvSvc(responseText = 'resultado de la tarea') {
  return {
    processMessage: jest.fn().mockResolvedValue({ text: responseText, usedMcpTools: false, savedMemoryFiles: [] }),
  };
}

describe('AgentOrchestrator', () => {
  let orchestrator, eventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    orchestrator = new AgentOrchestrator({
      agents: mockAgents,
      eventBus,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });

  test('createWorkflow retorna workflowId', () => {
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');
    expect(wfId).toMatch(/^wf_/);
    const wf = orchestrator.getWorkflow(wfId);
    expect(wf).not.toBeNull();
    expect(wf.coordinator).toBe('coordinator');
    expect(wf.chatId).toBe('chat1');
    expect(wf.status).toBe('active');
  });

  test('delegateTask ejecuta processMessage y retorna resultado', async () => {
    const convSvc = mockConvSvc('función creada');
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');

    const { taskId, result } = await orchestrator.delegateTask(wfId, {
      targetAgent: 'coder',
      task: 'Crear función sort',
    }, convSvc);

    expect(taskId).toBe('t_1');
    expect(result).toBe('función creada');
    expect(convSvc.processMessage).toHaveBeenCalledTimes(1);

    const call = convSvc.processMessage.mock.calls[0][0];
    expect(call.agentKey).toBe('coder');
    expect(call.chatId).toMatch(/^orch-/);
    expect(call.claudeMode).toBe('auto');
    expect(call._isDelegated).toBe(true);
  });

  test('delegateTask respeta límite de 5 delegaciones', async () => {
    const convSvc = mockConvSvc('ok');
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');

    for (let i = 0; i < 5; i++) {
      await orchestrator.delegateTask(wfId, { targetAgent: 'coder', task: `tarea ${i}` }, convSvc);
    }

    await expect(
      orchestrator.delegateTask(wfId, { targetAgent: 'coder', task: 'tarea 6' }, convSvc)
    ).rejects.toThrow(/Límite/);
  });

  test('delegateTask falla si agente no existe', async () => {
    const convSvc = mockConvSvc();
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');

    await expect(
      orchestrator.delegateTask(wfId, { targetAgent: 'inexistente', task: 'algo' }, convSvc)
    ).rejects.toThrow(/no encontrado/);
  });

  test('delegateTask maneja error de processMessage gracefully', async () => {
    const convSvc = { processMessage: jest.fn().mockRejectedValue(new Error('provider caído')) };
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');

    const { result } = await orchestrator.delegateTask(wfId, {
      targetAgent: 'coder', task: 'algo',
    }, convSvc);

    expect(result).toContain('Error: provider caído');
    const wf = orchestrator.getWorkflow(wfId);
    const task = wf.tasks.get('t_1');
    expect(task.status).toBe('failed');
  });

  test('emite eventos via EventBus', async () => {
    const events = [];
    eventBus.on('orchestration:start', (d) => events.push({ type: 'start', ...d }));
    eventBus.on('orchestration:task', (d) => events.push({ type: 'task', ...d }));
    eventBus.on('orchestration:done', (d) => events.push({ type: 'done', ...d }));

    const convSvc = mockConvSvc('hecho');
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');
    await orchestrator.delegateTask(wfId, { targetAgent: 'coder', task: 'algo' }, convSvc);
    orchestrator.completeWorkflow(wfId);

    expect(events.length).toBe(4); // start + task running + task done + workflow done
    expect(events[0].type).toBe('start');
    expect(events[1].status).toBe('running');
    expect(events[2].status).toBe('done');
    expect(events[3].type).toBe('done');
  });

  test('completeWorkflow cambia status', () => {
    const wfId = orchestrator.createWorkflow('chat1', 'coordinator', 'telegram', 'bot1');
    orchestrator.completeWorkflow(wfId);
    expect(orchestrator.getWorkflow(wfId).status).toBe('completed');
  });

  test('getWorkflow retorna null para ID inexistente', () => {
    expect(orchestrator.getWorkflow('wf_inexistente')).toBeNull();
  });
});
