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

// ── BotsRepository (ahora SQLite-backed) ──────────────────────────────────────

describe('BotsRepository', () => {
  let dir, db, jsonPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bots-'));
    jsonPath = path.join(dir, 'bots.json'); // no existe → no hay migración
    db = new Database(path.join(dir, 'bots.db'));
    delete process.env.BOT_TOKEN;
    delete process.env.BOT_KEY;
  });

  afterEach(() => {
    try { db.close?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.BOT_TOKEN;
    delete process.env.BOT_KEY;
  });

  test('read() retorna [] si la DB está vacía y no hay BOT_TOKEN', () => {
    const repo = new BotsRepository(db, jsonPath);
    repo.init();
    expect(repo.read()).toEqual([]);
  });

  test('save() persiste en DB; read() lo recupera', () => {
    const repo = new BotsRepository(db, jsonPath);
    repo.init();
    const bots = [{ key: 'test', token: 'abc123', whitelist: [] }];
    repo.save(bots);
    const read = repo.read();
    expect(read).toHaveLength(1);
    expect(read[0].key).toBe('test');
    expect(read[0].token).toBe('abc123');
  });

  test('read() con bots.json inválido no rompe init() ni read()', () => {
    fs.writeFileSync(jsonPath, 'not valid json', 'utf8');
    const repo = new BotsRepository(db, jsonPath);
    repo.init(); // no debería throwear aunque bots.json sea basura
    expect(repo.read()).toEqual([]);
  });

  test('read() crea bot desde BOT_TOKEN si la DB está vacía', () => {
    process.env.BOT_TOKEN = 'envtoken123';
    process.env.BOT_KEY   = 'envbot';
    const repo = new BotsRepository(db, jsonPath);
    repo.init();
    const bots = repo.read();
    expect(bots).toHaveLength(1);
    expect(bots[0].token).toBe('envtoken123');
    expect(bots[0].key).toBe('envbot');
  });

  test('save() es upsert: agrega nuevos y actualiza existentes por key', () => {
    const repo = new BotsRepository(db, jsonPath);
    repo.init();
    repo.save([{ key: 'a', token: 't1' }]);
    repo.save([{ key: 'a', token: 't1-updated' }, { key: 'b', token: 't2' }]);
    const bots = repo.read();
    expect(bots).toHaveLength(2);
    const a = bots.find(b => b.key === 'a');
    expect(a.token).toBe('t1-updated');
  });
});
