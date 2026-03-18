'use strict';

/**
 * tools.js — adaptador delgado sobre mcp/index.js.
 * Mantiene la misma API pública (TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat)
 * para que los providers no requieran cambios de importación.
 */

const { executeTool: mcpExecute, getToolDefs } = require('./mcp');

// ── Formateadores de schema para cada provider ────────────────────────────────

function toAnthropicFormat() {
  return getToolDefs().map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: {
      type:       'object',
      properties: Object.fromEntries(
        Object.entries(t.params || {}).map(([k]) => [k.replace('?', ''), { type: 'string', description: k.replace('?', '') }])
      ),
      required: Object.entries(t.params || {})
        .filter(([, v]) => !String(v).startsWith('?'))
        .map(([k]) => k),
    },
  }));
}

function toGeminiFormat() {
  return getToolDefs().map(t => ({
    name:        t.name,
    description: t.description,
    parameters: {
      type:       'OBJECT',
      properties: Object.fromEntries(
        Object.entries(t.params || {}).map(([k]) => [k.replace('?', ''), { type: 'STRING', description: k.replace('?', '') }])
      ),
      required: Object.entries(t.params || {})
        .filter(([, v]) => !String(v).startsWith('?'))
        .map(([k]) => k.replace('?', '')),
    },
  }));
}

function toOpenAIFormat() {
  return getToolDefs().map(t => ({
    type: 'function',
    function: {
      name:        t.name,
      description: t.description,
      parameters: {
        type:       'object',
        properties: Object.fromEntries(
          Object.entries(t.params || {}).map(([k]) => [k.replace('?', ''), { type: 'string', description: k.replace('?', '') }])
        ),
        required: Object.entries(t.params || {})
          .filter(([, v]) => !String(v).startsWith('?'))
          .map(([k]) => k),
      },
    },
  }));
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

// TOOLS array para retrocompatibilidad (providers que lo usen directamente)
const TOOLS = getToolDefs();

module.exports = { TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat };
