'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const Logger = require('../core/Logger');

describe('Logger event emission (D.6)', () => {
  let tmp, logFile, configFile;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-ev-'));
    logFile = path.join(tmp, 'server.log');
    configFile = path.join(tmp, 'logs.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('Logger emite "line" en cada info/warn/error', () => {
    const l = new Logger({ logFile, configFile });
    const events = [];
    l.on('line', (ev) => events.push(ev));
    l.info('hello', 'world');
    l.warn('carefull');
    l.error('boom');
    expect(events).toHaveLength(3);
    expect(events[0].level).toBe('INFO');
    expect(events[0].message).toBe('hello world');
    expect(events[1].level).toBe('WARN');
    expect(events[2].level).toBe('ERROR');
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('Logger disabled + no error → no emite', () => {
    const l = new Logger({ logFile, configFile });
    l.setConfig({ enabled: false });
    const events = [];
    l.on('line', (ev) => events.push(ev));
    l.info('ignored');
    l.warn('also ignored');
    expect(events).toHaveLength(0);
  });

  test('Logger disabled pero error → sí emite (errores no se silencian)', () => {
    const l = new Logger({ logFile, configFile });
    l.setConfig({ enabled: false });
    const events = [];
    l.on('line', (ev) => events.push(ev));
    l.error('critical');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('ERROR');
  });

  test('off() remueve el listener', () => {
    const l = new Logger({ logFile, configFile });
    const events = [];
    const handler = (ev) => events.push(ev);
    l.on('line', handler);
    l.info('primera');
    l.off('line', handler);
    l.info('segunda');
    expect(events).toHaveLength(1);
  });

  test('setMaxListeners permite muchos suscriptores', () => {
    const l = new Logger({ logFile, configFile });
    expect(l.getMaxListeners()).toBeGreaterThanOrEqual(50);
  });
});
