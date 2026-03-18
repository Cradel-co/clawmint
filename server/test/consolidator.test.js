'use strict';

/**
 * Tests de memory-consolidator.js
 *
 * - enqueue/getStats usan una DB SQLite in-memory inyectada
 * - addTopic escribe en server/memory/<agent>/ (se limpia en afterAll)
 * - processQueue mocka child_process.spawn para simular la respuesta de claude
 */

const fs          = require('fs');
const path        = require('path');
const Database    = require('../storage/sqlite-wrapper');
const memory      = require('../memory');
const consolidator = require('../memory-consolidator');

// ── Setup DB (sql.js requiere init async) ─────────────────────────────────────

let TEST_DB;
const AGENT     = '__test_consol_' + Date.now() + '__';
let AGENT_DIR;

beforeAll(async () => {
  await Database.initialize();
  TEST_DB = new Database(':memory:');
  TEST_DB.pragma('journal_mode = WAL');
  TEST_DB.pragma('foreign_keys = ON');
  TEST_DB.exec(memory.DB_SCHEMA);
  memory.setDB(TEST_DB);
  AGENT_DIR = path.join(memory.MEMORY_DIR, AGENT);
  consolidator.init(TEST_DB);
});

afterAll(() => {
  memory.setDB(null);
  TEST_DB.close();
  if (fs.existsSync(AGENT_DIR)) fs.rmSync(AGENT_DIR, { recursive: true, force: true });
});

// ── enqueue ───────────────────────────────────────────────────────────────────

describe('enqueue()', () => {
  afterEach(() => {
    // Limpiar la cola entre tests
    TEST_DB.prepare("DELETE FROM consolidation_queue WHERE agent_key = ?").run(AGENT);
  });

  test('inserta un ítem en la cola con status=pending', () => {
    const turns = [{ text: 'recuerda que me llamo Juan', types: ['personal'], ts: Date.now() }];
    consolidator.enqueue(AGENT, '12345', turns, 'signal');
    const row = TEST_DB.prepare(
      "SELECT * FROM consolidation_queue WHERE agent_key = ? AND status = 'pending'"
    ).get(AGENT);
    expect(row).toBeTruthy();
    expect(row.agent_key).toBe(AGENT);
    expect(row.chat_id).toBe('12345');
    expect(row.source).toBe('signal');
    const parsed = JSON.parse(row.turns);
    expect(parsed[0].text).toContain('Juan');
  });

  test('con turns vacío no inserta nada', () => {
    consolidator.enqueue(AGENT, '12345', [], 'signal');
    const count = TEST_DB.prepare(
      "SELECT COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ?"
    ).get(AGENT).cnt;
    expect(count).toBe(0);
  });

  test('sin DB no lanza error', () => {
    memory.setDB(null);
    expect(() => consolidator.enqueue(AGENT, '1', [{ text: 'test', types: [], ts: 0 }])).not.toThrow();
    memory.setDB(TEST_DB);
  });

  test('enqueue con source=session_end guarda el source correcto', () => {
    const turns = [{ text: 'fin de sesión', types: [], ts: Date.now() }];
    consolidator.enqueue(AGENT, '999', turns, 'session_end');
    const row = TEST_DB.prepare(
      "SELECT source FROM consolidation_queue WHERE agent_key = ? ORDER BY id DESC LIMIT 1"
    ).get(AGENT);
    expect(row.source).toBe('session_end');
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe('getStats()', () => {
  beforeAll(() => {
    const STATS_AGENT = AGENT + '_stats';
    TEST_DB.prepare(`
      INSERT INTO consolidation_queue (agent_key, chat_id, turns, source, status)
      VALUES
        (?, '1', '[]', 'signal',  'pending'),
        (?, '2', '[]', 'signal',  'pending'),
        (?, '3', '[]', 'signal',  'done'),
        (?, '4', '[]', 'signal',  'error')
    `).run(STATS_AGENT, STATS_AGENT, STATS_AGENT, STATS_AGENT);
    // Guardar el agente para usarlo en los tests
    getStats_agent = STATS_AGENT;
  });

  let getStats_agent;

  test('retorna contadores correctos por status', () => {
    const stats = consolidator.getStats(getStats_agent);
    expect(stats.pending).toBe(2);
    expect(stats.done).toBe(1);
    expect(stats.error).toBe(1);
    expect(stats.processing).toBe(0);
  });

  test('cola vacía → todos en 0', () => {
    const stats = consolidator.getStats('__empty_agent_xyz__');
    expect(stats).toEqual({ pending: 0, processing: 0, done: 0, error: 0 });
  });

  test('sin DB retorna null', () => {
    memory.setDB(null);
    consolidator.init(null);
    expect(consolidator.getStats(AGENT)).toBeNull();
    consolidator.init(TEST_DB);
    memory.setDB(TEST_DB);
  });

  test('sin agentKey retorna stats globales (objeto no null)', () => {
    const stats = consolidator.getStats(null);
    expect(stats).toBeTruthy();
    expect(typeof stats.pending).toBe('number');
  });
});

// ── addTopic ──────────────────────────────────────────────────────────────────

describe('addTopic()', () => {
  const TOPIC_AGENT = AGENT + '_topics';
  const TOPIC_DIR   = path.join(memory.MEMORY_DIR, TOPIC_AGENT);

  afterEach(() => {
    // Limpiar preferencias del agente de test
    const prefsPath = path.join(TOPIC_DIR, 'preferences.json');
    if (fs.existsSync(prefsPath)) fs.unlinkSync(prefsPath);
    memory.invalidatePrefsCache(TOPIC_AGENT);
  });

  afterAll(() => {
    if (fs.existsSync(TOPIC_DIR)) fs.rmSync(TOPIC_DIR, { recursive: true, force: true });
  });

  test('agrega un tópico nuevo y retorna true', () => {
    const added = consolidator.addTopic(TOPIC_AGENT, 'programacion', 'temas de código');
    expect(added).toBe(true);
    memory.invalidatePrefsCache(TOPIC_AGENT);
    const prefs = memory.getPreferences(TOPIC_AGENT);
    expect(prefs.topics.some(t => t.name === 'programacion')).toBe(true);
  });

  test('retorna false si el tópico ya existe', () => {
    consolidator.addTopic(TOPIC_AGENT, 'salud', 'temas de salud');
    const added = consolidator.addTopic(TOPIC_AGENT, 'salud', 'duplicado');
    expect(added).toBe(false);
  });

  test('el tópico incluye learnedAt, autoSave, keywords', () => {
    consolidator.addTopic(TOPIC_AGENT, 'viajes', 'lugares visitados');
    memory.invalidatePrefsCache(TOPIC_AGENT);
    const prefs = memory.getPreferences(TOPIC_AGENT);
    const topic = prefs.topics.find(t => t.name === 'viajes');
    expect(topic).toBeTruthy();
    expect(topic.learnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(topic.autoSave).toBe(true);
    expect(Array.isArray(topic.keywords)).toBe(true);
  });

  test('la comparación es case-insensitive', () => {
    consolidator.addTopic(TOPIC_AGENT, 'Trabajo', '');
    const added = consolidator.addTopic(TOPIC_AGENT, 'trabajo', '');
    expect(added).toBe(false);
  });
});

// ── processQueue (con spawn mockeado) ─────────────────────────────────────────

describe('processQueue()', () => {
  const { EventEmitter } = require('events');
  const childProcess = require('child_process');
  let spawnSpy;

  const PQ_AGENT = AGENT + '_pq';
  const PQ_DIR   = path.join(memory.MEMORY_DIR, PQ_AGENT);

  afterAll(() => {
    if (fs.existsSync(PQ_DIR)) fs.rmSync(PQ_DIR, { recursive: true, force: true });
    TEST_DB.prepare("DELETE FROM consolidation_queue WHERE agent_key = ?").run(PQ_AGENT);
  });

  function makeFakeProcess(outputData) {
    const proc = new EventEmitter();
    proc.stdin = { write: jest.fn(), end: jest.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    setImmediate(() => {
      proc.stdout.emit('data', outputData);
      proc.emit('close', 0, null);
    });

    return proc;
  }

  beforeEach(() => {
    spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() =>
      makeFakeProcess('<save_memory file="nota-pq.md">\n---\ntitle: Test PQ\ntags: [test]\nimportance: 5\n---\nContenido procesado.\n</save_memory>')
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    TEST_DB.prepare("DELETE FROM consolidation_queue WHERE agent_key = ?").run(PQ_AGENT);
    // Limpiar archivos del agente
    const noteFile = path.join(PQ_DIR, 'nota-pq.md');
    if (fs.existsSync(noteFile)) fs.unlinkSync(noteFile);
  });

  test('procesa ítem pendiente y lo marca como done', async () => {
    TEST_DB.prepare(
      "INSERT INTO consolidation_queue (agent_key, chat_id, turns, source) VALUES (?, '1', ?, 'signal')"
    ).run(PQ_AGENT, JSON.stringify([{ text: 'recuerda que soy developer', types: ['personal'], ts: Date.now() }]));

    await consolidator.processQueue();

    const row = TEST_DB.prepare(
      "SELECT status FROM consolidation_queue WHERE agent_key = ? ORDER BY id DESC LIMIT 1"
    ).get(PQ_AGENT);
    expect(row.status).toBe('done');
  });

  test('aplica la operación save_memory al archivo', async () => {
    TEST_DB.prepare(
      "INSERT INTO consolidation_queue (agent_key, chat_id, turns, source) VALUES (?, '2', ?, 'signal')"
    ).run(PQ_AGENT, JSON.stringify([{ text: 'test', types: [], ts: Date.now() }]));

    await consolidator.processQueue();

    const content = memory.read(PQ_AGENT, 'nota-pq.md');
    expect(content).not.toBeNull();
    expect(content).toContain('Contenido procesado.');
  });

  test('si claude retorna "nada que guardar", no crea archivos', async () => {
    jest.restoreAllMocks();
    spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() =>
      makeFakeProcess('nada que guardar')
    );

    TEST_DB.prepare(
      "INSERT INTO consolidation_queue (agent_key, chat_id, turns, source) VALUES (?, '3', ?, 'signal')"
    ).run(PQ_AGENT, JSON.stringify([{ text: 'hola mundo', types: [], ts: Date.now() }]));

    await consolidator.processQueue();

    // El archivo NO debe haberse creado
    expect(memory.read(PQ_AGENT, 'nota-pq.md')).toBeNull();
    const row = TEST_DB.prepare(
      "SELECT status FROM consolidation_queue WHERE agent_key = ? ORDER BY id DESC LIMIT 1"
    ).get(PQ_AGENT);
    expect(row.status).toBe('done');
  });

  test('error en claude marca el ítem como error', async () => {
    jest.restoreAllMocks();
    spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdin = { write: jest.fn(), end: jest.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stderr.emit('data', 'Error: something went wrong');
        proc.emit('close', 1, null);  // exit code 1 sin stdout
      });
      return proc;
    });

    TEST_DB.prepare(
      "INSERT INTO consolidation_queue (agent_key, chat_id, turns, source) VALUES (?, '4', ?, 'signal')"
    ).run(PQ_AGENT, JSON.stringify([{ text: 'texto test', types: [], ts: Date.now() }]));

    await consolidator.processQueue();

    const row = TEST_DB.prepare(
      "SELECT status FROM consolidation_queue WHERE agent_key = ? ORDER BY id DESC LIMIT 1"
    ).get(PQ_AGENT);
    expect(row.status).toBe('error');
  });

  test('new_topic en output emite evento memory:topic-suggestion', async () => {
    jest.restoreAllMocks();
    spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() =>
      makeFakeProcess('<new_topic>programacion_funcional</new_topic>')
    );

    const events = require('../events');
    const receivedEvents = [];
    events.on('memory:topic-suggestion', (data) => receivedEvents.push(data));

    TEST_DB.prepare(
      "INSERT INTO consolidation_queue (agent_key, chat_id, turns, source) VALUES (?, '5', ?, 'signal')"
    ).run(PQ_AGENT, JSON.stringify([{ text: 'aprendí sobre programación funcional', types: [], ts: Date.now() }]));

    await consolidator.processQueue();

    events.removeAllListeners('memory:topic-suggestion');
    expect(receivedEvents.some(e => e.topicName === 'programacion_funcional')).toBe(true);
  });

  test('cola vacía no lanza error', async () => {
    // Asegurarse que la cola está vacía para PQ_AGENT
    await expect(consolidator.processQueue()).resolves.not.toThrow();
  });
});
