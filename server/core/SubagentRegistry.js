'use strict';

/**
 * SubagentRegistry — definiciones declarativas de subagentes tipados.
 *
 * Los 5 tipos están hardcoded e inmutables (Object.freeze). Agregar tipos
 * requiere edit + deploy. Esta rigidez es intencional — los tipos son un
 * contrato de seguridad (qué toolset puede usar cada tipo).
 *
 * Separado de SubagentResolver: este archivo NO conoce de agents.js ni
 * providers; solo declara tipos. El resolver hace la traducción a
 * configuración concreta.
 *
 * @typedef {Object} SubagentType
 * @property {string} description
 * @property {string|null} model                  — modelo específico o null (usa el del agente)
 * @property {string[]|null} allowedToolPatterns  — patrones glob; null = hereda del coordinador
 * @property {number} maxDelegationDepth           — 0 = no puede re-delegar
 */

const SUBAGENT_TYPES = Object.freeze({
  // Flags CacheSafeParams (Fase 7.5.7):
  //   skipTranscript  — el subagente no queda registrado en la history del padre (trabajo efímero)
  //   skipCacheWrite  — el subagente no contamina el cache del padre (fire-and-forget)
  // Ambos requieren que AgentOrchestrator comparta el prefix del padre cuando se active.
  // El infra está acá; la integración con orchestrator se aplica cuando se migre el delegate flow.
  explore: Object.freeze({
    description: 'Exploración read-only de código/archivos. Usa Haiku (rápido). Solo lectura.',
    model: 'claude-haiku-4-5',
    allowedToolPatterns: Object.freeze(['read_file', 'grep', 'glob', 'webfetch', 'list_dir']),
    maxDelegationDepth: 0,
    skipTranscript: true,     // Fase 7.5.7 — trabajo efímero
    skipCacheWrite: true,
    workspace: 'null',         // Fase 8.4 — lectura no necesita aislamiento
  }),
  plan: Object.freeze({
    description: 'Diseño de plan de implementación. Lee código pero NO escribe ni ejecuta.',
    model: 'claude-sonnet-4-6',
    allowedToolPatterns: Object.freeze(['read_file', 'grep', 'glob', 'list_dir']),
    maxDelegationDepth: 0,
    skipTranscript: true,
    skipCacheWrite: false,
    workspace: 'null',
  }),
  code: Object.freeze({
    description: 'Implementación de código. Toolset completo. Permitido delegar 1 nivel adicional para subtareas técnicas.',
    model: 'claude-opus-4-7',
    allowedToolPatterns: Object.freeze(['*']),
    maxDelegationDepth: 1,
    skipTranscript: false,    // el código del padre sí necesita ver los cambios
    skipCacheWrite: false,
    workspace: 'git-worktree', // aislamiento real para evitar contaminar el repo del coordinador
  }),
  researcher: Object.freeze({
    description: 'Investigación en web + memoria. Usa Sonnet. Puede fetchear URLs y guardar hallazgos.',
    model: 'claude-sonnet-4-6',
    allowedToolPatterns: Object.freeze(['webfetch', 'websearch', 'memory_*', 'read_file', 'glob', 'grep']),
    maxDelegationDepth: 0,
    skipTranscript: true,     // el padre recibe solo el resumen
    skipCacheWrite: false,    // el researcher puede cachear para próximas búsquedas similares
    workspace: 'null',
  }),
  general: Object.freeze({
    description: 'Subagente genérico — hereda modelo y toolset del coordinador.',
    model: null,
    allowedToolPatterns: null,
    maxDelegationDepth: 0,
    skipTranscript: false,
    skipCacheWrite: false,
    workspace: 'null',
  }),
});

/**
 * Retorna la definición de un tipo. Undefined si no existe.
 * @param {string} name
 * @returns {SubagentType | undefined}
 */
function getType(name) {
  if (!name) return undefined;
  return SUBAGENT_TYPES[String(name).toLowerCase()];
}

/**
 * Lista todos los tipos disponibles con metadata.
 * @returns {Array<{type: string, description: string, model: string|null, maxDelegationDepth: number}>}
 */
function listTypes() {
  return Object.entries(SUBAGENT_TYPES).map(([type, def]) => ({
    type,
    description: def.description,
    model: def.model,
    maxDelegationDepth: def.maxDelegationDepth,
  }));
}

module.exports = {
  SUBAGENT_TYPES,
  getType,
  listTypes,
};
