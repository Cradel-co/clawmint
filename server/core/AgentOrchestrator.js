'use strict';

const crypto = require('crypto');

const MAX_DELEGATIONS = 5;

/**
 * AgentOrchestrator — gestiona workflows multi-agente.
 *
 * Un agente coordinador (role='coordinator') puede delegar subtareas
 * a agentes especializados via MCP tools. Cada delegación crea una
 * llamada aislada a ConversationService.processMessage().
 *
 * Workflows son efímeros (Map en memoria, no DB).
 */
class AgentOrchestrator {
  constructor({ agents, eventBus, logger }) {
    this._agents   = agents;
    this._eventBus = eventBus || null;
    this._logger   = logger || console;
    /** @type {Map<string, object>} workflowId → WorkflowState */
    this._workflows = new Map();
  }

  /**
   * Crea un workflow para una sesión de coordinación.
   */
  createWorkflow(chatId, coordinatorAgent, channel, botKey) {
    const id = `wf_${crypto.randomUUID().slice(0, 8)}`;
    const workflow = {
      id,
      chatId,
      coordinator: coordinatorAgent,
      channel,
      botKey,
      tasks: new Map(),
      delegationCount: 0,
      status: 'active',
      createdAt: Date.now(),
    };
    this._workflows.set(id, workflow);
    this._emit('orchestration:start', { workflowId: id, coordinator: coordinatorAgent, chatId });
    this._logger.info(`[Orchestrator] Workflow ${id} creado (coordinator: ${coordinatorAgent}, chat: ${chatId})`);
    return id;
  }

  /**
   * Delega una tarea a un agente especializado. Espera resultado.
   */
  async delegateTask(workflowId, { targetAgent, task, context }, convSvc) {
    const workflow = this._workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} no encontrado`);
    if (workflow.delegationCount >= MAX_DELEGATIONS) {
      throw new Error(`Límite de delegaciones alcanzado (${MAX_DELEGATIONS}). Sintetizá con lo que tenés.`);
    }

    const agent = this._agents.get(targetAgent);
    if (!agent) throw new Error(`Agente "${targetAgent}" no encontrado. Usá list_agents para ver disponibles.`);

    const taskId = `t_${workflow.tasks.size + 1}`;
    const taskState = {
      id: taskId,
      workflowId,
      agent: targetAgent,
      description: task,
      status: 'running',
      result: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    workflow.tasks.set(taskId, taskState);
    workflow.delegationCount++;

    this._emit('orchestration:task', {
      workflowId, taskId, agent: targetAgent, description: task, status: 'running',
    });
    this._logger.info(`[Orchestrator] ${workflowId}/${taskId}: delegando a "${targetAgent}" — ${task.slice(0, 80)}`);

    const prompt = [
      `## Tarea asignada por el coordinador`,
      `Agente coordinador: ${workflow.coordinator}`,
      `Tarea: ${task}`,
      context ? `\nContexto adicional:\n${context}` : '',
      `\nRespondé con el resultado de la tarea. Sé conciso y directo.`,
    ].filter(Boolean).join('\n');

    try {
      const result = await convSvc.processMessage({
        chatId:     `orch-${workflowId}-${taskId}`,
        agentKey:   targetAgent,
        provider:   agent.provider || undefined,
        text:       prompt,
        history:    [],
        claudeMode: 'auto',
        botKey:     workflow.botKey,
        channel:    workflow.channel,
        // _isDelegated evita que el agente delegado reciba tools de orquestación
        _isDelegated: true,
      });

      taskState.status = 'done';
      taskState.result = result.text || '(sin respuesta)';
      taskState.completedAt = Date.now();

      this._emit('orchestration:task', {
        workflowId, taskId, agent: targetAgent, description: task, status: 'done',
      });
      this._logger.info(`[Orchestrator] ${workflowId}/${taskId}: completado (${taskState.result.length} chars)`);

      return { taskId, result: taskState.result };
    } catch (err) {
      taskState.status = 'failed';
      taskState.result = `Error: ${err.message}`;
      taskState.completedAt = Date.now();

      this._emit('orchestration:task', {
        workflowId, taskId, agent: targetAgent, description: task, status: 'failed',
      });
      this._logger.error(`[Orchestrator] ${workflowId}/${taskId}: falló — ${err.message}`);

      return { taskId, result: taskState.result };
    }
  }

  /**
   * Pregunta rápida a un agente (one-shot, sin tarea formal).
   */
  async askAgent(workflowId, { targetAgent, question, context }, convSvc) {
    const { result } = await this.delegateTask(workflowId, {
      targetAgent,
      task: question,
      context,
    }, convSvc);
    return result;
  }

  getWorkflow(workflowId) {
    return this._workflows.get(workflowId) || null;
  }

  /**
   * Marca un workflow como completado y emite evento.
   */
  completeWorkflow(workflowId) {
    const workflow = this._workflows.get(workflowId);
    if (!workflow || workflow.status !== 'active') return;
    workflow.status = 'completed';
    const duration = Date.now() - workflow.createdAt;
    this._emit('orchestration:done', {
      workflowId, taskCount: workflow.tasks.size, duration,
    });
    this._logger.info(`[Orchestrator] Workflow ${workflowId} completado (${workflow.tasks.size} tareas, ${duration}ms)`);
    // Cleanup después de 5 minutos
    setTimeout(() => this._workflows.delete(workflowId), 5 * 60 * 1000).unref();
  }

  _emit(event, data) {
    if (this._eventBus) {
      try { this._eventBus.emit(event, data); } catch { /* no bloquear */ }
    }
  }
}

module.exports = AgentOrchestrator;
