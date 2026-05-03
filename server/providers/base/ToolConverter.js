'use strict';

/**
 * ToolConverter — traduce tool definitions canónicas al formato específico de cada provider.
 *
 * Reemplaza las funciones ad-hoc de `tools.js` con un pipeline explícito:
 *   tool definition (interna o JSON Schema) → canonicalSchema() → toAnthropic/toOpenAI/toGemini
 *
 * Soporta:
 *  - Formato interno simplificado: { name, description, params: { key: 'type', '?opt': 'type' } }
 *  - Formato JSON Schema Draft-07: { name, description, inputSchema: { type, properties, required, ... } }
 *
 * Features extra sobre la versión antigua de tools.js:
 *  - enum en propiedades
 *  - oneOf / anyOf
 *  - objetos anidados con required
 *  - arrays con items complejos
 *  - pattern, minLength, maxLength, minimum, maximum, format
 *
 * Retrocompatibilidad: para tools que usan solo `params: { key: 'type' }`, el output es BYTE-IDENTICAL
 * al del `tools.js` anterior (tests de regresión existentes siguen pasando sin cambio).
 */

// ── Utilidades ───────────────────────────────────────────────────────────────

const JS_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

function _stripOpt(k) {
  return typeof k === 'string' ? k.replace('?', '') : k;
}

function _isOptional(k, v) {
  if (typeof k === 'string' && k.startsWith('?')) return true;
  if (typeof v === 'string' && v.startsWith('?')) return true;
  return false;
}

/** Genera un JSON Schema canonical desde el formato simplificado `params`. */
function _schemaFromParams(params = {}) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(params)) {
    const cleanKey = _stripOpt(k);
    // v puede ser string ("string", "number", "?string") o un schema object
    if (v && typeof v === 'object') {
      properties[cleanKey] = v;
    } else {
      const cleanType = String(v || 'string').replace('?', '').toLowerCase();
      const type = JS_TYPES.includes(cleanType) ? cleanType : 'string';
      properties[cleanKey] = { type, description: cleanKey };
    }
    if (!_isOptional(k, v)) required.push(cleanKey);
  }
  return { type: 'object', properties, required };
}

/**
 * Devuelve un JSON Schema Draft-07 canonical para una tool definition.
 * Acepta formato interno (params) o externo (inputSchema).
 */
function canonicalSchema(tool) {
  if (!tool) return { type: 'object', properties: {}, required: [] };
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    // Ya está en JSON Schema — normalizar defaults faltantes
    return {
      type: tool.inputSchema.type || 'object',
      properties: tool.inputSchema.properties || {},
      required: tool.inputSchema.required || [],
      ...('additionalProperties' in tool.inputSchema ? { additionalProperties: tool.inputSchema.additionalProperties } : {}),
    };
  }
  return _schemaFromParams(tool.params);
}

// ── Conversores por provider ─────────────────────────────────────────────────

/** Anthropic: usa JSON Schema Draft-07 directo en `input_schema`. */
function toAnthropic(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: canonicalSchema(tool),
  };
}

/** OpenAI: tipo `function` con `parameters` en JSON Schema Draft-07. */
function toOpenAI(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: canonicalSchema(tool),
    },
  };
}

/**
 * Gemini: tipos en UPPERCASE, sin soporte para pattern/format/oneOf.
 * Los features no soportados se traducen o se omiten (con warning opcional).
 */
function _geminiType(t) {
  const map = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
  return map[String(t || 'string').toLowerCase()] || 'STRING';
}

function _propToGemini(v) {
  if (!v || typeof v !== 'object') return { type: 'STRING' };

  // oneOf/anyOf: Gemini no soporta unions. Tomar el primer branch para preservar al menos un tipo válido.
  if (Array.isArray(v.oneOf) && v.oneOf.length) return _propToGemini(v.oneOf[0]);
  if (Array.isArray(v.anyOf) && v.anyOf.length) return _propToGemini(v.anyOf[0]);

  const out = { type: _geminiType(v.type) };
  if (v.description) out.description = v.description;

  // enum: Gemini sí lo soporta (como array de strings)
  if (Array.isArray(v.enum)) {
    out.enum = v.enum.map(x => (typeof x === 'string' ? x : String(x)));
  }

  // Arrays
  if ((v.type || '').toLowerCase() === 'array' && v.items) {
    out.items = _propToGemini(v.items);
  }

  // Objetos anidados
  if ((v.type || '').toLowerCase() === 'object' && v.properties) {
    out.properties = {};
    for (const [pk, pv] of Object.entries(v.properties)) {
      out.properties[pk] = _propToGemini(pv);
    }
    if (Array.isArray(v.required)) out.required = v.required;
  }

  // Campos NO soportados por Gemini: pattern, format, minLength, maxLength, minimum, maximum
  // (se omiten silenciosamente — no romper)

  return out;
}

function toGemini(tool) {
  const schema = canonicalSchema(tool);
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    properties[k] = _propToGemini(v);
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT',
      properties,
      required: schema.required || [],
    },
  };
}

// ── API pública batch (compat con tools.js) ──────────────────────────────────

/**
 * Retorna array de tool definitions en formato Anthropic.
 * @param {Array} toolDefs — array de tools crudos (formato interno o inputSchema)
 */
function toAnthropicBatch(toolDefs) {
  return (toolDefs || []).map(toAnthropic);
}

function toOpenAIBatch(toolDefs) {
  return (toolDefs || []).map(toOpenAI);
}

function toGeminiBatch(toolDefs) {
  return (toolDefs || []).map(toGemini);
}

module.exports = {
  canonicalSchema,
  toAnthropic,
  toOpenAI,
  toGemini,
  toAnthropicBatch,
  toOpenAIBatch,
  toGeminiBatch,
};
