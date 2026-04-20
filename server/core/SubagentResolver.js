'use strict';

/**
 * SubagentResolver — resuelve un tipo de subagente a configuración concreta.
 *
 * Traduce `typeName` → `{ agentKey, provider, model, allowedToolPatterns, maxDelegationDepth }`.
 * Necesita `agents` y opcionalmente `providers` inyectados.
 *
 * Separación vs SubagentRegistry:
 *  - Registry: declara QUÉ tipos existen y sus restricciones.
 *  - Resolver: traduce a una config concreta que el orchestrator puede invocar.
 *
 * NO conoce de permisos — eso vive en PermissionService y es consultado por
 * ConversationService al momento de ejecutar tools.
 */

const { getType } = require('./SubagentRegistry');

class SubagentResolver {
  /**
   * @param {object} deps
   * @param {object} deps.agents                     — módulo agents (ver `agents.js`)
   * @param {object} [deps.providers]                — opcional, para validar provider
   * @param {string} [deps.defaultAgentKey='claude'] — fallback cuando el tipo requiere un agente pero no lo especifica
   */
  constructor({ agents, providers = null, workspaceRegistry = null, defaultAgentKey = 'claude' } = {}) {
    if (!agents || typeof agents.get !== 'function') {
      throw new Error('SubagentResolver: agents con .get() requerido');
    }
    this._agents = agents;
    this._providers = providers;
    this._workspaceRegistry = workspaceRegistry || {};
    this._defaultAgentKey = defaultAgentKey;
  }

  /**
   * Resuelve un tipo a configuración ejecutable.
   * @param {string} typeName
   * @param {object} [ctx]                         — contexto del caller (coordinator, chatId, etc.)
   * @param {string} [ctx.coordinatorAgentKey]     — para tipo 'general' que hereda
   * @param {string} [ctx.agentKey]                — override: usar este agentKey específico (si existe)
   * @returns {{ type: string, agentKey: string, provider: string|null, model: string|null, allowedToolPatterns: string[]|null, maxDelegationDepth: number }}
   */
  resolve(typeName, ctx = {}) {
    const def = getType(typeName);
    if (!def) {
      throw new Error(`Tipo de subagente desconocido: "${typeName}". Tipos válidos: explore, plan, code, researcher, general.`);
    }

    // Resolver agentKey: explícito en ctx > coordinator (para general) > default
    const agentKey = ctx.agentKey
      || (typeName === 'general' ? ctx.coordinatorAgentKey : null)
      || this._defaultAgentKey;

    const agentDef = this._agents.get(agentKey) || null;

    // Model: override de def > agentDef > null (usa default del provider)
    const model = def.model || (agentDef && agentDef.model) || null;

    // Provider: del agentDef (los tipos no dictan provider)
    const provider = (agentDef && agentDef.provider) || null;

    // allowedToolPatterns: del tipo, excepto 'general' que hereda (null = sin restricción)
    const allowedToolPatterns = def.allowedToolPatterns
      ? Array.from(def.allowedToolPatterns)
      : null;

    // Fase 8.4 — resolver workspace provider por nombre.
    // Fallback: si el tipo pide 'git-worktree' pero no está habilitado (WORKTREES_ENABLED=false),
    // caemos a 'null' silenciosamente.
    const requestedWsKey = def.workspace || 'null';
    let wsKey = requestedWsKey;
    let workspaceProvider = this._workspaceRegistry[wsKey] || null;
    if (!workspaceProvider && wsKey !== 'null') {
      workspaceProvider = this._workspaceRegistry['null'] || null;
      if (workspaceProvider) wsKey = 'null';
    }

    return {
      type: String(typeName).toLowerCase(),
      agentKey,
      provider,
      model,
      allowedToolPatterns,
      maxDelegationDepth: def.maxDelegationDepth,
      // Fase 7.5.7 — CacheSafeParams propagadas al delegate
      skipTranscript: !!def.skipTranscript,
      skipCacheWrite: !!def.skipCacheWrite,
      // Fase 8.4 — workspace provider resuelto. El caller (AgentOrchestrator) llama
      // `await workspaceProvider.acquire(ctx)` antes de ejecutar al delegado.
      workspaceProvider,
      workspaceKey: workspaceProvider ? wsKey : 'null',
    };
  }

  /**
   * Convenience: resuelve config + adquiere workspace en un paso.
   * Retorna `{ config, workspace: { id, cwd, release, meta } }`.
   * El caller debe llamar `await workspace.release()` al terminar.
   */
  async resolveWithWorkspace(typeName, ctx = {}) {
    const config = this.resolve(typeName, ctx);
    if (!config.workspaceProvider) {
      return { config, workspace: null };
    }
    const workspace = await config.workspaceProvider.acquire(ctx);
    return { config, workspace };
  }
}

module.exports = SubagentResolver;
