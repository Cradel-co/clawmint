'use strict';

const EventEmitter = require('events');
const SuspendedPromptsManager = require('../core/SuspendedPromptsManager');

describe('SuspendedPromptsManager (Fase 4 extra)', () => {
  test('suspend requiere chatId + question', async () => {
    const m = new SuspendedPromptsManager();
    await expect(m.suspend({})).rejects.toThrow(/chatId/);
    await expect(m.suspend({ chatId: 'c1' })).rejects.toThrow(/question/);
  });

  test('suspend + resume resuelve el Promise con la respuesta', async () => {
    const m = new SuspendedPromptsManager();
    const p = m.suspend({ chatId: 'c1', question: '¿A o B?', timeoutMs: 1000 });
    expect(m.hasPending('c1')).toBe(true);
    const ok = m.resume('c1', 'A');
    expect(ok).toBe(true);
    expect(m.hasPending('c1')).toBe(false);
    expect(await p).toBe('A');
  });

  test('resume en chat sin pending retorna false', () => {
    const m = new SuspendedPromptsManager();
    expect(m.resume('nope', 'x')).toBe(false);
  });

  test('timeout rechaza con error descriptivo', async () => {
    const m = new SuspendedPromptsManager();
    const p = m.suspend({ chatId: 'c1', question: 'q', timeoutMs: 30 });
    await expect(p).rejects.toThrow(/timeout/);
    expect(m.hasPending('c1')).toBe(false);
  });

  test('cancel rechaza el Promise', async () => {
    const m = new SuspendedPromptsManager();
    const p = m.suspend({ chatId: 'c1', question: 'q', timeoutMs: 1000 });
    const assert = expect(p).rejects.toThrow(/user_abort/);
    const ok = m.cancel('c1', 'user_abort');
    expect(ok).toBe(true);
    await assert;
  });

  test('suspend nuevo reemplaza al viejo (rechaza "superseded")', async () => {
    const m = new SuspendedPromptsManager();
    const p1 = m.suspend({ chatId: 'c1', question: 'q1', timeoutMs: 1000 });
    const assert1 = expect(p1).rejects.toThrow(/superseded/);
    const p2 = m.suspend({ chatId: 'c1', question: 'q2', timeoutMs: 1000 });
    await assert1;
    m.resume('c1', 'respuesta');
    expect(await p2).toBe('respuesta');
  });

  test('getPending retorna record sin Promise', async () => {
    const m = new SuspendedPromptsManager();
    const p = m.suspend({ chatId: 'c1', question: 'q', options: ['a', 'b'], timeoutMs: 1000 });
    p.catch(() => {}); // absorber rejection del cancel
    const r = m.getPending('c1');
    expect(r.chatId).toBe('c1');
    expect(r.question).toBe('q');
    expect(r.options).toEqual(['a', 'b']);
    expect(r.awaitingSince).toBeGreaterThan(0);
    m.cancel('c1');
    await p.catch(() => {});
  });

  test('listPending retorna todos los chats con suspended', async () => {
    const m = new SuspendedPromptsManager();
    const p1 = m.suspend({ chatId: 'c1', question: 'q1', timeoutMs: 1000 });
    const p2 = m.suspend({ chatId: 'c2', question: 'q2', timeoutMs: 1000 });
    p1.catch(() => {}); p2.catch(() => {});
    expect(m.listPending()).toHaveLength(2);
    m.cancel('c1'); m.cancel('c2');
    await p1.catch(() => {}); await p2.catch(() => {});
  });

  test('emite loop:suspended en eventBus al suspender', async () => {
    const bus = new EventEmitter();
    const m = new SuspendedPromptsManager({ eventBus: bus });
    const received = [];
    bus.on('loop:suspended', (p) => received.push(p));
    const p = m.suspend({ chatId: 'c1', question: 'q', timeoutMs: 1000 });
    p.catch(() => {});
    expect(received).toHaveLength(1);
    expect(received[0].chatId).toBe('c1');
    m.cancel('c1');
    await p.catch(() => {});
  });

  test('emite loop:resumed al resume', async () => {
    const bus = new EventEmitter();
    const m = new SuspendedPromptsManager({ eventBus: bus });
    const received = [];
    bus.on('loop:resumed', (p) => received.push(p));
    const p = m.suspend({ chatId: 'c1', question: 'q', timeoutMs: 1000 });
    m.resume('c1', 'x');
    await p;
    expect(received).toHaveLength(1);
  });

  test('emite loop:suspended_timeout al expirar', async () => {
    const bus = new EventEmitter();
    const m = new SuspendedPromptsManager({ eventBus: bus });
    const received = [];
    bus.on('loop:suspended_timeout', (p) => received.push(p));
    await m.suspend({ chatId: 'c1', question: 'q', timeoutMs: 20 }).catch(() => {});
    expect(received).toHaveLength(1);
  });
});
