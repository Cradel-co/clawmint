'use strict';

/**
 * tools.js — adaptador delgado sobre mcp/index.js.
 * Mantiene la misma API pública (TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat)
 * para que los providers no requieran cambios de importación.
 *
 * Soporta dos formatos de tool definition:
 * - Internas: { name, description, params: { key: 'type' } }
 * - Externas MCP: { name, description, inputSchema: { type: 'object', properties, required } }
 */

const { executeTool: mcpExecute, getToolDefs } = require('./mcp');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Construye input_schema desde el formato simplificado params */
function _schemaFromParams(params) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(params || {}).map(([k]) => [k.replace('?', ''), { type: 'string', description: k.replace('?', '') }])
    ),
    required: Object.entries(params || {})
      .filter(([, v]) => !String(v).startsWith('?'))
      .map(([k]) => k),
  };
}

/** Convierte tipos JSON Schema estándar a formato Gemini (uppercase) */
function _toGeminiType(type) {
  const map = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
  return map[(type || 'string').toLowerCase()] || 'STRING';
}

/** Convierte una propiedad JSON Schema a formato Gemini (recursivo) */
function _propToGemini(v) {
  const out = { type: _toGeminiType(v.type) };
  if (v.description) out.description = v.description;

  // Arrays: convertir items
  if (v.type === 'array' && v.items) {
    out.items = _propToGemini(v.items);
  }

  // Objetos anidados: convertir properties
  if (v.type === 'object' && v.properties) {
    out.properties = {};
    for (const [pk, pv] of Object.entries(v.properties)) {
      out.properties[pk] = _propToGemini(pv);
    }
    if (v.required) out.required = v.required;
  }

  return out;
}

/** Convierte inputSchema completo a formato Gemini */
function _inputSchemaToGemini(schema) {
  const props = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    props[k] = _propToGemini(v);
  }
  return { type: 'OBJECT', properties: props, required: schema.required || [] };
}

// ── Formateadores de schema para cada provider ────────────────────────────────

function toAnthropicFormat(opts) {
  return getToolDefs(opts).map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema || _schemaFromParams(t.params),
  }));
}

function toGeminiFormat(opts) {
  return getToolDefs(opts).map(t => {
    const parameters = t.inputSchema
      ? _inputSchemaToGemini(t.inputSchema)
      : {
          type: 'OBJECT',
          properties: Object.fromEntries(
            Object.entries(t.params || {}).map(([k]) => [k.replace('?', ''), { type: 'STRING', description: k.replace('?', '') }])
          ),
          required: Object.entries(t.params || {})
            .filter(([, v]) => !String(v).startsWith('?'))
            .map(([k]) => k.replace('?', '')),
        };
    return { name: t.name, description: t.description, parameters };
  });
}

function toOpenAIFormat(opts) {
  return getToolDefs(opts).map(t => ({
    type: 'function',
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.inputSchema || _schemaFromParams(t.params),
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

// TOOLS array para retrocompatibilidad (providers que lo usen directamente).
// Nota: se resuelve en load-time sin channel, así que excluye tools con channel (ej. critter).
// No se usa actualmente — los providers llaman toXxxFormat({ channel }) directamente.
const TOOLS = getToolDefs();

module.exports = { TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat };
