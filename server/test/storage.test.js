'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const Database               = require('../storage/sqlite-wrapper');
const DatabaseProvider       = require('../storage/DatabaseProvider');
const ChatSettingsRepository = require('../storage/ChatSettingsRepository');
const BotsRepository         = require('../storage/BotsRepository');

// Inicializar sql.js WASM antes de todos los tests
beforeAll(async () => {
  await Database.initialize();
});

// ── DatabaseProvider ──────────────────────────────────────────────────────────

describe('DatabaseProvider', () => {
  test('lanza error si no se pasa dbPath', () => {
    expect(() => new DatabaseProvider()).toThrow(/dbPath es requerido/);
  });

  test('getDB() retorna null antes de init()', () => {
    const dp = new DatabaseProvider(':memory:');
    expect(dp.getDB()).toBeNull();
  });

  test('init() crea la DB y la retorna', () => {
    const dp = new DatabaseProvider(':memory:');
    const db = dp.init('');
    expect(db).toBeTruthy();
    expect(dp.getDB()).toBe(db);
  });

  test('init() es idempotente — segunda llamada devuelve misma instancia', () => {
    const dp = new DatabaseProvider(':memory:');
    const db1 = dp.init('');
    const db2 = dp.init('');
    expect(db1).toBe(db2);
  });

  test('ejecuta el schema SQL en init()', () => {
    const dp = new DatabaseProvider(':memory:');
    const db = dp.init('CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY)');
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t1'").get();
    expect(row).toBeTruthy();
  });
});

// ── ChatSettingsRepository ────────────────────────────────────────────────────

describe('ChatSettingsRepository', () => {
  function makeRepo() {
    const dp = new DatabaseProvider(':memory:');
    const db = dp.init(ChatSettingsRepository.SCHEMA);
    const repo = new ChatSettingsRepository(db);
    repo.init();
    return repo;
  }

  test('load() retorna null cuando no hay datos', () => {
    const repo = makeRepo();
    expect(repo.load('bot1', 'chat1')).toBeNull();
  });

  test('save() luego load() devuelve los settings guardados', () => {
    const repo = makeRepo();
    repo.save('bot1', 'chat1', { provider: 'gemini', model: 'gemini-2.0-flash' });
    const result = repo.load('bot1', 'chat1');
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-2.0-flash');
  });

  test('save() hace UPSERT — actualiza si ya existe', () => {
    const repo = makeRepo();
    repo.save('bot1', 'chat1', { provider: 'anthropic', model: null });
    repo.save('bot1', 'chat1', { provider: 'openai',    model: 'gpt-4o' });
    const result = repo.load('bot1', 'chat1');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
  });

  test('settings de bots distintos son independientes', () => {
    const repo = makeRepo();
    repo.save('botA', '100', { provider: 'gemini' });
    repo.save('botB', '100', { provider: 'anthropic' });
    expect(repo.load('botA', '100').provider).toBe('gemini');
    expect(repo.load('botB', '100').provider).toBe('anthropic');
  });

  test('load() con chat_id desconocido retorna null', () => {
    const repo = makeRepo();
    repo.save('bot1', '111', { provider: 'gemini' });
    expect(repo.load('bot1', '999')).toBeNull();
  });

  test('con db=null, load() retorna null sin lanzar', () => {
    const repo = new ChatSettingsRepository(null);
    expect(repo.load('x', 'y')).toBeNull();
  });

  test('con db=null, save() no lanza', () => {
    const repo = new ChatSettingsRepository(null);
    expect(() => repo.save('x', 'y', { provider: 'gemini' })).not.toThrow();
  });
});

// ── BotsRepository ────────────────────────────────────────────────────────────

describe('BotsRepository', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bots-'));
    // Limpiar env vars para tests de BOT_TOKEN
    delete process.env.BOT_TOKEN;
    delete process.env.BOT_KEY;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.BOT_TOKEN;
    delete process.env.BOT_KEY;
  });

  test('read() retorna [] si no existe el archivo y no hay BOT_TOKEN', () => {
    const repo = new BotsRepository(path.join(dir, 'bots.json'));
    expect(repo.read()).toEqual([]);
  });

  test('save() escribe el archivo; read() lo recupera', () => {
    const filePath = path.join(dir, 'bots.json');
    const repo = new BotsRepository(filePath);
    const bots = [{ key: 'test', token: 'abc123', whitelist: [] }];
    repo.save(bots);
    expect(repo.read()).toEqual(bots);
  });

  test('read() con JSON inválido retorna []', () => {
    const filePath = path.join(dir, 'invalid.json');
    fs.writeFileSync(filePath, 'not valid json', 'utf8');
    const repo = new BotsRepository(filePath);
    expect(repo.read()).toEqual([]);
  });

  test('read() crea bots.json desde BOT_TOKEN si no existe el archivo', () => {
    const filePath = path.join(dir, 'from-env.json');
    process.env.BOT_TOKEN = 'envtoken123';
    process.env.BOT_KEY   = 'envbot';
    const repo = new BotsRepository(filePath);
    const bots = repo.read();
    expect(bots).toHaveLength(1);
    expect(bots[0].token).toBe('envtoken123');
    expect(bots[0].key).toBe('envbot');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('save() sobreescribe el archivo con la nueva lista', () => {
    const filePath = path.join(dir, 'bots.json');
    const repo = new BotsRepository(filePath);
    repo.save([{ key: 'a' }]);
    repo.save([{ key: 'b' }, { key: 'c' }]);
    const bots = repo.read();
    expect(bots).toHaveLength(2);
    expect(bots[0].key).toBe('b');
  });
});
