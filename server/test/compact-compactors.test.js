'use strict';

const EventBus        = require('../core/EventBus');
const ContextCompactor = require('../core/compact/ContextCompactor');
const SlidingWindowCompactor = require('../core/compact/SlidingWindowCompactor');
const MicroCompactor  = require('../core/compact/MicroCompactor');
const ReactiveCompactor = require('../core/compact/ReactiveCompactor');
const CompactorPipeline = require('../core/compact/CompactorPipeline');
const { isOverflowError, extractMaxTokensHint, OVERFLOW_PATTERNS } = require('../core/compact/overflowDetection');

// ── overflowDetection ─────────────────────────────────────────────────

describe('overflowDetection', () => {
  test('detecta "prompt is too long" (Anthropic)', () => {
    expect(isOverflowError(new Error('prompt is too long'))).toBe(true);
  });

  test('detecta "exceeds the context window" (OpenAI)', () => {
    expect(isOverflowError('this request exceeds the context window')).toBe(true);
  });

  test('detecta "maximum context length is 128000 tokens" (xAI)', () => {
    expect(isOverflowError('maximum context length is 128000 tokens')).toBe(true);
  });

  test('detecta "context_length_exceeded" code string', () => {
    expect(isOverflowError('Error: context_length_exceeded')).toBe(true);
  });

  test('detecta "input_tokens exceeds"', () => {
    expect(isOverflowError('input_tokens value 220000 exceeds model limit')).toBe(true);
  });

  test('NO detecta errores no relacionados', () => {
    expect(isOverflowError(new Error('Network timeout'))).toBe(false);
    expect(isOverflowError(new Error('401 Unauthorized'))).toBe(false);
    expect(isOverflowError('')).toBe(false);
    expect(isOverflowError(null)).toBe(false);
  });

  test('extractMaxTokensHint del patrón anthropic', () => {
    const err = new Error('input length and `max_tokens` exceed context limit: 175000 + 32000 > 200000');
    expect(extractMaxTokensHint(err)).toBeGreaterThan(20_000);
    expect(extractMaxTokensHint(err)).toBeLessThan(30_000);
  });

  test('extractMaxTokensHint del patrón xAI', () => {
    expect(extractMaxTokensHint('maximum context length is 128000 tokens')).toBe(128000);
  });

  test('extractMaxTokensHint null si no hay match', () => {
    expect(extractMaxTokensHint('weird error')).toBeNull();
  });

  test('OVERFLOW_PATTERNS exportado para inspección', () => {
    expect(OVERFLOW_PATTERNS.length).toBeGreaterThan(5);
  });
});

// ── SlidingWindowCompactor ────────────────────────────────────────────

describe('SlidingWindowCompactor', () => {
  test('throw si no se inyecta summarize', () => {
    expect(() => new SlidingWindowCompactor({})).toThrow(/summarize/);
  });

  test('shouldCompact true si historySize > maxMessages', () => {
    const c = new SlidingWindowCompactor({ summarize: async () => 's', maxMessages: 10 });
    expect(c.shouldCompact({ historySize: 11 })).toBe(true);
    expect(c.shouldCompact({ historySize: 10 })).toBe(false);
  });

  test('compact resume y reemplaza primeros N con summary + ack', async () => {
    const summarize = jest.fn().mockResolvedValue('resumen corto');
    const c = new SlidingWindowCompactor({
      summarize, maxMessages: 5, messagesToSummarize: 3, summaryMarker: '[TEST]',
    });
    const hist = [
      { role: 'user', content: 'm0' }, { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'keep3' }, { role: 'user', content: 'keep4' }, { role: 'assistant', content: 'keep5' },
    ];
    const out = await c.compact(hist, { apiKey: 'k', model: 'm', provider: 'p' });
    expect(out[0].content).toMatch(/\[TEST\]/);
    expect(out[0].content).toMatch(/resumen corto/);
    expect(out[1].role).toBe('assistant'); // ack
    expect(out.slice(2).map(m => m.content)).toEqual(['keep3', 'keep4', 'keep5']);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  test('summary vacío → retorna history sin tocar (fallback safe)', async () => {
    const c = new SlidingWindowCompactor({ summarize: async () => '', maxMessages: 2, messagesToSummarize: 1 });
    const hist = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const out = await c.compact(hist, {});
    expect(out).toBe(hist);
  });

  test('summarize throwea → retorna history sin tocar (no rompe turn)', async () => {
    const c = new SlidingWindowCompactor({ summarize: async () => { throw new Error('api down'); }, maxMessages: 2, messagesToSummarize: 1 });
    const hist = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const out = await c.compact(hist, {});
    expect(out).toBe(hist);
  });
});

// ── MicroCompactor ────────────────────────────────────────────────────

describe('MicroCompactor', () => {
  test('shouldCompact respeta everyTurns', () => {
    const m = new MicroCompactor({ everyTurns: 10, keepLastK: 4 });
    expect(m.shouldCompact({ turnCount: 5, lastMicroAt: 0, historySize: 20 })).toBe(false);
    expect(m.shouldCompact({ turnCount: 10, lastMicroAt: 0, historySize: 20 })).toBe(true);
    expect(m.shouldCompact({ turnCount: 20, lastMicroAt: 12, historySize: 20 })).toBe(false);
  });

  test('compact preserva primero + últimos K', async () => {
    const m = new MicroCompactor({ keepLastK: 2 });
    const hist = [
      { role: 'system', content: 'sys' },
      { role: 'tool', toolName: 'bash', content: 'x'.repeat(1000) },
      { role: 'tool', toolName: 'grep', content: 'x'.repeat(1000) },
      { role: 'assistant', content: 'pensamiento' },
      { role: 'tool', toolName: 'bash', content: 'TAIL1' },
      { role: 'user', content: 'TAIL2' },
    ];
    const out = await m.compact(hist);
    expect(out[0].content).toBe('sys');                // primero intacto
    expect(out[1].content).toBe('[Old tool result cleared]'); // bash viejo
    expect(out[1]._meta.toolName).toBe('bash');
    expect(out[1]._meta.originalSize).toBe(1000);
    expect(out[2].content).toBe('[Old tool result cleared]'); // grep viejo
    expect(out[3].content).toBe('pensamiento');        // assistant: NO compactable
    expect(out[4].content).toBe('TAIL1');              // tail intacto (bash reciente)
    expect(out[5].content).toBe('TAIL2');
  });

  test('NO compacta memory_read ni task_get (no están en COMPACTABLE_TOOLS)', async () => {
    const m = new MicroCompactor({ keepLastK: 1 });
    const hist = [
      { role: 'system', content: 'sys' },
      { role: 'tool', toolName: 'memory_read', content: 'user prefs' },
      { role: 'user', content: 'last' },
    ];
    const out = await m.compact(hist);
    expect(out[1].content).toBe('user prefs');
  });

  test('emite pre_compact y post_compact al hookRegistry', async () => {
    const events = [];
    const hookRegistry = {
      enabled: true,
      emit: async (name, p) => events.push({ name, p }),
    };
    const m = new MicroCompactor({ keepLastK: 1 });
    const hist = [
      { role: 'system', content: 'sys' },
      { role: 'tool', toolName: 'bash', content: 'old' },
      { role: 'user', content: 'last' },
    ];
    await m.compact(hist, { hookRegistry });
    expect(events.map(e => e.name)).toEqual(['pre_compact', 'post_compact']);
  });

  test('history muy corto no se toca', async () => {
    const m = new MicroCompactor({ keepLastK: 4 });
    const hist = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    const out = await m.compact(hist);
    expect(out).toBe(hist);
  });
});

// ── ReactiveCompactor ─────────────────────────────────────────────────

describe('ReactiveCompactor', () => {
  function makeMicro() {
    return {
      name: 'mockMicro',
      shouldCompact: () => true,
      compact: jest.fn(async (h) => h.slice(0, -1)),
    };
  }

  test('throw si faltan deps', () => {
    expect(() => new ReactiveCompactor({})).toThrow(/microCompactor/);
    expect(() => new ReactiveCompactor({ microCompactor: makeMicro() })).toThrow(/summarize/);
  });

  test('shouldCompact true si usage excede buffer', () => {
    const c = new ReactiveCompactor({ microCompactor: makeMicro(), summarize: async () => 's', autocompactBufferTokens: 10_000 });
    expect(c.shouldCompact({ usage: 195_000, contextWindow: 200_000 })).toBe(true);
    expect(c.shouldCompact({ usage: 150_000, contextWindow: 200_000 })).toBe(false);
  });

  test('pct < 0.90 → llama microCompactor', async () => {
    const micro = makeMicro();
    const summarize = jest.fn();
    const c = new ReactiveCompactor({ microCompactor: micro, summarize });
    const hist = [{ role: 'system' }, { role: 'user' }, { role: 'assistant' }];
    await c.compact(hist, { usage: 170_000, contextWindow: 200_000, chatId: 'c1' });
    expect(micro.compact).toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  test('pct >= 0.90 → llama summarize', async () => {
    const micro = makeMicro();
    const summarize = jest.fn().mockResolvedValue('compressed summary');
    const c = new ReactiveCompactor({
      microCompactor: micro, summarize, preservedTailOnAggressive: 2,
    });
    const hist = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'tail1' },
      { role: 'assistant', content: 'tail2' },
    ];
    const out = await c.compact(hist, { usage: 195_000, contextWindow: 200_000, chatId: 'c1' });
    expect(summarize).toHaveBeenCalled();
    expect(out[0].content).toBe('sys');
    expect(out[1].content).toMatch(/Resumen automático/);
    expect(out[1].content).toMatch(/compressed summary/);
    expect(out[out.length - 1].content).toBe('tail2');
  });

  test('circuit breaker: 3 fallos seguidos → throw CompactCircuitOpenError', async () => {
    const micro = makeMicro();
    micro.compact = jest.fn(async () => { throw new Error('simulated'); });
    const c = new ReactiveCompactor({
      microCompactor: micro, summarize: async () => 's', maxFailures: 3,
    });
    // usage=170k / window=200k → pct=0.85 < 0.90 → usa microCompactor (el que falla)
    for (let i = 0; i < 3; i++) {
      try { await c.compact([{ role: 'user' }], { usage: 170_000, contextWindow: 200_000, chatId: 'chatA' }); }
      catch { /* expected */ }
    }
    await expect(c.compact([{ role: 'user' }], { usage: 170_000, contextWindow: 200_000, chatId: 'chatA' }))
      .rejects.toThrow(ReactiveCompactor.CompactCircuitOpenError);
  });

  test('éxito resetea contador de fallos', async () => {
    const micro = makeMicro();
    let i = 0;
    micro.compact = jest.fn(async (h) => {
      i++;
      if (i === 1) throw new Error('once');
      return h;
    });
    const c = new ReactiveCompactor({ microCompactor: micro, summarize: async () => '', maxFailures: 3 });
    try { await c.compact([{}], { usage: 170_000, contextWindow: 200_000, chatId: 'cX' }); } catch {}
    expect(c._getFailures('cX')).toBe(1);
    await c.compact([{}], { usage: 170_000, contextWindow: 200_000, chatId: 'cX' });
    expect(c._getFailures('cX')).toBe(0);
  });

  test('CompactCircuitOpenError emite compact:circuit_open', async () => {
    const bus = new EventBus();
    const events = [];
    bus.on('compact:circuit_open', (p) => events.push(p));
    const micro = makeMicro();
    micro.compact = jest.fn(async () => { throw new Error('fail'); });
    const c = new ReactiveCompactor({
      microCompactor: micro, summarize: async () => '', maxFailures: 1, eventBus: bus,
    });
    try { await c.compact([{}], { usage: 170_000, contextWindow: 200_000, chatId: 'cY' }); } catch {}
    try { await c.compact([{}], { usage: 170_000, contextWindow: 200_000, chatId: 'cY' }); } catch {}
    expect(events.length).toBe(1);
    expect(events[0].chatId).toBe('cY');
  });
});

// ── CompactorPipeline ─────────────────────────────────────────────────

describe('CompactorPipeline', () => {
  function fakeCompactor(name, triggers, transform = (h) => h) {
    return {
      name,
      shouldCompact: () => triggers,
      compact: jest.fn(async (h) => transform(h)),
    };
  }

  test('enabled=false → no toca history', async () => {
    const p = new CompactorPipeline({ compactors: [fakeCompactor('a', true)], enabled: false });
    const hist = [{ x: 1 }];
    const r = await p.maybeCompact(hist, {});
    expect(r.applied).toBeNull();
    expect(r.history).toBe(hist);
  });

  test('sin compactors → passthrough', async () => {
    const p = new CompactorPipeline({ compactors: [], enabled: true });
    const r = await p.maybeCompact([{ x: 1 }]);
    expect(r.applied).toBeNull();
  });

  test('primer shouldCompact true gana (orden reactive→micro→sliding)', async () => {
    const reactive = fakeCompactor('reactive', true, () => [{ a: 1 }]);
    const micro    = fakeCompactor('micro',    true, () => [{ b: 1 }]);
    const sliding  = fakeCompactor('sliding',  true);
    const p = new CompactorPipeline({ compactors: [reactive, micro, sliding], enabled: true });
    const r = await p.maybeCompact([], {});
    expect(r.applied).toBe('reactive');
    expect(micro.compact).not.toHaveBeenCalled();
    expect(sliding.compact).not.toHaveBeenCalled();
  });

  test('si compact falla → intenta siguiente', async () => {
    const failing = {
      name: 'failing',
      shouldCompact: () => true,
      compact: jest.fn(async () => { throw new Error('boom'); }),
    };
    const working = fakeCompactor('working', true, () => [{ ok: true }]);
    const p = new CompactorPipeline({ compactors: [failing, working], enabled: true });
    const r = await p.maybeCompact([]);
    expect(r.applied).toBe('working');
    expect(failing.compact).toHaveBeenCalled();
    expect(working.compact).toHaveBeenCalled();
  });

  test('CompactCircuitOpenError se propaga (no se prueba siguiente)', async () => {
    const { CompactCircuitOpenError } = require('../core/compact/ReactiveCompactor');
    const circuit = {
      name: 'circuit',
      shouldCompact: () => true,
      compact: async () => { throw new CompactCircuitOpenError('cZ'); },
    };
    const other = fakeCompactor('other', true);
    const p = new CompactorPipeline({ compactors: [circuit, other], enabled: true });
    await expect(p.maybeCompact([], {})).rejects.toThrow(/circuit breaker/);
    expect(other.compact).toHaveBeenCalledTimes(0);
  });

  test('shouldCompact que throwea se salta sin crashear', async () => {
    const bad = {
      name: 'bad',
      shouldCompact: () => { throw new Error('bad gate'); },
      compact: jest.fn(),
    };
    const ok = fakeCompactor('ok', true, () => [{ done: true }]);
    const p = new CompactorPipeline({ compactors: [bad, ok], enabled: true });
    const r = await p.maybeCompact([]);
    expect(r.applied).toBe('ok');
  });

  test('nadie dispara → history pasa tal cual', async () => {
    const c1 = fakeCompactor('c1', false);
    const c2 = fakeCompactor('c2', false);
    const p = new CompactorPipeline({ compactors: [c1, c2], enabled: true });
    const hist = [{ a: 1 }];
    const r = await p.maybeCompact(hist);
    expect(r.applied).toBeNull();
    expect(r.history).toBe(hist);
  });
});
