'use strict';

const StructuredLogger = require('../core/StructuredLogger');

function mockLogger() {
  const lines = [];
  return {
    info: (...a) => lines.push({ level: 'info', args: a }),
    warn: (...a) => lines.push({ level: 'warn', args: a }),
    error: (...a) => lines.push({ level: 'error', args: a }),
    lines,
  };
}

describe('StructuredLogger — construcción', () => {
  test('throw si logger base no tiene .info()', () => {
    expect(() => new StructuredLogger({})).toThrow(/logger/);
    expect(() => new StructuredLogger({ logger: {} })).toThrow(/\.info/);
  });

  test('construye OK con logger válido', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log });
    expect(s).toBeTruthy();
  });
});

describe('StructuredLogger — formato texto (default)', () => {
  test('info escribe mensaje simple', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, format: 'text' });
    s.info('hola');
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0].level).toBe('info');
    expect(log.lines[0].args[0]).toBe('hola');
  });

  test('info con extra → kv appended', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, format: 'text' });
    s.info('mensaje', { chatId: 'c1', count: 3 });
    expect(log.lines[0].args[0]).toMatch(/mensaje.*chatId=c1.*count=3/);
  });

  test('child() hereda contexto en el output', () => {
    const log = mockLogger();
    const root = new StructuredLogger({ logger: log, format: 'text' });
    const child = root.child({ userId: 'u1' });
    child.info('test');
    expect(log.lines[0].args[0]).toMatch(/test.*userId=u1/);
  });

  test('warn y error usan el canal correcto', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, format: 'text' });
    s.warn('w');
    s.error('e');
    expect(log.lines[0].level).toBe('warn');
    expect(log.lines[1].level).toBe('error');
  });
});

describe('StructuredLogger — formato JSON', () => {
  test('info emite JSON con ts, level, msg, context', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, format: 'json', context: { service: 'test' } });
    s.info('hola mundo', { foo: 'bar' });
    const parsed = JSON.parse(log.lines[0].args[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hola mundo');
    expect(parsed.service).toBe('test');
    expect(parsed.foo).toBe('bar');
    expect(parsed.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('child() merge de contexto en JSON', () => {
    const log = mockLogger();
    const root = new StructuredLogger({ logger: log, format: 'json', context: { app: 'srv' } });
    const c1 = root.child({ userId: 'u1' });
    const c2 = c1.child({ chatId: 'c1' });
    c2.info('deep');
    const p = JSON.parse(log.lines[0].args[0]);
    expect(p.app).toBe('srv');
    expect(p.userId).toBe('u1');
    expect(p.chatId).toBe('c1');
  });

  test('withCorrelationId agrega correlationId', () => {
    const log = mockLogger();
    const root = new StructuredLogger({ logger: log, format: 'json' });
    const req = root.withCorrelationId('req-42');
    req.info('handled');
    const p = JSON.parse(log.lines[0].args[0]);
    expect(p.correlationId).toBe('req-42');
  });

  test('objetos con circular refs no crashean', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, format: 'json' });
    const circular = { x: 1 };
    circular.self = circular;
    expect(() => s.info('mensaje', circular)).not.toThrow();
  });
});

describe('StructuredLogger — contexto inmutable', () => {
  test('context retornado está frozen', () => {
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log, context: { a: 1 } });
    expect(Object.isFrozen(s.context)).toBe(true);
  });

  test('child() no muta el padre', () => {
    const log = mockLogger();
    const root = new StructuredLogger({ logger: log, context: { a: 1 } });
    const child = root.child({ b: 2 });
    expect(root.context).toEqual({ a: 1 });
    expect(child.context).toEqual({ a: 1, b: 2 });
  });
});

describe('StructuredLogger — debug level', () => {
  test('debug omitido si DEBUG != 1', () => {
    const orig = process.env.DEBUG;
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log });
    s.debug('silent');
    expect(log.lines).toHaveLength(0);
    if (orig !== undefined) process.env.DEBUG = orig;
  });

  test('debug emitido si DEBUG=1', () => {
    const orig = process.env.DEBUG;
    process.env.DEBUG = '1';
    const log = mockLogger();
    const s = new StructuredLogger({ logger: log });
    s.debug('chatty');
    expect(log.lines).toHaveLength(1);
    if (orig === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = orig;
  });
});
