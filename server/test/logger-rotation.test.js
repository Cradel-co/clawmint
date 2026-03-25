'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Logger = require('../core/Logger');

describe('Logger rotation', () => {
  let dir, logger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-logrot-'));
    logger = new Logger({
      logFile:    path.join(dir, 'test.log'),
      configFile: path.join(dir, 'cfg.json'),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('escribe al archivo de log', () => {
    logger.info('test message');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('test message');
  });

  test('_rotate no crashea con archivo pequeño', () => {
    logger.info('small');
    expect(() => logger._rotate()).not.toThrow();
    // No debería rotar (archivo < 50MB)
    expect(fs.existsSync(path.join(dir, 'test.log.1'))).toBe(false);
  });

  test('_rotate no crashea si archivo no existe', () => {
    const logPath = path.join(dir, 'test.log');
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    expect(() => logger._rotate()).not.toThrow();
  });

  test('_logCount se incrementa', () => {
    expect(logger._logCount).toBe(0);
    logger.info('one');
    expect(logger._logCount).toBe(1);
    logger.info('two');
    expect(logger._logCount).toBe(2);
  });

  test('config enabled controla logging', () => {
    logger.info('init'); // crear archivo primero
    logger.setConfig({ enabled: false });
    logger.info('should not appear');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).not.toContain('should not appear');
  });

  test('errors siempre se loguean aunque enabled=false', () => {
    logger.setConfig({ enabled: false });
    logger.error('critical error');
    const content = fs.readFileSync(path.join(dir, 'test.log'), 'utf8');
    expect(content).toContain('critical error');
  });
});
