'use strict';

/**
 * D1 — Verifica que tool errors se marquen con is_error:true en el tool_result
 * que se envía de vuelta al API.
 */

// Mock del SDK de Anthropic: simula stream + finalMessage con una secuencia de responses.
let mockResponses = [];  // eslint-disable-line prefer-const
let mockCallIdx = 0;
let mockLastRequest = null;

jest.mock('@anthropic-ai/sdk', () => {
  return class AnthropicMock {
    constructor() {
      this.messages = {
        stream: (req) => {
          // Snapshot profundo: el provider muta `messages` por referencia tras el await,
          // así que capturamos el estado al momento de la llamada.
          mockLastRequest = { ...req, messages: JSON.parse(JSON.stringify(req.messages)) };
          const final = mockResponses[mockCallIdx++];
          const asyncIter = (async function* () { /* no deltas */ })();
          asyncIter.finalMessage = async () => final;
          return asyncIter;
        },
      };
    }
  };
});

const provider = require('../providers/anthropic');

function setupResponses(resps) {
  mockResponses = resps;
  mockCallIdx = 0;
}

function lastMessagesSent() { return mockLastRequest && mockLastRequest.messages; }

describe('D1 — is_error en tool_result', () => {
  test('tool que throw → is_error true en el tool_result enviado al API', async () => {
    setupResponses([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'listo' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    ]);

    const executeTool = jest.fn().mockRejectedValue(new Error('comando inválido'));
    const events = [];
    const gen = provider.chat({
      systemPrompt: 'test',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5-20251001',
      executeTool,
    });
    for await (const ev of gen) events.push(ev);

    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent.isError).toBe(true);
    expect(String(toolResultEvent.result)).toMatch(/Error ejecutando bash/);

    // Verificar que el mensaje enviado al API en el SEGUNDO turn tiene is_error:true
    const sent = lastMessagesSent();
    const userTurn = sent[sent.length - 1];
    expect(userTurn.role).toBe('user');
    expect(Array.isArray(userTurn.content)).toBe(true);
    const tr = userTurn.content[0];
    expect(tr.type).toBe('tool_result');
    expect(tr.is_error).toBe(true);
    expect(tr.tool_use_id).toBe('tu_1');
  });

  test('tool que retorna "Error: ..." sin throw → is_error true', async () => {
    setupResponses([
      {
        content: [{ type: 'tool_use', id: 'tu_2', name: 'files_read', input: { path: '/x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'listo' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    ]);

    const executeTool = jest.fn().mockResolvedValue('Error: archivo no encontrado');
    const events = [];
    const gen = provider.chat({
      systemPrompt: 'test',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5-20251001',
      executeTool,
    });
    for await (const ev of gen) events.push(ev);

    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent.isError).toBe(true);

    const sent = lastMessagesSent();
    const userTurn = sent[sent.length - 1];
    expect(userTurn.content[0].is_error).toBe(true);
  });

  test('tool exitoso → is_error ausente (no se setea)', async () => {
    setupResponses([
      {
        content: [{ type: 'tool_use', id: 'tu_3', name: 'files_read', input: { path: '/x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'listo' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    ]);

    const executeTool = jest.fn().mockResolvedValue('contenido del archivo');
    const events = [];
    const gen = provider.chat({
      systemPrompt: 'test',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5-20251001',
      executeTool,
    });
    for await (const ev of gen) events.push(ev);

    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent.isError).toBe(false);

    const sent = lastMessagesSent();
    const userTurn = sent[sent.length - 1];
    expect(userTurn.content[0].is_error).toBeUndefined();
  });
});
