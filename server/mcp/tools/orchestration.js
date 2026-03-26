'use strict';

/**
 * mcp/tools/orchestration.js — Tools MCP para orquestación multi-agente.
 *
 * Solo visibles para agentes con role='coordinator' (coordinatorOnly: true).
 * Usa ctx.orchestrator y ctx.convSvc para delegar tareas.
 */

function _requireOrchestrator(ctx) {
  if (!ctx.orchestrator) throw new Error('Orquestador no disponible');
}

const DELEGATE_TASK = {
  name: 'delegate_task',
  coordinatorOnly: true,
  description: 'Delegar una tarea a otro agente especializado. Espera a que termine y retorna el resultado. Máximo 5 delegaciones por conversación.',
  params: {
    agent:   'string — key del agente destino (usá list_agents para ver disponibles)',
    task:    'string — descripción clara de la tarea a realizar',
    context: '?string — contexto adicional o datos relevantes para la tarea',
  },

  async execute(args = {}, ctx = {}) {
    _requireOrchestrator(ctx);
    if (!args.agent) return 'Error: parámetro agent requerido';
    if (!args.task) return 'Error: parámetro task requerido';

    // Auto-crear workflow si no existe
    if (!ctx.workflowId && ctx.orchestrator.createWorkflow) {
      ctx.workflowId = ctx.orchestrator.createWorkflow(
        ctx.chatId, ctx.agentKey, ctx.channel, ctx.botKey
      );
    }

    if (!ctx.workflowId) return 'Error: no se pudo crear workflow de orquestación';

    try {
      const { taskId, result } = await ctx.orchestrator.delegateTask(
        ctx.workflowId,
        { targetAgent: args.agent, task: args.task, context: args.context },
        ctx._convSvc
      );
      return `[Resultado de ${args.agent} (${taskId})]\n\n${result}`;
    } catch (err) {
      return `Error delegando a "${args.agent}": ${err.message}`;
    }
  },
};

const ASK_AGENT = {
  name: 'ask_agent',
  coordinatorOnly: true,
  description: 'Hacer una pregunta rápida a otro agente. Similar a delegate_task pero para consultas simples.',
  params: {
    agent:    'string — key del agente a consultar',
    question: 'string — pregunta o consulta',
    context:  '?string — contexto adicional',
  },

  async execute(args = {}, ctx = {}) {
    _requireOrchestrator(ctx);
    if (!args.agent) return 'Error: parámetro agent requerido';
    if (!args.question) return 'Error: parámetro question requerido';

    if (!ctx.workflowId && ctx.orchestrator.createWorkflow) {
      ctx.workflowId = ctx.orchestrator.createWorkflow(
        ctx.chatId, ctx.agentKey, ctx.channel, ctx.botKey
      );
    }

    try {
      const result = await ctx.orchestrator.askAgent(
        ctx.workflowId,
        { targetAgent: args.agent, question: args.question, context: args.context },
        ctx._convSvc
      );
      return `[Respuesta de ${args.agent}]\n\n${result}`;
    } catch (err) {
      return `Error consultando a "${args.agent}": ${err.message}`;
    }
  },
};

const LIST_AGENTS = {
  name: 'list_agents',
  coordinatorOnly: true,
  description: 'Lista todos los agentes disponibles para delegación, con sus descripciones y capacidades.',
  params: {},

  execute(args = {}, ctx = {}) {
    if (!ctx.agents) return 'Error: módulo de agentes no disponible';

    const list = (typeof ctx.agents.list === 'function' ? ctx.agents.list() : [])
      .filter(a => a.key !== ctx.agentKey); // excluir al coordinador mismo

    if (!list.length) return 'No hay agentes disponibles para delegación.';

    const lines = list.map(a => {
      const role = a.role ? ` [${a.role}]` : '';
      const provider = a.provider ? ` (${a.provider})` : '';
      const hasPrompt = a.prompt ? ' — tiene prompt personalizado' : '';
      return `• ${a.key}${role}${provider}: ${a.description || 'sin descripción'}${hasPrompt}`;
    });

    return `Agentes disponibles (${list.length}):\n\n${lines.join('\n')}`;
  },
};

module.exports = [DELEGATE_TASK, ASK_AGENT, LIST_AGENTS];
