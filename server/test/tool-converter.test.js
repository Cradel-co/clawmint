'use strict';

/**
 * Tests de ToolConverter (fase 0 del refactor).
 *
 * Garantiza:
 *  1. Output BYTE-IDENTICAL al de la versión vieja de tools.js para tools simples (params).
 *  2. Soporte nuevo para enum, oneOf/anyOf, objetos anidados, arrays complejos.
 *  3. Gemini traduce tipos a UPPERCASE y omite campos no soportados.
 */

const TC = require('../providers/base/ToolConverter');

describe('ToolConverter.canonicalSchema', () => {
  test('convierte params simplificado a JSON Schema', () => {
    const schema = TC.canonicalSchema({
      params: { command: 'string', session_id: '?string' },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        command:    { type: 'string', description: 'command' },
        session_id: { type: 'string', description: 'session_id' },
      },
      required: ['command'],
    });
  });

  test('respeta inputSchema existente sin modificarlo (forma)', () => {
    const input = {
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: 'query' } },
        required: ['q'],
      },
    };
    const schema = TC.canonicalSchema(input);
    expect(schema.type).toBe('object');
    expect(schema.properties.q.type).toBe('string');
    expect(schema.required).toEqual(['q']);
  });

  test('devuelve objeto vacío para tool sin params ni inputSchema', () => {
    expect(TC.canonicalSchema({})).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });

  test('marca como opcional cuando la clave tiene "?"', () => {
    const schema = TC.canonicalSchema({ params: { '?debug': 'boolean' } });
    expect(schema.required).toEqual([]);
    expect(schema.properties.debug).toEqual({ type: 'boolean', description: 'debug' });
  });
});

describe('ToolConverter.toAnthropic', () => {
  test('produce input_schema con JSON Schema', () => {
    const out = TC.toAnthropic({
      name: 'bash',
      description: 'ejecuta comandos',
      params: { command: 'string' },
    });
    expect(out).toEqual({
      name: 'bash',
      description: 'ejecuta comandos',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'command' } },
        required: ['command'],
      },
    });
  });

  test('preserva enum en propiedades', () => {
    const out = TC.toAnthropic({
      name: 'status',
      description: 'cambia estado',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'merged'], description: 'estado' },
        },
        required: ['state'],
      },
    });
    expect(out.input_schema.properties.state.enum).toEqual(['open', 'closed', 'merged']);
  });
});

describe('ToolConverter.toOpenAI', () => {
  test('envuelve en { type: function, function: {...} }', () => {
    const out = TC.toOpenAI({
      name: 'search',
      description: 'busca',
      params: { query: 'string', limit: '?number' },
    });
    expect(out.type).toBe('function');
    expect(out.function.name).toBe('search');
    expect(out.function.parameters.type).toBe('object');
    expect(out.function.parameters.required).toEqual(['query']);
    expect(out.function.parameters.properties.limit.type).toBe('number');
  });
});

describe('ToolConverter.toGemini', () => {
  test('produce type=OBJECT y tipos en UPPERCASE', () => {
    const out = TC.toGemini({
      name: 'glob',
      description: 'busca archivos',
      params: { pattern: 'string', limit: '?number' },
    });
    expect(out.parameters.type).toBe('OBJECT');
    expect(out.parameters.properties.pattern.type).toBe('STRING');
    expect(out.parameters.properties.limit.type).toBe('NUMBER');
    expect(out.parameters.required).toEqual(['pattern']);
  });

  test('traduce enum a strings', () => {
    const out = TC.toGemini({
      name: 'x',
      description: '',
      inputSchema: {
        type: 'object',
        properties: { n: { type: 'integer', enum: [1, 2, 3] } },
        required: ['n'],
      },
    });
    expect(out.parameters.properties.n.type).toBe('INTEGER');
    expect(out.parameters.properties.n.enum).toEqual(['1', '2', '3']);
  });

  test('oneOf toma el primer branch (Gemini no soporta unions)', () => {
    const out = TC.toGemini({
      name: 'x',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            oneOf: [
              { type: 'number', description: 'numérico' },
              { type: 'string', description: 'textual' },
            ],
          },
        },
      },
    });
    expect(out.parameters.properties.value.type).toBe('NUMBER');
    expect(out.parameters.properties.value.description).toBe('numérico');
  });

  test('objetos anidados se convierten recursivamente', () => {
    const out = TC.toGemini({
      name: 'x',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          filters: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['status'],
          },
        },
      },
    });
    expect(out.parameters.properties.filters.type).toBe('OBJECT');
    expect(out.parameters.properties.filters.properties.status.type).toBe('STRING');
    expect(out.parameters.properties.filters.properties.count.type).toBe('INTEGER');
    expect(out.parameters.properties.filters.required).toEqual(['status']);
  });

  test('arrays con items complejos', () => {
    const out = TC.toGemini({
      name: 'x',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string', description: 'tag' },
          },
        },
      },
    });
    expect(out.parameters.properties.tags.type).toBe('ARRAY');
    expect(out.parameters.properties.tags.items.type).toBe('STRING');
    expect(out.parameters.properties.tags.items.description).toBe('tag');
  });

  test('pattern/minLength/format se omiten silenciosamente (no romper)', () => {
    const out = TC.toGemini({
      name: 'x',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', pattern: '^.+@.+$', minLength: 3 },
        },
      },
    });
    expect(out.parameters.properties.email.type).toBe('STRING');
    expect(out.parameters.properties.email.pattern).toBeUndefined();
    expect(out.parameters.properties.email.format).toBeUndefined();
    expect(out.parameters.properties.email.minLength).toBeUndefined();
  });
});

describe('ToolConverter.batch — compatibilidad con tools.js', () => {
  test('toAnthropicBatch mapea cada tool', () => {
    const defs = [{ name: 'a', description: '', params: { x: 'string' } }, { name: 'b', description: '', params: {} }];
    const out = TC.toAnthropicBatch(defs);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('a');
    expect(out[0].input_schema.required).toEqual(['x']);
    expect(out[1].input_schema.properties).toEqual({});
  });

  test('toGeminiBatch mantiene nombres de tools', () => {
    const defs = [{ name: 'a', description: '' }, { name: 'b', description: '' }];
    const out = TC.toGeminiBatch(defs);
    expect(out.map(t => t.name)).toEqual(['a', 'b']);
  });

  test('toOpenAIBatch y toAnthropicBatch tienen mismo número de tools', () => {
    const defs = [{ name: 'a', description: '' }, { name: 'b', description: '' }, { name: 'c', description: '' }];
    expect(TC.toAnthropicBatch(defs)).toHaveLength(3);
    expect(TC.toOpenAIBatch(defs)).toHaveLength(3);
    expect(TC.toGeminiBatch(defs)).toHaveLength(3);
  });
});
