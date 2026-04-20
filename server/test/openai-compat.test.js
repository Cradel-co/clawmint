'use strict';

/**
 * Tests del helper compartido `openaiCompatChat` (fase 2 del refactor).
 * Cubre el 95% de la lógica de openai.js, deepseek.js, grok.js.
 */

const { openaiCompatChat } = require('../providers/base/openaiCompatChat');

async function collect(asyncGen) {
  const out = [];
  for await (const ev of asyncGen) out.push(ev);
  return out;
}

/**
 * Mock de OpenAI SDK — retorna chunks en orden predefinido.
 * `chunkList` es array de chunks a emitir.
 * `onRequest(req)` se llama con el request para inspección.
 */
function mockOpenAI(chunkList, onRequest) {
  return class MockOpenAI {
    constructor(cfg) { this._cfg = cfg; }
    get chat() {
      return {
        completions: {
          create: async (req, opts) => {
            if (onRequest) onRequest(req, opts);
            return {
              async *[Symbol.asyncIterator]() {
                for (const c of chunkList) yield c;
              },
            };
          },
        },
      };
    }
  };
}

function textChunk(text) {
  return { choices: [{ delta: { content: text }, finish_reason: null }] };
}
function stopChunk(usage) {
  return { choices: [{ delta: {}, finish_reason: 'stop' }], usage };
}
function toolChunk(fragments) {
  return { choices: [{ delta: { tool_calls: fragments }, finish_reason: null }] };
}
function toolStopChunk() {
  return { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
}

describe('openaiCompatChat — streaming', () => {
  test('sin apiKey → done con error, no crea cliente', async () => {
    const OpenAI = jest.fn();
    const events = await collect(openaiCompatChat({
      OpenAI, clientConfig: { apiKey: '' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
    }));
    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toMatch(/API key/);
    expect(OpenAI).not.toHaveBeenCalled();
  });

  test('emite text por cada chunk de content', async () => {
    const chunks = [
      textChunk('Hola'),
      textChunk(', '),
      textChunk('mundo'),
      stopChunk({ prompt_tokens: 10, completion_tokens: 3 }),
    ];
    const MockOpenAI = mockOpenAI(chunks);
    const events = await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
    }));

    const texts = events.filter(e => e.type === 'text');
    expect(texts.map(t => t.text)).toEqual(['Hola', ', ', 'mundo']);
    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toBe('Hola, mundo');
  });

  test('usage se extrae del último chunk (stream_options include_usage)', async () => {
    const chunks = [textChunk('ok'), stopChunk({ prompt_tokens: 50, completion_tokens: 20 })];
    const MockOpenAI = mockOpenAI(chunks);
    const events = await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
    }));
    const usage = events.find(e => e.type === 'usage');
    expect(usage.promptTokens).toBe(50);
    expect(usage.completionTokens).toBe(20);
  });

  test('tool_call: acumula arguments fragmentados por index', async () => {
    // Turno 1: el modelo pide bash con args fragmentados
    const turn1Chunks = [
      toolChunk([{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"com' } }]),
      toolChunk([{ index: 0, function: { arguments: 'mand":' } }]),
      toolChunk([{ index: 0, function: { arguments: ' "ls"}' } }]),
      toolStopChunk(),
    ];
    // Turno 2: responde con texto final
    const turn2Chunks = [textChunk('listo'), stopChunk({ prompt_tokens: 10, completion_tokens: 5 })];

    let call = 0;
    class MockOpenAI {
      constructor() {}
      get chat() {
        return {
          completions: {
            create: async () => {
              call++;
              const chunks = call === 1 ? turn1Chunks : turn2Chunks;
              return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
            },
          },
        };
      }
    }

    const execTool = jest.fn().mockResolvedValue('file1\nfile2');
    const events = await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
      executeTool: execTool,
    }));

    expect(execTool).toHaveBeenCalledWith('bash', { command: 'ls' });
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall.name).toBe('bash');
    expect(toolCall.args).toEqual({ command: 'ls' });
  });

  test('JSON args inválidos emiten tool_result con mensaje de error (no silenciar)', async () => {
    const turn1Chunks = [
      toolChunk([{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command": broken' } }]),
      toolStopChunk(),
    ];
    const turn2Chunks = [textChunk('got it'), stopChunk({ prompt_tokens: 10, completion_tokens: 3 })];

    let call = 0;
    class MockOpenAI {
      constructor() {}
      get chat() {
        return {
          completions: {
            create: async () => {
              call++;
              const chunks = call === 1 ? turn1Chunks : turn2Chunks;
              return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
            },
          },
        };
      }
    }

    const execTool = jest.fn();
    const events = await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
      executeTool: execTool,
    }));

    // executeTool NO se llamó porque los args son inválidos
    expect(execTool).not.toHaveBeenCalled();
    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolResult.result).toMatch(/no son JSON válido/);
    expect(toolResult.result).toMatch(/broken/);
  });

  test('AbortSignal previo → done "Cancelado" sin llamar al SDK', async () => {
    const MockOpenAI = mockOpenAI([]);
    const ac = new AbortController();
    ac.abort();
    const events = await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
      signal: ac.signal,
    }));
    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/Cancelado/);
  });

  test('signal se pasa al SDK como option', async () => {
    let capturedOpts;
    class MockOpenAI {
      constructor() {}
      get chat() {
        return {
          completions: {
            create: async (_req, opts) => {
              capturedOpts = opts;
              return { async *[Symbol.asyncIterator]() { yield stopChunk({ prompt_tokens: 1, completion_tokens: 1 }); } };
            },
          },
        };
      }
    }

    const ac = new AbortController();
    await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
      signal: ac.signal,
    }));
    expect(capturedOpts).toEqual({ signal: ac.signal });
  });

  test('request include stream: true y stream_options con include_usage', async () => {
    let capturedReq;
    const MockOpenAI = mockOpenAI(
      [stopChunk({ prompt_tokens: 1, completion_tokens: 1 })],
      (req) => { capturedReq = req; },
    );
    await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
    }));
    expect(capturedReq.stream).toBe(true);
    expect(capturedReq.stream_options).toEqual({ include_usage: true });
  });

  test('error del SDK se traduce a done con mensaje explícito', async () => {
    class BrokenMockOpenAI {
      constructor() {}
      get chat() {
        return {
          completions: {
            create: async () => { throw new Error('quota exceeded'); },
          },
        };
      }
    }

    const events = await collect(openaiCompatChat({
      OpenAI: BrokenMockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm', history: [],
    }));
    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/Error Test: quota exceeded/);
  });

  test('systemPrompt se inyecta como primer mensaje role=system', async () => {
    let capturedReq;
    const MockOpenAI = mockOpenAI(
      [stopChunk({ prompt_tokens: 1, completion_tokens: 1 })],
      (req) => { capturedReq = req; },
    );
    await collect(openaiCompatChat({
      OpenAI: MockOpenAI, clientConfig: { apiKey: 'k' },
      providerLabel: 'Test', defaultModel: 'm',
      systemPrompt: 'Sos un asistente.',
      history: [{ role: 'user', content: 'hola' }],
    }));
    expect(capturedReq.messages[0]).toEqual({ role: 'system', content: 'Sos un asistente.' });
    expect(capturedReq.messages[1].role).toBe('user');
  });
});
