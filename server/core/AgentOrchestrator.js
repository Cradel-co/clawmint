'use strict';

const crypto = require('crypto');

const MAX_DELEGATIONS     = 5;   // tope de delegaciones por workflow
const MAX_DELEGATION_DEPTH = 3;  // tope de profundidad recursiva (delegado → delegado → ...)

/**
 * AgentOrchestrator — gestiona workflows multi-agente.
 *
 * Un agente coordinador (role='coordinator') puede delegar subtareas
 * a agentes especializados via MCP tools. Cada delegación crea una
 * llamada aislada a ConversationService.processMessage().
 *
 * Workflows son efímeros (Map en memoria, no DB).
 *
 * Bug fix (Fase 5): propaga `_delegationDepth` en ctx al delegado para
 * que `ConversationService.processMessage` pueda bloquear re-delegaciones
 * que escapen el tope. Antes, un delegado con role=coordinator podía crear
 * un workflow nuevo (delegationCount=0) y delegar recursivamente.
 */
class AgentOrchestrator {
  constructor({ agents, eventBus, logger, subagentResolver = null, hookRegistry = null }) {
    this._agents           = agents;
    this._eventBus         = eventBus || null;
    this._logger           = logger || console;
    this._subagentResolver = subagentResolver;
    this._hookRegistry     = hookRegistry;
    /** @type {Map<string, object>} workflowId → WorkflowState */
    this._workflows = new Map();
  }

  /**
   * Crea un workflow para una sesión de coordinación.
   */
  createWorkflow(chatId, coordinatorAgent, channel, botKey, extras = {}) {
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
      // Fase 7.5.7 — prefix sharing: cache system prompt + tools del coordinator
      // para reusar en delegaciones del mismo tipo (cache hit en Anthropic).
      coordinatorSystemPrompt: extras.systemPrompt || null,
      coordinatorProvider: extras.provider || null,
      coordinatorModel: extras.model || null,
    };
    this._workflows.set(id, workflow);
    this._emit('orchestration:start', { workflowId: id, coordinator: coordinatorAgent, chatId });
    this._logger.info(`[Orchestrator] Workflow ${id} creado (coordinator: ${coordinatorAgent}, chat: ${chatId})`);
    return id;
  }

  /**
   * Actualiza el prefix cache del workflow. Llamado por ConversationService
   * tras armar el system prompt por primera vez.
   */
  captureCoordinatorPrefix(workflowId, { systemPrompt, provider, model } = {}) {
    const wf = this._workflows.get(workflowId);
    if (!wf) return false;
    if (systemPrompt && !wf.coordinatorSystemPrompt) wf.coordinatorSystemPrompt = systemPrompt;
    if (provider && !wf.coordinatorProvider) wf.coordinatorProvider = provider;
    if (model && !wf.coordinatorModel) wf.coordinatorModel = model;
    return true;
  }

  /**
   * Retorna el workflowId activo para un chatId, o null. Fase 7.5.7.
   */
  getActiveWorkflowId(chatId) {
    if (!chatId) return null;
    for (const [id, wf] of this._workflows) {
      if (wf.chatId === chatId && wf.status === 'active') return id;
    }
    return null;
  }

  /** Lista todos los workflows con shape serializable. Fase E.5. */
  listWorkflows() {
    const out = [];
    for (const [id, wf] of this._workflows) {
      out.push({
        id,
        chatId: wf.chatId,
        coordinator: wf.coordinator,
        channel: wf.channel,
        status: wf.status,
        delegationCount: wf.delegationCount,
        createdAt: wf.createdAt,
        tasks: Array.from(wf.tasks.values()).map(t => ({
          id: t.id, agent: t.agent, subagentType: t.subagentType,
          description: t.description, status: t.status,
          startedAt: t.startedAt, completedAt: t.completedAt,
          resultPreview: t.result ? String(t.result).slice(0, 200) : null,
        })),
      });
    }
    return out;
  }

  /** Cancela un workflow y marca todas sus tasks como cancelled. Fase E.5. */
  cancelWorkflow(workflowId) {
    const wf = this._workflows.get(workflowId);
    if (!wf) return false;
    wf.status = 'cancelled';
    for (const t of wf.tasks.values()) {
      if (t.status === 'running' || t.status === 'pending') {
        t.status = 'cancelled';
        t.completedAt = Date.now();
      }
    }
    this._emit('orchestration:cancelled', { workflowId });
    return true;
  }

  /**
   * Delega una tarea a un agente o subagente tipado. Espera resultado.
   *
   * @param {string} workflowId
   * @param {object} opts
   * @param {string} [opts.targetAgent]           — agentKey concreto (alternativa 1)
   * @param {string} [opts.subagentType]          — tipo de subagente (alternativa 2; requiere subagentResolver)
   * @param {string} opts.task
   * @param {string} [opts.context]
   * @param {number} [opts.parentDelegationDepth] — profundidad del caller (se incrementa al delegar)
   * @param {object} convSvc
   */
  async delegateTask(workflowId, opts, convSvc) {
    const { targetAgent, subagentType, task, context, parentDelegationDepth = 0 } = opts || {};
    const workflow = this._workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} no encontrado`);
    if (workflow.delegationCount >= MAX_DELEGATIONS) {
      throw new Error(`Límite de delegaciones alcanzado (${MAX_DELEGATIONS}). Sintetizá con lo que tenés.`);
    }

    // Profundidad de la delegación resultante
    const nextDepth = Number(parentDelegationDepth || 0) + 1;
    if (nextDepth > MAX_DELEGATION_DEPTH) {
      throw new Error(`Profundidad máxima de delegación alcanzada (${MAX_DELEGATION_DEPTH}). Un subagente delegado no puede re-delegar más allá de este límite.`);
    }

    // Resolver subagentType → agentKey (si aplica)
    let resolvedAgentKey = targetAgent;
    let subagentConfig = null;
    if (subagentType) {
      if (!this._subagentResolver) {
        throw new Error('subagent_type especificado pero SubagentResolver no está inyectado en Orchestrator');
      }
      subagentConfig = this._subagentResolver.resolve(subagentType, {
        coordinatorAgentKey: workflow.coordinator,
        agentKey: targetAgent || undefined,
      });
      resolvedAgentKey = subagentConfig.agentKey;
      // Si el tipo impone un maxDelegationDepth más bajo, el delegado no podrá re-delegar
      if (subagentConfig.maxDelegationDepth === 0 && nextDepth > 1) {
        throw new Error(`El subagente de tipo "${subagentType}" no puede ser invocado en profundidad ${nextDepth} (maxDelegationDepth=0).`);
      }
    }

    if (!resolvedAgentKey) throw new Error('targetAgent o subagentType requerido');

    const agent = this._agents.get(resolvedAgentKey);
    if (!agent) throw new Error(`Agente "${resolvedAgentKey}" no encontrado. Usá list_agents para ver disponibles.`);

    const taskId = `t_${workflow.tasks.size + 1}`;
    const taskState = {
      id: taskId,
      workflowId,
      agent: resolvedAgentKey,
      subagentType: subagentType || null,
      description: task,
      status: 'running',
      result: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    workflow.tasks.set(taskId, taskState);
    workflow.delegationCount++;

    this._emit('orchestration:task', {
      workflowId, taskId, agent: resolvedAgentKey, subagentType: subagentType || null,
      description: task, status: 'running',
    });
    this._emitHook('subagent_start', {
      workflowId, taskId, agent: resolvedAgentKey, subagentType: subagentType || null,
      description: task, depth: nextDepth,
    }, { chatId: workflow.chatId, agentKey: resolvedAgentKey, channel: workflow.channel });
    this._logger.info(`[Orchestrator] ${workflowId}/${taskId}: delegando a "${resolvedAgentKey}"${subagentType ? ` (type=${subagentType})` : ''} [depth=${nextDepth}] — ${task.slice(0, 80)}`);

    const prompt = [
      `## Tarea asignada por el coordinador`,
      `Agente coordinador: ${workflow.coordinator}`,
      subagentType ? `Tipo de subagente: ${subagentType}` : '',
      `Tarea: ${task}`,
      context ? `\nContexto adicional:\n${context}` : '',
      `\nRespondé con el resultado de la tarea. Sé conciso y directo.`,
    ].filter(Boolean).join('\n');

    // Fase 8.4 — adquirir workspace si el subagente lo requiere. Release en finally.
    let workspaceHandle = null;
    if (subagentConfig && subagentConfig.workspaceProvider && typeof subagentConfig.workspaceProvider.acquire === 'function') {
      try {
        workspaceHandle = await subagentConfig.workspaceProvider.acquire({
          agentKey: resolvedAgentKey,
          agentId: taskId,
          baseBranch: workflow.baseBranch || null,
        });
        this._logger.info(`[Orchestrator] ${workflowId}/${taskId}: workspace acquired (${subagentConfig.workspaceKey}, id=${workspaceHandle.id}, cwd=${workspaceHandle.cwd})`);
      } catch (err) {
        this._logger.warn(`[Orchestrator] ${workflowId}/${taskId}: workspace acquire falló (${err.message}) — continuando sin aislamiento`);
      }
    }

    // Fase 7.5.7 — prefix sharing: si el subagente comparte cache con el padre
    // (skipCacheWrite=false) y el workflow tiene el prefix del coordinador cacheado,
    // lo propagamos para que el provider (Anthropic) haga cache hit.
    const shareCachePrefix = subagentConfig && subagentConfig.skipCacheWrite === false
      && workflow.coordinatorSystemPrompt
      && (!subagentConfig.provider || subagentConfig.provider === workflow.coordinatorProvider);
    const parentPrefix = shareCachePrefix ? {
      systemPrompt: workflow.coordinatorSystemPrompt,
      provider: workflow.coordinatorProvider,
      model: workflow.coordinatorModel,
    } : null;

    try {
      const result = await convSvc.processMessage({
        chatId:     `orch-${workflowId}-${taskId}`,
        agentKey:   resolvedAgentKey,
        provider:   (subagentConfig && subagentConfig.provider) || agent.provider || undefined,
        model:      (subagentConfig && subagentConfig.model) || undefined,
        text:       prompt,
        history:    [],
        claudeMode: 'auto',
        botKey:     workflow.botKey,
        channel:    workflow.channel,
        // _isDelegated evita que el agente delegado reciba tools de orquestación
        _isDelegated: true,
        _delegationDepth: nextDepth,
        _subagentConfig: subagentConfig, // allowedToolPatterns para filtrar tools
        _workspace: workspaceHandle ? { id: workspaceHandle.id, cwd: workspaceHandle.cwd, meta: workspaceHandle.meta } : null,
        // Fase 7.5.7 — prefix cache share (opcional)
        _parentPrefix: parentPrefix,
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
    } finally {
      // Fase 8.4 — liberar workspace (idempotente)
      if (workspaceHandle && typeof workspaceHandle.release === 'function') {
        try { await workspaceHandle.release(); } catch (err) {
          this._logger.warn(`[Orchestrator] ${workflowId}/${taskId}: workspace release falló — ${err.message}`);
        }
      }
      this._emitHook('subagent_stop', {
        workflowId, taskId, agent: resolvedAgentKey, subagentType: subagentType || null,
        status: taskState.status, durationMs: (taskState.completedAt || Date.now()) - taskState.startedAt,
        resultPreview: taskState.result ? String(taskState.result).slice(0, 200) : null,
      }, { chatId: workflow.chatId, agentKey: resolvedAgentKey, channel: workflow.channel });
    }
  }

  /**
   * Pregunta rápida a un agente (one-shot, sin tarea formal).
   */
  async askAgent(workflowId, { targetAgent, question, context, parentDelegationDepth = 0 }, convSvc) {
    const { result } = await this.delegateTask(workflowId, {
      targetAgent,
      task: question,
      context,
      parentDelegationDepth,
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

  _emitHook(event, payload, ctx) {
    if (!this._hookRegistry || !this._hookRegistry.enabled) return;
    // Fire-and-forget: los hooks de ciclo subagente son observacionales (no bloquean)
    Promise.resolve()
      .then(() => this._hookRegistry.emit(event, payload, ctx))
      .catch((err) => {
        this._logger.warn && this._logger.warn(`[Orchestrator] hook ${event} falló: ${err.message}`);
      });
  }
}

module.exports = AgentOrchestrator;
