'use strict';

const EventBus = require('../core/EventBus');
const CallbackGuard = require('../core/CallbackGuard');

describe('CallbackGuard', () => {
  test('passthrough de callback sync que no throwea', () => {
    const cb = jest.fn(() => 'ok');
    const guard = new CallbackGuard();
    const safe = guard.wrap('onChunk', cb);
    expect(safe('texto')).toBe('ok');
    expect(cb).toHaveBeenCalledWith('texto');
  });

  test('callback sync que throwea: no propaga + emite loop:callback_error', () => {
    const bus = new EventBus();
    const events = [];
    bus.on(CallbackGuard.EVENT, (p) => events.push(p));

    const guard = new CallbackGuard({ eventBus: bus, chatId: 'c1' });
    const safe = guard.wrap('onStatus', () => { throw new Error('boom'); });

    expect(() => safe('thinking')).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0].callback).toBe('onStatus');
    expect(events[0].error).toBe('boom');
    expect(events[0].chatId).toBe('c1');
  });

  test('callback async que rechaza: no propaga + emite', async () => {
    const bus = new EventBus();
    const events = [];
    bus.on(CallbackGuard.EVENT, (p) => events.push(p));

    const guard = new CallbackGuard({ eventBus: bus });
    const safe = guard.wrap('onAskPermission', async () => { throw new Error('denied'); });

    const result = await safe('bash', {});
    expect(result).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].callback).toBe('onAskPermission');
  });

  test('callback async ok: retorna valor', async () => {
    const guard = new CallbackGuard();
    const safe = guard.wrap('onAskPermission', async () => true);
    await expect(safe()).resolves.toBe(true);
  });

  test('wrap sin callback → noop silencioso', () => {
    const guard = new CallbackGuard();
    const safe = guard.wrap('onChunk', undefined);
    expect(safe('hola')).toBeUndefined();
  });

  test('onError extra callback también se invoca', () => {
    const onError = jest.fn();
    const guard = new CallbackGuard({ onError });
    const safe = guard.wrap('x', () => { throw new Error('e'); });
    safe();
    expect(onError).toHaveBeenCalledWith('x', expect.any(Error));
  });

  test('onError que throwea no rompe guard', () => {
    const onError = jest.fn(() => { throw new Error('bad handler'); });
    const guard = new CallbackGuard({ onError });
    const safe = guard.wrap('x', () => { throw new Error('e'); });
    expect(() => safe()).not.toThrow();
  });

  test('bus.emit que throwea no rompe guard', () => {
    const bus = { emit: () => { throw new Error('bus dead'); } };
    const guard = new CallbackGuard({ eventBus: bus });
    const safe = guard.wrap('x', () => { throw new Error('e'); });
    expect(() => safe()).not.toThrow();
  });
});
