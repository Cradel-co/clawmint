'use strict';

/**
 * D6 — Verifica que las read-only tools se ejecuten en paralelo (Promise.all),
 * mientras que las con side effects mantienen orden secuencial.
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

describe('D6 — tool execution parallel vs sequential', () => {
  test('2 read_file en paralelo: duración ≈ max(t1,t2), no t1+t2', async () => {
    setup([
      {
        content: [
          { type: 'tool_use', id: 'a', name: 'read_file', input: { path: '/x' } },
          { type: 'tool_use', id: 'b', name: 'read_file', input: { path: '/y' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 5 },
      },
    ]);

    const executeTool = jest.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'contenido';
    });

    const t0 = Date.now();
    const gen = provider.chat({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
      executeTool,
    });
    for await (const _ of gen) {} // consumir
    const elapsed = Date.now() - t0;

    expect(executeTool).toHaveBeenCalledTimes(2);
    // Paralelo: ~100ms (más overhead); secuencial serían ~200ms.
    // Margin generoso para CI: < 180ms para confirmar paralelo.
    expect(elapsed).toBeLessThan(180);
  });

  test('mixed batch (read_file + write_file) cae a secuencial', async () => {
    setup([
      {
        content: [
          { type: 'tool_use', id: 'a', name: 'read_file', input: { path: '/x' } },
          { type: 'tool_use', id: 'b', name: 'write_file', input: { path: '/y', content: 'z' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 5 },
      },
    ]);

    const order = [];
    const executeTool = jest.fn().mockImplementation(async (name) => {
      order.push(`start:${name}`);
      await new Promise(r => setTimeout(r, 50));
      order.push(`end:${name}`);
      return 'ok';
    });

    const gen = provider.chat({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
      executeTool,
    });
    for await (const _ of gen) {}

    // Secuencial: end:read_file debe venir ANTES de start:write_file
    const endReadIdx = order.indexOf('end:read_file');
    const startWriteIdx = order.indexOf('start:write_file');
    expect(endReadIdx).toBeLessThan(startWriteIdx);
  });

  test('1 tool sola: funciona igual (no paralelismo necesario)', async () => {
    setup([
      {
        content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: '/x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 5 },
      },
    ]);
    const executeTool = jest.fn().mockResolvedValue('ok');
    const gen = provider.chat({
      systemPrompt: 's',
      history: [{ role: 'user', content: 'hola' }],
      apiKey: 'sk',
      model: 'claude-opus-4-6',
      executeTool,
    });
    const events = [];
    for await (const ev of gen) events.push(ev);
    expect(events.find(e => e.type === 'tool_result')).toBeDefined();
  });
});
