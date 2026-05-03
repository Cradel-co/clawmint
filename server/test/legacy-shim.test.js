'use strict';

/**
 * Tests de legacyShim — envuelve un provider v1 (contrato actual) para exponer
 * eventos v2 (ProviderEvents).
 *
 * No se testean providers reales acá (eso está en providers.test.js) — solo
 * que la traducción v1 → v2 preserva información y formatos.
 */

const legacyShim = require('../providers/base/legacyShim');
const { EVENT_TYPES, STOP_REASON } = require('../providers/base/ProviderEvents');

/** Crea un provider v1 fake que emite una lista predefinida de eventos */
function mockProvider(name, events) {
  return {
    name,
    label: `Mock ${name}`,
    defaultModel: 'mock-1',
    models: ['mock-1'],
    async *chat() {
      for (const ev of events) yield ev;
    },
  };
}

async function collect(asyncGen) {
  const out = [];
  for await (const ev of asyncGen) out.push(ev);
  return out;
}

describe('legacyShim — traducción v1 → v2', () => {
  test('expone name/label/models desde el provider wrappeado', () => {
    const p = mockProvider('fake', []);
    const shimmed = legacyShim(p);
    expect(shimmed.name).toBe('fake');
    expect(shimmed.label).toBe('Mock fake');
    expect(shimmed.defaultModel).toBe('mock-1');
  });

  test('getCapabilities() devuelve caps por nombre de provider', () => {
    const p = mockProvider('anthropic', []);
    const caps = legacyShim(p).getCapabilities();
    expect(typeof caps).toBe('object');
    expect('streaming' in caps).toBe(true);
  });

  test('traduce text → text_delta', async () => {
    const p = mockProvider('x', [
      { type: 'text', text: 'Hola' },
      { type: 'text', text: ' mundo' },
      { type: 'done', fullText: 'Hola mundo' },
    ]);
    const events = await collect(legacyShim(p).chat({}));
    const textDeltas = events.filter(e => e.type === EVENT_TYPES.TEXT_DELTA);
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].text).toBe('Hola');
    expect(textDeltas[1].text).toBe(' mundo');
  });

  test('tool_call sintetiza tool_call_start + tool_call_end con args parseados', async () => {
    const p = mockProvider('x', [
      { type: 'tool_call', name: 'bash', args: { command: 'ls' } },
      { type: 'tool_result', name: 'bash', result: 'file1\nfile2' },
      { type: 'done', fullText: '' },
    ]);
    const events = await collect(legacyShim(p).chat({}));
    const starts = events.filter(e => e.type === EVENT_TYPES.TOOL_CALL_START);
    const ends = events.filter(e => e.type === EVENT_TYPES.TOOL_CALL_END);
    const results = events.filter(e => e.type === EVENT_TYPES.TOOL_RESULT);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(ends[0].args).toEqual({ command: 'ls' });
    expect(ends[0].name).toBe('bash');
    expect(results[0].result).toBe('file1\nfile2');
    // El id debe estar correlacionado entre start/end/result
    expect(starts[0].id).toBe(ends[0].id);
    expect(starts[0].id).toBe(results[0].id);
  });

  test('usage se mapea preservando tokens', async () => {
    const p = mockProvider('x', [
      { type: 'usage', promptTokens: 100, completionTokens: 50 },
      { type: 'done', fullText: 'ok' },
    ]);
    const events = await collect(legacyShim(p).chat({}));
    const usage = events.find(e => e.type === EVENT_TYPES.USAGE);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
  });

  test('done se mapea con stopReason=end_turn por default', async () => {
    const p = mockProvider('x', [{ type: 'done', fullText: 'hecho' }]);
    const events = await collect(legacyShim(p).chat({}));
    const done = events.find(e => e.type === EVENT_TYPES.DONE);
    expect(done.fullText).toBe('hecho');
    expect(done.stopReason).toBe(STOP_REASON.END_TURN);
  });

  test('excepción del provider se traduce a error + done(stopReason=error)', async () => {
    const p = {
      name: 'x', label: 'x', defaultModel: 'm', models: ['m'],
      async *chat() {
        yield { type: 'text', text: 'hasta acá llegué' };
        throw new Error('fallo API');
      },
    };
    const events = await collect(legacyShim(p).chat({}));
    const errEvt = events.find(e => e.type === EVENT_TYPES.ERROR);
    const done = events.find(e => e.type === EVENT_TYPES.DONE);
    expect(errEvt).toBeTruthy();
    expect(errEvt.message).toMatch(/fallo API/);
    expect(done.stopReason).toBe(STOP_REASON.ERROR);
  });

  test('rechaza provider inválido (sin chat)', () => {
    expect(() => legacyShim(null)).toThrow();
    expect(() => legacyShim({ name: 'x' })).toThrow();
  });

  test('eventos desconocidos se pasan tal cual', async () => {
    const p = mockProvider('x', [
      { type: 'custom_thing', payload: 123 },
      { type: 'done', fullText: '' },
    ]);
    const events = await collect(legacyShim(p).chat({}));
    const custom = events.find(e => e.type === 'custom_thing');
    expect(custom).toBeTruthy();
    expect(custom.payload).toBe(123);
  });
});
