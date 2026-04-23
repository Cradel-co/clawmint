'use strict';

/**
 * D2 — Verifica que el provider emita `turnMessages` con los blocks completos
 * (incluyendo thinking, tool_use, tool_result, text) para que ConversationService
 * los pueda persistir en `ai_history` y re-enviar en turns futuros con thinking.
 */

let mockResponses = [];  // eslint-disable-line prefer-const
let mockCallIdx = 0;

jest.mock('@anthropic-ai/sdk', () => {
  return class AnthropicMock {
    constructor() {
      this.messages = {
        stream: () => {
          const final = mockResponses[mockCallIdx++];
          const asyncIter = (async function* () {})();
          asyncIter.finalMessage = async () => final;
          return asyncIter;
        },
      };
    }
  };
});

const provider = require('../providers/anthropic');

function setup(resps) { mockResponses = resps; mockCallIdx = 0; }

describe('D2 — turnMessages preserva content blocks', () => {
  test('turn sin tools → turnMessages contiene assistant final con content array', async () => {
    setup([
      {
        content: [
          { type: 'thinking', thinking: 'razonando...' },
          { type: 'text', text: 'hola humano' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const events = [];
    const gen = provider.chat({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
    });
    for await (const ev of gen) events.push(ev);

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(Array.isArray(done.turnMessages)).toBe(true);
    expect(done.turnMessages.length).toBe(1);
    expect(done.turnMessages[0].role).toBe('assistant');
    expect(Array.isArray(done.turnMessages[0].content)).toBe(true);
    // Preserva thinking + text
    const types = done.turnMessages[0].content.map(b => b.type);
    expect(types).toContain('thinking');
    expect(types).toContain('text');
  });

  test('turn con tool_use → turnMessages incluye assistant (con tool_use) + user (tool_result) + assistant final', async () => {
    setup([
      {
        content: [
          { type: 'thinking', thinking: 'necesito leer' },
          { type: 'tool_use', id: 'tu_x', name: 'files_read', input: { path: '/a' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [
          { type: 'text', text: 'archivo leído: contenido' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 8 },
      },
    ]);
    const events = [];
    const executeTool = jest.fn().mockResolvedValue('contenido');
    const gen = provider.chat({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'qué hay en /a' }],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
      executeTool,
    });
    for await (const ev of gen) events.push(ev);

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    const tm = done.turnMessages;
    expect(Array.isArray(tm)).toBe(true);
    // Esperamos: [assistant(thinking+tool_use), user(tool_result), assistant(text)]
    expect(tm.length).toBe(3);
    expect(tm[0].role).toBe('assistant');
    expect(tm[0].content.some(b => b.type === 'thinking')).toBe(true);
    expect(tm[0].content.some(b => b.type === 'tool_use')).toBe(true);
    expect(tm[1].role).toBe('user');
    expect(tm[1].content[0].type).toBe('tool_result');
    expect(tm[1].content[0].tool_use_id).toBe('tu_x');
    expect(tm[2].role).toBe('assistant');
    expect(tm[2].content.some(b => b.type === 'text')).toBe(true);
  });

  test('turnMessages NO incluye los mensajes del history original', async () => {
    setup([
      {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ]);
    const events = [];
    const gen = provider.chat({
      systemPrompt: 's',
      history: [
        { role: 'user', content: 'msg viejo' },
        { role: 'assistant', content: 'respuesta vieja' },
        { role: 'user', content: 'msg nuevo' },
      ],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
    });
    for await (const ev of gen) events.push(ev);

    const done = events.find(e => e.type === 'done');
    expect(done.turnMessages.length).toBe(1);
    expect(done.turnMessages[0].role).toBe('assistant');
  });
});
