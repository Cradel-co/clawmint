'use strict';

/**
 * Tests de anthropic.js v2 (fase 1 del refactor).
 *
 * Cubre:
 *   1. Helpers puros: resolveMaxTokens, applyCacheToSystem, applyCacheToTools, resolveThinking
 *   2. Streaming: emite 'text' por cada chunk (no al final)
 *   3. Tool call → tool_result round trip con `executeTool`
 *   4. cache_stats se emite cuando hay cache hits
 *   5. thinking_delta emite 'thinking' eventos
 *   6. AbortSignal corta el stream antes de terminar
 *
 * Mockea el SDK `@anthropic-ai/sdk` para controlar eventos y timing deterministas.
 */

jest.mock('@anthropic-ai/sdk');

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = require('../providers/anthropic');

// ── Helpers del provider ─────────────────────────────────────────────────────

describe('anthropic._internal — helpers puros', () => {
  const { resolveMaxTokens, applyCacheToSystem, applyCacheToTools, resolveThinking } = anthropic._internal;

  test('resolveMaxTokens respeta override explícito', () => {
    expect(resolveMaxTokens('claude-opus-4-6', 1234)).toBe(1234);
  });
  test('resolveMaxTokens: Opus → 16000', () => {
    expect(resolveMaxTokens('claude-opus-4-6')).toBe(16000);
    expect(resolveMaxTokens('claude-opus-4-7')).toBe(16000);
  });
  test('resolveMaxTokens: Sonnet → 8192', () => {
    expect(resolveMaxTokens('claude-sonnet-4-6')).toBe(8192);
  });
  test('resolveMaxTokens: Haiku → 4096', () => {
    expect(resolveMaxTokens('claude-haiku-4-5')).toBe(4096);
  });
  test('resolveMaxTokens: desconocido → 4096', () => {
    expect(resolveMaxTokens('mystery-model')).toBe(4096);
    expect(resolveMaxTokens(null)).toBe(4096);
  });

  test('applyCacheToSystem: string corto se pasa tal cual (< 1000 chars)', () => {
    const short = 'Sos un asistente.';
    expect(applyCacheToSystem(short)).toBe(short);
  });
  test('applyCacheToSystem: string largo se envuelve con cache_control', () => {
    const long = 'x'.repeat(1500);
    const out = applyCacheToSystem(long);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].type).toBe('text');
    expect(out[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  test('applyCacheToSystem: array existente → cache_control en último bloque', () => {
    const arr = [
      { type: 'text', text: 'bloque 1' },
      { type: 'text', text: 'bloque 2' },
    ];
    const out = applyCacheToSystem(arr);
    expect(out[0]).toEqual({ type: 'text', text: 'bloque 1' }); // sin cache
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });
  test('applyCacheToSystem: undefined/null retorna undefined', () => {
    expect(applyCacheToSystem(undefined)).toBeUndefined();
    expect(applyCacheToSystem(null)).toBeUndefined();
  });

  test('applyCacheToTools: agrega cache_control al último tool', () => {
    const defs = [
      { name: 'a', input_schema: {} },
      { name: 'b', input_schema: {} },
    ];
    const out = applyCacheToTools(defs);
    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
  });
  test('applyCacheToTools: array vacío retorna array vacío', () => {
    expect(applyCacheToTools([])).toEqual([]);
  });

  test('resolveThinking: false → null', () => {
    expect(resolveThinking(false)).toBeNull();
    expect(resolveThinking(undefined)).toBeNull();
  });
  test('resolveThinking: adaptive → budget 2048', () => {
    expect(resolveThinking('adaptive')).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(resolveThinking(true)).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });
  test("resolveThinking: 'enabled' respeta thinkingBudget con mínimo 1024", () => {
    expect(resolveThinking('enabled', 5000)).toEqual({ type: 'enabled', budget_tokens: 5000 });
    expect(resolveThinking('enabled', 500)).toEqual({ type: 'enabled', budget_tokens: 1024 }); // clamp min
    expect(resolveThinking('enabled')).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
  test('resolveThinking: number shorthand con clamp mínimo', () => {
    expect(resolveThinking(3000)).toEqual({ type: 'enabled', budget_tokens: 3000 });
    expect(resolveThinking(100)).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });
});

// ── Mock de stream Anthropic ──────────────────────────────────────────────────

/**
 * Crea un mock stream que emite los eventos `events` en orden y cuya
 * `finalMessage()` resuelve a `finalMsg`.
 */
function mockStream(events, finalMsg, { aborted = false } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        if (aborted) return;
        yield ev;
      }
    },
    async finalMessage() { return finalMsg; },
  };
}

function makeClient(streamImpl) {
  return {
    messages: {
      stream: jest.fn().mockImplementation(streamImpl),
    },
  };
}

async function collect(asyncGen) {
  const events = [];
  for await (const ev of asyncGen) events.push(ev);
  return events;
}

// ── Tests de chat (integración con mock SDK) ──────────────────────────────────

describe('anthropic.chat — streaming', () => {
  beforeEach(() => {
    Anthropic.mockClear();
  });

  test('sin apiKey → emite done con error, nunca crea cliente', async () => {
    const events = await collect(anthropic.chat({ history: [], apiKey: '' }));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(events[0].fullText).toMatch(/API key/);
    expect(Anthropic).not.toHaveBeenCalled();
  });

  test('emite text por cada text_delta (streaming progresivo)', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hola' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' mundo' } },
    ];
    const finalMsg = {
      content: [{ type: 'text', text: 'Hola mundo' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    Anthropic.mockImplementation(() => makeClient(() => mockStream(streamEvents, finalMsg)));

    const events = await collect(anthropic.chat({
      systemPrompt: 'test', history: [], apiKey: 'sk-test', model: 'claude-haiku-4-5-20251001',
    }));

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].text).toBe('Hola');
    expect(textEvents[1].text).toBe(' mundo');

    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toBe('Hola mundo');
  });

  test('tool_use → emite tool_call, ejecuta executeTool, reenvía tool_result', async () => {
    const execTool = jest.fn().mockResolvedValue('salida del comando');

    // Primer turno: el modelo pide ejecutar bash
    const firstStream = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'voy a ejecutar' } },
    ];
    const firstFinal = {
      content: [
        { type: 'text', text: 'voy a ejecutar' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    // Segundo turno: responde con texto final
    const secondStream = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'listo' } },
    ];
    const secondFinal = {
      content: [{ type: 'text', text: 'listo' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 5 },
    };

    let callCount = 0;
    Anthropic.mockImplementation(() => makeClient(() => {
      callCount++;
      return callCount === 1 ? mockStream(firstStream, firstFinal) : mockStream(secondStream, secondFinal);
    }));

    const events = await collect(anthropic.chat({
      history: [], apiKey: 'sk-test', executeTool: execTool,
    }));

    expect(execTool).toHaveBeenCalledWith('bash', { command: 'ls' });
    const toolCalls = events.filter(e => e.type === 'tool_call');
    const toolResults = events.filter(e => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('bash');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].result).toBe('salida del comando');
    expect(events.find(e => e.type === 'done').fullText).toContain('listo');
  });

  test('cache_stats se emite cuando hay cache_read/creation', async () => {
    const finalMsg = {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 800,
      },
    };
    Anthropic.mockImplementation(() => makeClient(() => mockStream([], finalMsg)));

    const events = await collect(anthropic.chat({
      history: [], apiKey: 'sk-test', enableCache: true,
    }));

    const cacheStats = events.find(e => e.type === 'cache_stats');
    expect(cacheStats).toBeTruthy();
    expect(cacheStats.creation).toBe(1500);
    expect(cacheStats.read).toBe(800);
  });

  test('thinking_delta emite eventos "thinking"', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pensando...' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'respuesta' } },
    ];
    const finalMsg = {
      content: [
        { type: 'thinking', thinking: 'pensando...', signature: 'sig' },
        { type: 'text', text: 'respuesta' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    Anthropic.mockImplementation(() => makeClient(() => mockStream(streamEvents, finalMsg)));

    const events = await collect(anthropic.chat({
      history: [], apiKey: 'sk-test', enableThinking: 'adaptive',
    }));

    expect(events.find(e => e.type === 'thinking').text).toBe('pensando...');
    expect(events.find(e => e.type === 'text').text).toBe('respuesta');
  });

  test('AbortSignal previo a la llamada → done con mensaje cancelado', async () => {
    Anthropic.mockImplementation(() => makeClient(() => mockStream([], null)));
    const ac = new AbortController();
    ac.abort();

    const events = await collect(anthropic.chat({
      history: [], apiKey: 'sk-test', signal: ac.signal,
    }));

    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/Cancelado/);
  });

  test('cache_control se inyecta cuando enableCache=true y systemPrompt es largo', async () => {
    const finalMsg = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    let captured;
    Anthropic.mockImplementation(() => makeClient((req) => {
      captured = req;
      return mockStream([], finalMsg);
    }));

    await collect(anthropic.chat({
      systemPrompt: 'x'.repeat(1500),
      history: [], apiKey: 'sk-test', enableCache: true,
    }));

    expect(Array.isArray(captured.system)).toBe(true);
    expect(captured.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('enableThinking=true agrega `thinking` al request y temperature=1', async () => {
    const finalMsg = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    let captured;
    Anthropic.mockImplementation(() => makeClient((req) => {
      captured = req;
      return mockStream([], finalMsg);
    }));

    await collect(anthropic.chat({
      history: [], apiKey: 'sk-test', enableThinking: 'adaptive',
    }));

    expect(captured.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(captured.temperature).toBe(1);
  });

  test('max_tokens se resuelve según modelo cuando no hay override', async () => {
    const finalMsg = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    let captured;
    Anthropic.mockImplementation(() => makeClient((req) => {
      captured = req;
      return mockStream([], finalMsg);
    }));

    await collect(anthropic.chat({ history: [], apiKey: 'sk-test', model: 'claude-opus-4-6' }));
    expect(captured.max_tokens).toBe(16000);

    await collect(anthropic.chat({ history: [], apiKey: 'sk-test', model: 'claude-sonnet-4-6' }));
    expect(captured.max_tokens).toBe(8192);

    await collect(anthropic.chat({ history: [], apiKey: 'sk-test', model: 'claude-haiku-4-5-20251001' }));
    expect(captured.max_tokens).toBe(4096);
  });

  test('error del SDK se traduce a done con mensaje de error', async () => {
    Anthropic.mockImplementation(() => ({
      messages: {
        stream: () => { throw new Error('rate limit excedido'); },
      },
    }));

    const events = await collect(anthropic.chat({ history: [], apiKey: 'sk-test' }));
    const done = events.find(e => e.type === 'done');
    expect(done.fullText).toMatch(/rate limit excedido/);
  });
});
