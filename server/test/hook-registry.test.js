'use strict';

const EventBus     = require('../core/EventBus');
const HookRegistry = require('../core/HookRegistry');

// Executor dummy que devuelve lo que le dice el hook via handlerRef (función directa)
const FN_EXECUTOR = {
  async execute(hook, payload, opts) {
    const fn = hook.handlerRef;
    if (typeof fn !== 'function') throw new Error('handlerRef debe ser función');
    return fn(payload, opts);
  },
};

function newRegistry(enabled = true) {
  const bus = new EventBus();
  const reg = new HookRegistry({ eventBus: bus, enabled, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  reg.registerExecutor('fn', FN_EXECUTOR);
  return { bus, reg };
}

describe('HookRegistry — executors', () => {
  test('throw si handlerType no tiene executor', () => {
    const { reg } = newRegistry();
    expect(() => reg.register({ event: 'pre_tool_use', handlerType: 'xxx', handlerRef: () => {} }))
      .toThrow(/executor.*no registrado/);
  });

  test('registerExecutor valida interface', () => {
    const { reg } = newRegistry();
    expect(() => reg.registerExecutor('bad', {})).toThrow(/\.execute/);
    expect(() => reg.registerExecutor('', FN_EXECUTOR)).toThrow(/type/);
  });

  test('listExecutorTypes', () => {
    const { reg } = newRegistry();
    expect(reg.listExecutorTypes()).toContain('fn');
  });
});

describe('HookRegistry — hasActiveHooks (Fase 7.5.9)', () => {
  test('registry vacío → false', () => {
    const { reg } = newRegistry(true);
    expect(reg.hasActiveHooks({})).toBe(false);
  });

  test('enabled=false → false aunque haya hooks', () => {
    const { reg } = newRegistry(false);
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => null });
    expect(reg.hasActiveHooks({})).toBe(false);
  });

  test('hook global + registry enabled → true', () => {
    const { reg } = newRegistry(true);
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => null });
    expect(reg.hasActiveHooks({})).toBe(true);
  });

  test('hook scope=chat no aplica si chatId no matchea', () => {
    const { reg } = newRegistry(true);
    reg.register({ event: 'pre_tool_use', scopeType: 'chat', scopeId: 'c1', handlerType: 'fn', handlerRef: () => null });
    expect(reg.hasActiveHooks({ chatId: 'c2' })).toBe(false);
    expect(reg.hasActiveHooks({ chatId: 'c1' })).toBe(true);
  });

  test('hook disabled → no cuenta', () => {
    const { reg } = newRegistry(true);
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => null, enabled: false });
    expect(reg.hasActiveHooks({})).toBe(false);
  });
});

describe('HookRegistry — registration', () => {
  test('register/unregister', () => {
    const { reg } = newRegistry();
    const id = reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => null });
    expect(id).toMatch(/^hook-/);
    expect(reg.unregister(id)).toBe(true);
    expect(reg.unregister('unknown')).toBe(false);
  });

  test('register throw en event inválido', () => {
    const { reg } = newRegistry();
    expect(() => reg.register({ event: 'fake', handlerType: 'fn', handlerRef: () => {} })).toThrow(/event inválido/);
  });

  test('clear limpia todo', () => {
    const { reg } = newRegistry();
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => {} });
    reg.register({ event: 'post_tool_use', handlerType: 'fn', handlerRef: () => {} });
    reg.clear();
    expect(reg.listForEvent('pre_tool_use')).toHaveLength(0);
  });
});

describe('HookRegistry — flag enabled', () => {
  test('enabled=false → emit no invoca handlers', async () => {
    const calls = [];
    const { reg } = newRegistry(false);
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { calls.push('x'); return null; } });
    const r = await reg.emit('pre_tool_use', { name: 'bash', args: {} });
    expect(r.block).toBe(false);
    expect(r.args).toEqual({});
    expect(calls).toHaveLength(0);
  });

  test('enabled=true → invoca handlers', async () => {
    const calls = [];
    const { reg } = newRegistry(true);
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { calls.push('x'); return null; } });
    await reg.emit('pre_tool_use', { name: 'bash', args: {} });
    expect(calls).toHaveLength(1);
  });

  test('setEnabled toggleable en runtime', async () => {
    const { reg } = newRegistry(false);
    const calls = [];
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { calls.push('x'); return null; } });
    await reg.emit('pre_tool_use', { args: {} });
    expect(calls).toHaveLength(0);
    reg.setEnabled(true);
    await reg.emit('pre_tool_use', { args: {} });
    expect(calls).toHaveLength(1);
  });
});

describe('HookRegistry — block', () => {
  test('handler que retorna { block: reason } aborta y propaga', async () => {
    const { reg } = newRegistry();
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => ({ block: 'por seguridad' }) });
    const r = await reg.emit('pre_tool_use', { name: 'bash', args: {} });
    expect(r.block).toBe('por seguridad');
  });

  test('block emite hook:blocked al eventBus', async () => {
    const { reg, bus } = newRegistry();
    const events = [];
    bus.on('hook:blocked', (p) => events.push(p));
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => ({ block: 'x' }) });
    await reg.emit('pre_tool_use', { args: {} });
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('x');
  });

  test('handler después del bloqueado NO se invoca', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { called.push('a'); return { block: 'no' }; }, priority: 100 });
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { called.push('b'); return null; }, priority: 50 });
    await reg.emit('pre_tool_use', { args: {} });
    expect(called).toEqual(['a']);
  });
});

describe('HookRegistry — replace args', () => {
  test('scope=global puede mutar args con replace', async () => {
    const { reg } = newRegistry();
    reg.register({
      event: 'pre_tool_use', scopeType: 'global',
      handlerType: 'fn',
      handlerRef: () => ({ replace: { args: { sanitized: true } } }),
    });
    const r = await reg.emit('pre_tool_use', { args: { raw: 'evil' } });
    expect(r.args).toEqual({ sanitized: true });
  });

  test('scope=chat NO puede mutar (ignorado + warning)', async () => {
    const { reg } = newRegistry();
    reg.register({
      event: 'pre_tool_use', scopeType: 'chat', scopeId: 'c1',
      handlerType: 'fn',
      handlerRef: () => ({ replace: { args: { hacked: true } } }),
    });
    const r = await reg.emit('pre_tool_use', { args: { raw: true } }, { chatId: 'c1' });
    expect(r.args).toEqual({ raw: true });
  });

  test('replace args propagados al siguiente handler', async () => {
    const { reg } = newRegistry();
    reg.register({
      event: 'pre_tool_use', scopeType: 'user', scopeId: 'u1', priority: 100,
      handlerType: 'fn',
      handlerRef: () => ({ replace: { args: { step1: true } } }),
    });
    let observed = null;
    reg.register({
      event: 'pre_tool_use', scopeType: 'user', scopeId: 'u1', priority: 50,
      handlerType: 'fn',
      handlerRef: (payload) => { observed = payload.args; return null; },
    });
    await reg.emit('pre_tool_use', { args: { raw: true } }, { userId: 'u1' });
    expect(observed).toEqual({ step1: true });
  });
});

describe('HookRegistry — scopes y prioridad', () => {
  test('scope global corre para cualquier ctx', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', handlerType: 'fn', handlerRef: () => { called.push('g'); return null; } });
    await reg.emit('pre_tool_use', { args: {} }, {});
    expect(called).toEqual(['g']);
  });

  test('scope chat solo corre si chatId matchea', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', scopeType: 'chat', scopeId: 'c1', handlerType: 'fn', handlerRef: () => { called.push('c1'); return null; } });
    reg.register({ event: 'pre_tool_use', scopeType: 'chat', scopeId: 'c2', handlerType: 'fn', handlerRef: () => { called.push('c2'); return null; } });
    await reg.emit('pre_tool_use', { args: {} }, { chatId: 'c1' });
    expect(called).toEqual(['c1']);
  });

  test('chat corre antes que global (más específico primero)', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', scopeType: 'global',                 handlerType: 'fn', handlerRef: () => { called.push('g'); return null; } });
    reg.register({ event: 'pre_tool_use', scopeType: 'chat', scopeId: 'c1',    handlerType: 'fn', handlerRef: () => { called.push('c'); return null; } });
    await reg.emit('pre_tool_use', { args: {} }, { chatId: 'c1' });
    expect(called).toEqual(['c', 'g']);
  });

  test('priority order dentro del mismo scope (desc)', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', priority: 10,  handlerType: 'fn', handlerRef: () => { called.push('low');  return null; } });
    reg.register({ event: 'pre_tool_use', priority: 100, handlerType: 'fn', handlerRef: () => { called.push('high'); return null; } });
    reg.register({ event: 'pre_tool_use', priority: 50,  handlerType: 'fn', handlerRef: () => { called.push('mid');  return null; } });
    await reg.emit('pre_tool_use', { args: {} });
    expect(called).toEqual(['high', 'mid', 'low']);
  });
});

describe('HookRegistry — chat.params (Ajuste 6.6)', () => {
  test('replace.params reemplaza completamente el objeto params', async () => {
    // Semántica: replace es reemplazo completo, no merge dentro.
    // Si un handler quiere preservar subcampos, debe incluirlos en su replace.
    const { reg } = newRegistry();
    reg.register({
      event: 'chat.params', scopeType: 'user', scopeId: 'u1',
      handlerType: 'fn',
      handlerRef: (p) => ({ replace: { params: { ...p.params, temperature: 0.1, maxTokens: 2000 } } }),
    });
    const r = await reg.emit('chat.params',
      { params: { temperature: 0.7, maxTokens: 4000, topP: 1 } },
      { userId: 'u1' }
    );
    expect(r.params).toEqual({ temperature: 0.1, maxTokens: 2000, topP: 1 });
  });

  test('replace.params en scope chat es ignorado (solo global|user)', async () => {
    const { reg } = newRegistry();
    reg.register({
      event: 'chat.params', scopeType: 'chat', scopeId: 'c1',
      handlerType: 'fn',
      handlerRef: () => ({ replace: { params: { temperature: 0 } } }),
    });
    const r = await reg.emit('chat.params',
      { params: { temperature: 0.7 } },
      { chatId: 'c1' }
    );
    expect(r.params).toEqual({ temperature: 0.7 });
  });

  test('block en chat.params aborta el turn', async () => {
    const { reg } = newRegistry();
    reg.register({
      event: 'chat.params',
      handlerType: 'fn',
      handlerRef: () => ({ block: 'demasiados tokens gastados hoy' }),
    });
    const r = await reg.emit('chat.params', { params: { temperature: 0.7 } });
    expect(r.block).toBe('demasiados tokens gastados hoy');
  });
});

describe('HookRegistry — error handling', () => {
  test('handler throwea → continúa cadena + emite hook:error', async () => {
    const { reg, bus } = newRegistry();
    const called = [];
    const errors = [];
    bus.on('hook:error', (p) => errors.push(p));
    reg.register({ event: 'pre_tool_use', priority: 100, handlerType: 'fn', handlerRef: () => { throw new Error('boom'); } });
    reg.register({ event: 'pre_tool_use', priority: 50,  handlerType: 'fn', handlerRef: () => { called.push('b'); return null; } });
    await reg.emit('pre_tool_use', { args: {} });
    expect(called).toEqual(['b']);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('boom');
  });

  test('handler que toma más que timeoutMs → timeout + continúa', async () => {
    const { reg, bus } = newRegistry();
    const errors = [];
    bus.on('hook:error', (p) => errors.push(p));
    reg.register({
      event: 'pre_tool_use', timeoutMs: 50,
      handlerType: 'fn',
      handlerRef: () => new Promise(r => setTimeout(r, 200)),
    });
    const called = [];
    reg.register({ event: 'pre_tool_use', priority: 0, handlerType: 'fn', handlerRef: () => { called.push('x'); return null; } });
    await reg.emit('pre_tool_use', { args: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/timeout/);
    expect(called).toEqual(['x']);
  });

  test('disabled=false hook no se invoca', async () => {
    const { reg } = newRegistry();
    const called = [];
    reg.register({ event: 'pre_tool_use', enabled: false, handlerType: 'fn', handlerRef: () => { called.push('x'); return null; } });
    await reg.emit('pre_tool_use', { args: {} });
    expect(called).toHaveLength(0);
  });
});
