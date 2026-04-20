'use strict';

const EventBus    = require('../core/EventBus');
const LoopRunner  = require('../core/LoopRunner');
const RetryPolicy = require('../core/RetryPolicy');

// Helper: crea provider fake que yielda los eventos dados
function fakeProvider(events) {
  return {
    async *chat() {
      for (const ev of events) {
        if (ev instanceof Error) throw ev;
        yield ev;
      }
    },
  };
}

// Helper: provider que aborta al recibir signal
function cancellableProvider(delayPerEventMs, events) {
  return {
    async *chat({ signal } = {}) {
      for (const ev of events) {
        await new Promise((res, rej) => {
          const t = setTimeout(res, delayPerEventMs);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
          }
        });
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield ev;
      }
    },
  };
}

// Helper: provider que falla N veces y después emite ok
function flakyProvider(failTimes, errorMessage, okEvents) {
  let calls = 0;
  return {
    async *chat() {
      calls++;
      if (calls <= failTimes) {
        throw new Error(errorMessage);
      }
      for (const ev of okEvents) yield ev;
    },
    _getCalls: () => calls,
  };
}

function collectEvents(bus) {
  const events = [];
  bus.onAny = () => {};
  const names = Object.values(LoopRunner.EVENTS);
  for (const n of names) bus.on(n, (p) => events.push({ name: n, payload: p }));
  return events;
}

describe('LoopRunner — happy path', () => {
  test('emite text_delta y done; acumula texto', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = fakeProvider([
      { type: 'text', text: 'Hola ' },
      { type: 'text', text: 'mundo' },
      { type: 'usage', promptTokens: 10, completionTokens: 5 },
      { type: 'done', fullText: 'Hola mundo' },
    ]);
    const chunks = [];
    const runner = new LoopRunner({ eventBus: bus });
    const result = await runner.run({
      chatId: 'c1',
      provObj,
      chatArgs: { history: [] },
      onChunk: (s) => chunks.push(s),
    });
    expect(result.text).toBe('Hola mundo');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usedTools).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(chunks).toEqual(['Hola ', 'Hola mundo']);
    expect(events.map(e => e.name)).toEqual(expect.arrayContaining([
      'loop:start', 'loop:text_delta', 'loop:done',
    ]));
  });

  test('tool_call marca usedTools + emite evento', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = fakeProvider([
      { type: 'tool_call', name: 'grep', args: { pattern: 'foo' } },
      { type: 'tool_result', name: 'grep', result: 'foo.js:1:foo', durationMs: 12 },
      { type: 'text', text: 'encontré foo' },
      { type: 'done' },
    ]);
    const runner = new LoopRunner({ eventBus: bus });
    const result = await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(result.usedTools).toBe(true);
    const toolCall = events.find(e => e.name === 'loop:tool_call');
    expect(toolCall).toBeTruthy();
    expect(toolCall.payload.name).toBe('grep');
    expect(toolCall.payload.args).toEqual({ pattern: 'foo' });
  });
});

describe('LoopRunner — retries', () => {
  test('retry en error transient: dos intentos, segundo ok', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = flakyProvider(1, '429 rate limit', [
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 10, jitterMs: 0 });
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: policy });
    const result = await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(result.text).toBe('ok');
    expect(provObj._getCalls()).toBe(2);
    const retry = events.find(e => e.name === 'loop:retry');
    expect(retry).toBeTruthy();
    expect(retry.payload.reason).toBe('transient:rate_limit');
  });

  test('NO retry en error permanente', async () => {
    const provObj = flakyProvider(5, '401 Unauthorized', []);
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    const runner = new LoopRunner({ retryPolicy: policy });
    const result = await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(provObj._getCalls()).toBe(1);
    expect(result.text).toMatch(/401/);
    expect(result.stopReason).toBe('error');
  });

  test('NO retry si ya se ejecutaron tools', async () => {
    let call = 0;
    const provObj = {
      async *chat() {
        call++;
        yield { type: 'tool_call', name: 'bash', args: { command: 'ls' } };
        throw new Error('timeout');
      },
    };
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    const runner = new LoopRunner({ retryPolicy: policy });
    await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(call).toBe(1);
  });
});

describe('LoopRunner — cancelación', () => {
  test('timeout aborta el stream y emite loop:cancel', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = cancellableProvider(200, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'done' },
    ]);
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    const result = await runner.run({
      chatId: 'c1',
      provObj,
      chatArgs: { history: [] },
      timeoutMs: 50,
    });
    expect(result.stopReason).toBe('cancelled');
    const cancel = events.find(e => e.name === 'loop:cancel');
    expect(cancel).toBeTruthy();
    expect(cancel.payload.reason).toBe('timeout');
  });

  test('parent signal externo aborta → reason=signal', async () => {
    const controller = new AbortController();
    const provObj = cancellableProvider(100, [{ type: 'text', text: 'x' }, { type: 'done' }]);
    setTimeout(() => controller.abort(), 20);
    const bus = new EventBus();
    const events = collectEvents(bus);
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    const result = await runner.run({
      chatId: 'c1',
      provObj,
      chatArgs: { history: [] },
      signal: controller.signal,
      timeoutMs: 5000,
    });
    expect(result.stopReason).toBe('cancelled');
    const cancel = events.find(e => e.name === 'loop:cancel');
    expect(cancel.payload.reason).toBe('signal');
  });
});

describe('LoopRunner — callbacks safe', () => {
  test('onChunk que throwea no rompe el loop y emite loop:callback_error', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = fakeProvider([
      { type: 'text', text: 'hola' },
      { type: 'done' },
    ]);
    const runner = new LoopRunner({ eventBus: bus });
    const result = await runner.run({
      chatId: 'c1',
      provObj,
      chatArgs: { history: [] },
      onChunk: () => { throw new Error('callback boom'); },
    });
    expect(result.text).toBe('hola');
    const err = events.find(e => e.name === 'loop:callback_error');
    expect(err).toBeTruthy();
    expect(err.payload.callback).toBe('onChunk');
  });
});

describe('LoopRunner — deep clone del history', () => {
  test('mutación externa del array history no afecta al runner', async () => {
    const history = [{ role: 'user', content: 'primero' }];
    let observed = null;
    const provObj = {
      async *chat(args) {
        observed = args.history;
        yield { type: 'text', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const runner = new LoopRunner();
    const p = runner.run({ chatId: 'c1', provObj, chatArgs: { history } });
    // Mutar original antes de que el provider reciba args
    history[0].content = 'mutado';
    history.push({ role: 'user', content: 'extra' });
    await p;
    expect(observed).toHaveLength(1);
    expect(observed[0].content).toBe('primero');
  });
});

describe('LoopRunner — provider_error (Ajuste 6.7)', () => {
  test('emite loop:provider_error cuando retry da up con error permanente', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = flakyProvider(5, '401 Unauthorized', []); // errores permanentes
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 });
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: policy });
    const result = await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(result.stopReason).toBe('error');
    const providerErr = events.find(e => e.name === 'loop:provider_error');
    expect(providerErr).toBeTruthy();
    expect(providerErr.payload.error).toMatch(/401/);
  });

  test('llama hookRegistry.emit("provider_error") si hookRegistry está inyectado', async () => {
    const provObj = flakyProvider(5, '401 Unauthorized', []);
    const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 });
    const hookCalls = [];
    const hookRegistry = {
      enabled: true,
      emit: async (event, payload) => { hookCalls.push({ event, payload }); return { block: false }; },
    };
    const runner = new LoopRunner({ retryPolicy: policy, hookRegistry });
    await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    const hookCall = hookCalls.find(c => c.event === 'provider_error');
    expect(hookCall).toBeTruthy();
    expect(hookCall.payload.error).toMatch(/401/);
  });

  test('NO emite provider_error si el loop completa normal', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = fakeProvider([{ type: 'text', text: 'ok' }, { type: 'done' }]);
    const runner = new LoopRunner({ eventBus: bus });
    await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    expect(events.find(e => e.name === 'loop:provider_error')).toBeFalsy();
  });
});

describe('LoopRunner — loop detection', () => {
  test('3 tool_calls idénticos consecutivos → loop:loop_detected + cancel', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const provObj = fakeProvider([
      { type: 'tool_call', name: 'grep', args: { p: 'x' } },
      { type: 'tool_call', name: 'grep', args: { p: 'x' } },
      { type: 'tool_call', name: 'grep', args: { p: 'x' } },
      { type: 'done' },
    ]);
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    const result = await runner.run({ chatId: 'c1', provObj, chatArgs: { history: [] } });
    const detected = events.find(e => e.name === 'loop:loop_detected');
    expect(detected).toBeTruthy();
    expect(detected.payload.toolName).toBe('grep');
    expect(detected.payload.consecutiveCount).toBe(3);
    const cancel = events.find(e => e.name === 'loop:cancel');
    expect(cancel).toBeTruthy();
    expect(cancel.payload.reason).toBe('loop_detected');
    expect(result.stopReason).toBe('cancelled');
  });
});
