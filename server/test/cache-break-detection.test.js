'use strict';

const EventBus = require('../core/EventBus');
const LoopRunner = require('../core/LoopRunner');
const RetryPolicy = require('../core/RetryPolicy');

describe('LoopRunner — cache:miss event (Fase 7.3)', () => {
  test('provider emite cache_stats con missExpected=true → LoopRunner emite cache:miss', async () => {
    const bus = new EventBus();
    const events = [];
    bus.on('cache:miss', (p) => events.push(p));

    const provObj = {
      async *chat() {
        yield { type: 'text', text: 'hola' };
        yield { type: 'cache_stats', creation: 5000, read: 0, missExpected: true };
        yield { type: 'done' };
      },
    };
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    await runner.run({ chatId: 'c1', provider: 'anthropic', model: 'claude-opus-4-7', provObj, chatArgs: { history: [] } });
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe('anthropic');
    expect(events[0].creation).toBe(5000);
    expect(events[0].read).toBe(0);
  });

  test('cache_stats sin missExpected → NO emite cache:miss (solo cache:stats)', async () => {
    const bus = new EventBus();
    const misses = [];
    const stats = [];
    bus.on('cache:miss', (p) => misses.push(p));
    bus.on('cache:stats', (p) => stats.push(p));

    const provObj = {
      async *chat() {
        yield { type: 'text', text: 'x' };
        yield { type: 'cache_stats', creation: 5000, read: 10_000, missExpected: false };
        yield { type: 'done' };
      },
    };
    const runner = new LoopRunner({ eventBus: bus, retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    await runner.run({ chatId: 'c2', provObj, chatArgs: { history: [] } });
    expect(misses).toHaveLength(0);
    expect(stats).toHaveLength(1);
    expect(stats[0].read).toBe(10_000);
  });

  test('sin eventBus → no crashea', async () => {
    const provObj = {
      async *chat() {
        yield { type: 'cache_stats', creation: 5000, read: 0, missExpected: true };
        yield { type: 'done' };
      },
    };
    const runner = new LoopRunner({ retryPolicy: new RetryPolicy({ maxRetries: 1 }) });
    const r = await runner.run({ chatId: 'c3', provObj, chatArgs: { history: [] } });
    expect(r.stopReason).toBeDefined();
  });
});
