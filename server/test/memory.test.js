'use strict';

/**
 * Tests de memory.js
 *
 * Estrategia de aislamiento:
 * - Se inyecta una DB SQLite in-memory vía setDB() antes de que los tests corran.
 * - Las operaciones de archivos usan un agente de test único en server/memory/,
 *   que se elimina en afterAll.
 */

const fs       = require('fs');
const Database = require('better-sqlite3');
const memory   = require('../memory');

// ── Setup: DB in-memory ───────────────────────────────────────────────────────

const TEST_DB = new Database(':memory:');
TEST_DB.pragma('journal_mode = WAL');
TEST_DB.pragma('foreign_keys = ON');
TEST_DB.exec(memory.DB_SCHEMA);

// Reemplazar la DB de producción antes de que cualquier test corra
// (initDB ya corrió al cargar el módulo, pero setDB la sobreescribe)
beforeAll(() => {
  memory.setDB(TEST_DB);
});

afterAll(() => {
  memory.setDB(null);
  TEST_DB.close();
  // Limpiar directorio del agente de test
  const dir = require('path').join(memory.MEMORY_DIR, AGENT);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const AGENT = '__test_mem_' + Date.now() + '__';

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  const { parseFrontmatter } = memory;

  test('sin frontmatter retorna defaults', () => {
    const r = parseFrontmatter('solo contenido', 'nota.md');
    expect(r.title).toBe('nota');
    expect(r.tags).toEqual([]);
    expect(r.importance).toBe(5);
    expect(r.body).toBe('solo contenido');
  });

  test('frontmatter completo', () => {
    const content = '---\ntitle: Mi nota\ntags: [auth, jwt, node]\nimportance: 8\n---\n\nContenido.';
    const r = parseFrontmatter(content, 'mi-nota.md');
    expect(r.title).toBe('Mi nota');
    expect(r.tags).toEqual(['auth', 'jwt', 'node']);
    expect(r.importance).toBe(8);
    expect(r.body).toContain('Contenido.');
  });

  test('tags en lista multiline', () => {
    const content = '---\ntitle: Test\ntags:\n- auth\n- jwt\n- token\n---\n\nBody.';
    const r = parseFrontmatter(content, 'test.md');
    expect(r.tags).toEqual(['auth', 'jwt', 'token']);
  });

  test('importance se clampa a [1, 10]', () => {
    expect(parseFrontmatter('---\nimportance: 15\n---\nbody', 'f.md').importance).toBe(10);
    expect(parseFrontmatter('---\nimportance: 0\n---\nbody',  'f.md').importance).toBe(1);
  });

  test('sin --- de cierre → defaults', () => {
    const r = parseFrontmatter('---\ntitle: Sin cierre\n', 'f.md');
    expect(r.title).toBe('f');
  });

  test('content vacío → defaults', () => {
    const r = parseFrontmatter('', 'empty.md');
    expect(r.title).toBe('empty');
    expect(r.tags).toEqual([]);
  });

  test('links inline se parsean', () => {
    const content = '---\ntitle: Test\ntags: []\nlinks: [nota-a.md, nota-b.md]\n---\nBody.';
    const r = parseFrontmatter(content, 'test.md');
    expect(r.links).toContain('nota-a.md');
    expect(r.links).toContain('nota-b.md');
  });
});

// ── extractKeywords ───────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  const { extractKeywords } = memory;

  test('extrae palabras relevantes del texto', () => {
    const kw = extractKeywords('tengo un error en mi código de typescript');
    expect(kw).toContain('error');
    expect(kw).toContain('typescript');
  });

  test('elimina stopwords comunes', () => {
    const kw = extractKeywords('el la de en con para los las');
    expect(kw.length).toBe(0);
  });

  test('filtra palabras de 2 chars o menos', () => {
    const kw = extractKeywords('el la de ir ok');
    expect(kw.every(w => w.length > 2)).toBe(true);
  });

  test('texto vacío → []', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
  });

  test('retorna en minúsculas', () => {
    const kw = extractKeywords('JavaScript TypeScript');
    expect(kw.every(w => w === w.toLowerCase())).toBe(true);
  });
});

// ── expandKeywords ────────────────────────────────────────────────────────────

describe('expandKeywords', () => {
  const { expandKeywords } = memory;

  test('expande "autenticacion" con stemming', () => {
    const exp = expandKeywords(['autenticacion']);
    expect(exp).toContain('auth');
    expect(exp).toContain('login');
  });

  test('mantiene los keywords originales', () => {
    const exp = expandKeywords(['error', 'python']);
    expect(exp).toContain('error');
    expect(exp).toContain('python');
  });

  test('normaliza acentos', () => {
    const exp = expandKeywords(['autenticación']);
    // Debe incluir la versión sin acento
    expect(exp.some(k => k.includes('autenticac'))).toBe(true);
  });

  test('expande "error" → bug', () => {
    const exp = expandKeywords(['error']);
    expect(exp).toContain('bug');
  });

  test('expande "python" → backend', () => {
    const exp = expandKeywords(['python']);
    expect(exp).toContain('python');
    expect(exp).toContain('backend');
  });
});

// ── extractMemoryOps ──────────────────────────────────────────────────────────

describe('extractMemoryOps', () => {
  const { extractMemoryOps } = memory;

  test('extrae save_memory y lo elimina del texto', () => {
    const text = [
      'Respuesta del agente.',
      '<save_memory file="test.md">',
      '---',
      'title: Test',
      'tags: [a, b]',
      'importance: 5',
      '---',
      'Contenido.',
      '</save_memory>',
      'Fin.',
    ].join('\n');

    const { clean, ops } = extractMemoryOps(text);
    expect(ops).toHaveLength(1);
    expect(ops[0].mode).toBe('write');
    expect(ops[0].file).toBe('test.md');
    expect(ops[0].content).toContain('Contenido.');
    expect(clean).toContain('Respuesta del agente');
    expect(clean).toContain('Fin.');
    expect(clean).not.toContain('<save_memory');
  });

  test('extrae append_memory con mode=append', () => {
    const text = '<append_memory file="notes.md">\n- Nueva línea\n</append_memory>';
    const { ops } = extractMemoryOps(text);
    expect(ops[0].mode).toBe('append');
    expect(ops[0].file).toBe('notes.md');
  });

  test('sin etiquetas → ops vacío, clean sin cambios', () => {
    const { clean, ops } = extractMemoryOps('Texto normal sin etiquetas');
    expect(ops).toHaveLength(0);
    expect(clean).toBe('Texto normal sin etiquetas');
  });

  test('múltiples save_memory en el mismo texto', () => {
    const text = '<save_memory file="a.md">A</save_memory>\n<save_memory file="b.md">B</save_memory>';
    expect(extractMemoryOps(text).ops).toHaveLength(2);
  });

  test('path traversal en filename → se usa solo el basename', () => {
    const text = '<save_memory file="../../../etc/passwd">evil</save_memory>';
    const { ops } = extractMemoryOps(text);
    expect(ops[0].file).toBe('passwd');
  });
});

// ── detectSignals ─────────────────────────────────────────────────────────────

describe('detectSignals', () => {
  const { detectSignals } = memory;

  test('texto vacío → maxWeight=0, shouldNudge=false', () => {
    const r = detectSignals(AGENT, '');
    expect(r.maxWeight).toBe(0);
    expect(r.signals).toHaveLength(0);
    expect(r.shouldNudge).toBe(false);
  });

  test('solicitud explícita ("recuerda") → shouldNudge=true', () => {
    const r = detectSignals(AGENT, 'recuerda que prefiero usar TypeScript');
    expect(r.shouldNudge).toBe(true);
    expect(r.maxWeight).toBeGreaterThan(0);
  });

  test('información personal ("mi nombre es") detecta señal personal', () => {
    const r = detectSignals(AGENT, 'mi nombre es Juan');
    expect(r.signals.some(s => s.type === 'personal')).toBe(true);
  });

  test('pregunta factual sin info personal → shouldNudge=false', () => {
    const r = detectSignals(AGENT, 'cuánto es 5 más 5');
    expect(r.shouldNudge).toBe(false);
  });

  test('preferencia ("siempre prefiero") detecta señal preference', () => {
    const r = detectSignals(AGENT, 'siempre prefiero el café negro');
    expect(r.signals.some(s => s.type === 'preference')).toBe(true);
  });
});

// ── buildNudge ────────────────────────────────────────────────────────────────

describe('buildNudge', () => {
  const { buildNudge } = memory;

  test('incluye el texto SISTEMA con instrucción de guardar', () => {
    const nudge = buildNudge([{ type: 'explicit', weight: 10 }]);
    expect(nudge).toContain('SISTEMA');
    expect(nudge).toContain('save_memory');
    expect(nudge).toContain('10/10');
  });

  test('incluye el tipo de señal en el texto', () => {
    const nudge = buildNudge([{ type: 'personal', weight: 9 }]);
    expect(nudge).toContain('personal');
  });
});

// ── File CRUD ─────────────────────────────────────────────────────────────────

describe('File CRUD (write / read / append / remove / listFiles)', () => {
  test('write() + read() — ciclo completo', () => {
    memory.write(AGENT, 'crud-test.md', 'contenido inicial');
    expect(memory.read(AGENT, 'crud-test.md')).toBe('contenido inicial');
  });

  test('read() retorna null para archivo inexistente', () => {
    expect(memory.read(AGENT, 'no-existe-nunca.md')).toBeNull();
  });

  test('write() sobreescribe el archivo', () => {
    memory.write(AGENT, 'overwrite.md', 'versión 1');
    memory.write(AGENT, 'overwrite.md', 'versión 2');
    expect(memory.read(AGENT, 'overwrite.md')).toBe('versión 2');
  });

  test('append() agrega contenido al archivo existente', () => {
    memory.write(AGENT, 'append.md', 'línea 1');
    memory.append(AGENT, 'append.md', 'línea 2');
    const content = memory.read(AGENT, 'append.md');
    expect(content).toContain('línea 1');
    expect(content).toContain('línea 2');
  });

  test('append() en archivo inexistente lo crea', () => {
    memory.append(AGENT, 'new-via-append.md', 'primer contenido');
    expect(memory.read(AGENT, 'new-via-append.md')).toBe('primer contenido');
  });

  test('remove() elimina el archivo y retorna true', () => {
    memory.write(AGENT, 'to-delete.md', 'borrar');
    expect(memory.remove(AGENT, 'to-delete.md')).toBe(true);
    expect(memory.read(AGENT, 'to-delete.md')).toBeNull();
  });

  test('remove() retorna false para archivo inexistente', () => {
    expect(memory.remove(AGENT, 'fantasia.md')).toBe(false);
  });

  test('listFiles() incluye los archivos del agente', () => {
    memory.write(AGENT, 'list-a.md', 'a');
    memory.write(AGENT, 'list-b.md', 'b');
    const files = memory.listFiles(AGENT);
    const names = files.map(f => f.filename);
    expect(names).toContain('list-a.md');
    expect(names).toContain('list-b.md');
  });

  test('listFiles() retorna [] para agente sin directorio', () => {
    expect(memory.listFiles('__nonexistent_agent_xyz__')).toEqual([]);
  });

  test('write() con nombre que empieza con punto lanza error', () => {
    expect(() => memory.write(AGENT, '.hidden', 'contenido')).toThrow(/inválido/);
  });

  test('read() con path traversal usa solo el basename', () => {
    // '../../../etc/passwd' → basename → 'passwd' → no existe en AGENT dir
    const result = memory.read(AGENT, '../../../etc/passwd');
    expect(result).toBeNull();
  });
});

// ── getPreferences ────────────────────────────────────────────────────────────

describe('getPreferences', () => {
  test('retorna estructura con signals, settings y topics', () => {
    const prefs = memory.getPreferences('__no_prefs_agent_xyz__');
    expect(Array.isArray(prefs.signals)).toBe(true);
    expect(prefs.settings).toBeTruthy();
    expect(typeof prefs.settings.nudgeEnabled).toBe('boolean');
  });

  test('DEFAULT_PREFERENCES tiene señales y settings válidos', () => {
    const { signals, settings } = memory.DEFAULT_PREFERENCES;
    expect(signals.length).toBeGreaterThan(0);
    expect(settings.nudgeEnabled).toBe(true);
    expect(settings.consolidationEnabled).toBe(true);
    expect(typeof settings.tokenBudget).toBe('number');
  });

  test('cachea la configuración (segunda llamada devuelve misma referencia)', () => {
    const p1 = memory.getPreferences(AGENT);
    const p2 = memory.getPreferences(AGENT);
    expect(p1).toBe(p2);
    memory.invalidatePrefsCache(AGENT);
  });

  test('preferences con archivo personalizado se aplican sobre los defaults', () => {
    memory.write(AGENT, 'preferences.json', JSON.stringify({
      settings: { nudgeEnabled: false },
    }));
    memory.invalidatePrefsCache(AGENT);
    const prefs = memory.getPreferences(AGENT);
    expect(prefs.settings.nudgeEnabled).toBe(false);
    // Pero el resto de settings viene de defaults
    expect(typeof prefs.settings.tokenBudget).toBe('number');
    // Limpiar
    memory.remove(AGENT, 'preferences.json');
    memory.invalidatePrefsCache(AGENT);
  });
});

// ── indexNote + spreadingActivation ──────────────────────────────────────────

describe('indexNote + spreadingActivation', () => {
  const SA_AGENT = AGENT + '_sa';

  afterAll(() => {
    const { MEMORY_DIR } = memory;
    const dir = require('path').join(MEMORY_DIR, SA_AGENT);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('indexNote() indexa una nota y retorna su ID numérico', async () => {
    const content = '---\ntitle: Auth con JWT\ntags: [auth, jwt, typescript]\nimportance: 7\n---\n\nLa solución fue usar RS256.';
    memory.write(SA_AGENT, 'auth.md', content);
    const id = await memory.indexNote(SA_AGENT, 'auth.md');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  test('indexNote() retorna null para archivo inexistente', async () => {
    const id = await memory.indexNote(SA_AGENT, 'no-existe.md');
    expect(id).toBeNull();
  });

  test('indexNote() es idempotente — segunda indexación actualiza la nota', async () => {
    const content = '---\ntitle: Idempotente\ntags: [test]\nimportance: 5\n---\nv1.';
    memory.write(SA_AGENT, 'idempotent.md', content);
    const id1 = await memory.indexNote(SA_AGENT, 'idempotent.md');

    // Actualizar el archivo y re-indexar
    memory.write(SA_AGENT, 'idempotent.md', content.replace('v1.', 'v2.'));
    const id2 = await memory.indexNote(SA_AGENT, 'idempotent.md');

    expect(id1).toBe(id2);  // mismo ID (UPSERT)
  });

  test('spreadingActivation() encuentra notas por tags', async () => {
    const content = '---\ntitle: Error JWT inválido\ntags: [auth, jwt, error]\nimportance: 8\n---\n\nEl error era invalid signature.';
    memory.write(SA_AGENT, 'jwt-error.md', content);
    await memory.indexNote(SA_AGENT, 'jwt-error.md');

    const keywords = memory.extractKeywords('error de autenticación jwt');
    const results  = memory.spreadingActivation(SA_AGENT, keywords);
    expect(results.some(r => r.filename === 'jwt-error.md')).toBe(true);
  });

  test('spreadingActivation() retorna [] con keywords vacío', () => {
    expect(memory.spreadingActivation(SA_AGENT, [])).toEqual([]);
  });

  test('cada resultado tiene las propiedades esperadas', async () => {
    const keywords = memory.extractKeywords('auth');
    const results  = memory.spreadingActivation(SA_AGENT, keywords);
    if (results.length > 0) {
      const r = results[0];
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('filename');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('content');
      expect(r).toHaveProperty('tags');
      expect(r).toHaveProperty('score');
      expect(r.score).toBeGreaterThan(0);
    }
  });

  test('trackAccess() incrementa access_count', async () => {
    const content = '---\ntitle: Track test\ntags: [track]\nimportance: 5\n---\nTrack.';
    memory.write(SA_AGENT, 'track.md', content);
    const id = await memory.indexNote(SA_AGENT, 'track.md');
    const before = TEST_DB.prepare('SELECT access_count FROM notes WHERE id = ?').get(id);
    memory.trackAccess([id]);
    const after = TEST_DB.prepare('SELECT access_count FROM notes WHERE id = ?').get(id);
    expect(after.access_count).toBe(before.access_count + 1);
  });

  test('reinforceConnections() crea/actualiza co_access_count', async () => {
    const c1 = '---\ntitle: Nota A\ntags: [hebb]\nimportance: 5\n---\nA.';
    const c2 = '---\ntitle: Nota B\ntags: [hebb]\nimportance: 5\n---\nB.';
    memory.write(SA_AGENT, 'hebb-a.md', c1);
    memory.write(SA_AGENT, 'hebb-b.md', c2);
    const idA = await memory.indexNote(SA_AGENT, 'hebb-a.md');
    const idB = await memory.indexNote(SA_AGENT, 'hebb-b.md');
    memory.reinforceConnections([idA, idB]);
    const link = TEST_DB.prepare(
      'SELECT co_access_count FROM note_links WHERE from_id = ? AND to_id = ?'
    ).get(idA, idB);
    expect(link.co_access_count).toBeGreaterThanOrEqual(1);
  });
});

// ── buildMemoryContext ────────────────────────────────────────────────────────

describe('buildMemoryContext', () => {
  test('retorna string vacío para agentKey vacío', () => {
    expect(memory.buildMemoryContext('', 'query')).toBe('');
    expect(memory.buildMemoryContext(null, 'query')).toBe('');
  });

  test('modo legacy (array de filenames) carga archivos directamente', () => {
    memory.write(AGENT, 'legacy-note.md', 'Contenido legacy importante');
    const ctx = memory.buildMemoryContext(AGENT, ['legacy-note.md']);
    expect(ctx).toContain('Contenido legacy importante');
    expect(ctx).toContain('## Memoria persistente del agente');
  });

  test('array vacío → string vacío', () => {
    expect(memory.buildMemoryContext(AGENT, [])).toBe('');
  });

  test('archivo inexistente en el array → se ignora silenciosamente', () => {
    const ctx = memory.buildMemoryContext(AGENT, ['no-existe-nunca.md']);
    expect(ctx).toBe('');
  });
});
