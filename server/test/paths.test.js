'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('paths.js (Tauri packaging)', () => {
  const serverDir = path.resolve(__dirname, '..');

  afterEach(() => {
    jest.resetModules();
    delete process.env.CLAWMINT_DATA_DIR;
    delete process.env.CLAWMINT_RESOURCES_DIR;
  });

  test('dev mode (sin env): paths relativos a server/ como legacy', () => {
    delete process.env.CLAWMINT_DATA_DIR;
    delete process.env.CLAWMINT_RESOURCES_DIR;
    const p = require('../paths');
    expect(p.isPackaged).toBe(false);
    expect(p.CONFIG_DIR).toBe(serverDir);
    expect(p.DATA_DIR).toBe(serverDir);
    expect(p.MEMORY_DIR).toBe(path.join(serverDir, 'memory'));
    expect(p.LOG_DIR).toBe(serverDir);
    expect(p.MODELS_DIR).toBe(path.join(serverDir, 'models-cache'));
    expect(p.RESOURCES_DIR).toBe(path.resolve(serverDir, '..'));
  });

  test('packaged: CLAWMINT_DATA_DIR particiona en subdirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
    process.env.CLAWMINT_DATA_DIR = tmp;
    const p = require('../paths');
    expect(p.isPackaged).toBe(true);
    expect(p.CONFIG_DIR).toBe(path.join(tmp, 'config'));
    expect(p.DATA_DIR).toBe(path.join(tmp, 'data'));
    expect(p.MEMORY_DIR).toBe(path.join(tmp, 'data', 'memory'));
    expect(p.LOG_DIR).toBe(path.join(tmp, 'logs'));
    expect(p.MODELS_DIR).toBe(path.join(tmp, 'models'));
    // RESOURCES_DIR cae a dataRoot si CLAWMINT_RESOURCES_DIR no setea
    expect(p.RESOURCES_DIR).toBe(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('packaged con RESOURCES_DIR explícito: respeta la variable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-res-'));
    process.env.CLAWMINT_DATA_DIR = tmp;
    process.env.CLAWMINT_RESOURCES_DIR = resources;
    const p = require('../paths');
    expect(p.RESOURCES_DIR).toBe(resources);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
  });

  test('CONFIG_FILES referencia archivos dentro de CONFIG_DIR', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
    process.env.CLAWMINT_DATA_DIR = tmp;
    const p = require('../paths');
    expect(p.CONFIG_FILES.bots).toBe(path.join(p.CONFIG_DIR, 'bots.json'));
    expect(p.CONFIG_FILES.agents).toBe(path.join(p.CONFIG_DIR, 'agents.json'));
    expect(p.CONFIG_FILES.tokenMasterKey).toBe(path.join(p.CONFIG_DIR, '.token-master.key'));
    expect(p.DATA_FILES.memoryDb).toBe(path.join(p.MEMORY_DIR, 'index.db'));
    expect(p.LOG_FILES.serverLog).toBe(path.join(p.LOG_DIR, 'server.log'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('ensureDirs crea los dirs faltantes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-ensure-'));
    // Borrar para forzar creación
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.CLAWMINT_DATA_DIR = tmp;
    const p = require('../paths');
    expect(fs.existsSync(p.CONFIG_DIR)).toBe(false);
    p.ensureDirs();
    expect(fs.existsSync(p.CONFIG_DIR)).toBe(true);
    expect(fs.existsSync(p.DATA_DIR)).toBe(true);
    expect(fs.existsSync(p.MEMORY_DIR)).toBe(true);
    expect(fs.existsSync(p.LOG_DIR)).toBe(true);
    expect(fs.existsSync(p.MODELS_DIR)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('ensureDirs es idempotente (segunda llamada no falla)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-idem-'));
    process.env.CLAWMINT_DATA_DIR = tmp;
    const p = require('../paths');
    expect(() => { p.ensureDirs(); p.ensureDirs(); }).not.toThrow();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
