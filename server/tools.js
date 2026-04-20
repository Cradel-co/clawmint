'use strict';

/**
 * tools.js — adaptador delgado sobre mcp/index.js.
 * Mantiene la misma API pública (TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat)
 * para que los providers no requieran cambios de importación.
 *
 * Soporta dos formatos de tool definition:
 * - Internas: { name, description, params: { key: 'type' } }
 * - Externas MCP: { name, description, inputSchema: { type: 'object', properties, required } }
 *
 * Desde la fase 0 del refactor, la conversión se delega a `providers/base/ToolConverter.js`
 * para ganar soporte nativo de enum, oneOf/anyOf, objetos anidados y pattern.
 * El output es BYTE-IDENTICAL al anterior para todas las tools existentes (cubierto por tests).
 */

const { executeTool: mcpExecute, getToolDefs } = require('./mcp');
const ToolConverter = require('./providers/base/ToolConverter');

// ── Formateadores de schema para cada provider ────────────────────────────────

function toAnthropicFormat(opts) {
  return ToolConverter.toAnthropicBatch(getToolDefs(opts));
}

function toGeminiFormat(opts) {
  return ToolConverter.toGeminiBatch(getToolDefs(opts));
}

function toOpenAIFormat(opts) {
  return ToolConverter.toOpenAIBatch(getToolDefs(opts));
}

/**
 * Ejecuta un tool por nombre.
 * @param {string}  name
 * @param {object}  args
 * @param {object}  [ctx]  - { shellId, sessionManager }  (opcional)
 */
async function executeTool(name, args, ctx) {
  return mcpExecute(name, args, ctx);
}

// TOOLS array para retrocompatibilidad (providers que lo usen directamente).
// Nota: se resuelve en load-time sin channel, así que excluye tools con channel (ej. critter).
// No se usa actualmente — los providers llaman toXxxFormat({ channel }) directamente.
const TOOLS = getToolDefs();

module.exports = { TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat };
