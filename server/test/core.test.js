'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const Logger  = require('../core/Logger');
const EventBus = require('../core/EventBus');

// ── Logger ────────────────────────────────────────────────────────────────────

describe('Logger', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-logger-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make() {
    return new Logger({
      logFile:    path.join(dir, 'test.log'),
      configFile: path.join(dir, 'cfg.json'),
    });
  }

  test('crea archivo de config si no existe', () => {
    const cfgFile = path.join(dir, 'new-cfg.json');
    new Logger({ logFile: path.join(dir, 'x.log'), configFile: cfgFile });
    expect(fs.existsSync(cfgFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    expect(cfg.enabled).toBe(true);
  });

  test('info escribe línea con nivel INFO', () => {
    const logger = make();
    logger.info('hola mundo');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('[INFO ');
    expect(content).toContain('hola mundo');
  });

  test('warn escribe línea con nivel WARN', () => {
    const logger = make();
    logger.warn('advertencia');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('[WARN ');
    expect(content).toContain('advertencia');
  });

  test('error escribe aunque logging esté desactivado', () => {
    const logger = make();
    logger.setConfig({ enabled: false });
    logger.error('error crítico');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('[ERROR]');
    expect(content).toContain('error crítico');
  });

  test('setConfig(enabled:false) silencia info/warn', () => {
    const logger = make();
    logger.setConfig({ enabled: false });
    logger.info('silenciado');
    const content = fs.existsSync(path.join(dir, 'test.log'))
      ? fs.readFileSync(path.join(dir, 'test.log'), 'utf8') : '';
    // El archivo puede no existir o no contener el mensaje
    const infoLines = content.split('\n').filter(l => l.includes('[INFO '));
    expect(infoLines.length).toBe(0);
  });

  test('tail retorna las últimas N líneas', () => {
    const logger = make();
    logger.info('l1');
    logger.info('l2');
    logger.info('l3');
    const lines = logger.tail(2);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('l3');
  });

  test('clear vacía el archivo de log', () => {
    const logger = make();
    logger.info('antes del clear');
    logger.clear();
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toBe('');
  });

  test('getConfig retorna objeto con enabled', () => {
    const logger = make();
    const cfg = logger.getConfig();
    expect(cfg).toHaveProperty('enabled');
  });

  test('objetos son serializados como JSON en el log', () => {
    const logger = make();
    logger.info({ key: 'value' });
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('"key"');
    expect(content).toContain('"value"');
  });
});

// ── EventBus ──────────────────────────────────────────────────────────────────

describe('EventBus', () => {
  test('extiende EventEmitter — on/emit funcionan', () => {
    const bus = new EventBus();
    let received = null;
    bus.on('test', (val) => { received = val; });
    bus.emit('test', 42);
    expect(received).toBe(42);
  });

  test('múltiples listeners en el mismo evento', () => {
    const bus = new EventBus();
    const calls = [];
    bus.on('msg', (v) => calls.push('a' + v));
    bus.on('msg', (v) => calls.push('b' + v));
    bus.emit('msg', 1);
    expect(calls).toEqual(['a1', 'b1']);
  });

  test('once ejecuta el listener una sola vez', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('evt', () => count++);
    bus.emit('evt');
    bus.emit('evt');
    expect(count).toBe(1);
  });

  test('off elimina el listener', () => {
    const bus = new EventBus();
    let count = 0;
    const fn = () => count++;
    bus.on('e', fn);
    bus.emit('e');
    bus.off('e', fn);
    bus.emit('e');
    expect(count).toBe(1);
  });

  test('instancias son independientes entre sí', () => {
    const a = new EventBus();
    const b = new EventBus();
    let received = 0;
    a.on('x', () => received++);
    b.emit('x');
    expect(received).toBe(0);
  });
});
