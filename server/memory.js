'use strict';

const fs   = require('fs');
const path = require('path');
const { MEMORY_DIR } = require('./paths');

// ─── Debug logger ────────────────────────────────────────────────────────────
// Activar con: DEBUG_MEMORY=1 (env) o "settings": { "debug": true } en defaults.json

const DEBUG_ENV = process.env.DEBUG_MEMORY === '1';

/**
 * Evalúa si el debug está activo.
 * Orden de prioridad: env var > defaults.json settings.debug > false.
 * Usa el cache de prefsCache para evitar I/O en cada llamada.
 */
function _isDebugOn() {
  if (DEBUG_ENV) return true;
  try {
    const cached = prefsCache.get('_global');
    return cached?.data?.settings?.debug === true;
  } catch { return false; }
}

function dbg(scope, ...args) {
  if (!_isDebugOn()) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`\x1b[35m[mem:${scope}]\x1b[0m \x1b[90m${ts}\x1b[0m`, ...args);
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function _agentDir(agentKey) {
  return path.join(MEMORY_DIR, agentKey);
}

function _ensureDir(agentKey) {
  const dir = _agentDir(agentKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Valida que el filename no tenga path traversal */
function _safeName(filename) {
  const base = path.basename(filename);
  if (!base || base.startsWith('.')) throw new Error('Nombre de archivo inválido');
  return base;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

function listFiles(agentKey) {
  const dir = _agentDir(agentKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(md|json|txt)$/.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, updatedAt: stat.mtimeMs };
    });
}

function read(agentKey, filename) {
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf8');
}

function write(agentKey, filename, content) {
  _ensureDir(agentKey);
  fs.writeFileSync(path.join(_agentDir(agentKey), _safeName(filename)), content, 'utf8');
  if (filename.endsWith('.md')) {
    setImmediate(() => indexNote(agentKey, filename).catch(() => {}));
  }
  // Invalidar cache de preferencias si el agente actualizó su config
  if (filename === 'preferences.json') {
    invalidatePrefsCache(agentKey);
    dbg('config', `preferences.json actualizado para "${agentKey}" — cache invalidado`);
  }
}

function append(agentKey, filename, content) {
  _ensureDir(agentKey);
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  const separator = fs.existsSync(filepath) ? '\n' : '';
  fs.appendFileSync(filepath, separator + content, 'utf8');
  // Auto-indexar si es .md (sin bloquear)
  if (filename.endsWith('.md')) {
    setImmediate(() => indexNote(agentKey, filename).catch(() => {}));
  }
}

function remove(agentKey, filename) {
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

// ─── Sistema de preferencias de memoria ──────────────────────────────────────

const DEFAULT_PREFERENCES = {
  version: 1,
  signals: [
    { pattern: '\brecuerda\b|\bacordate\b|no olvides|\bmemorizá\b|\bmemoriza\b|no te olvides', weight: 10, type: 'explicit',   enabled: true, description: 'Solicitud explícita de recordar' },
    { pattern: 'mi nombre es|me llamo|trabajo en|soy de|vivo en|tengo \\d+ años', weight: 9,  type: 'personal',   enabled: true, description: 'Información personal' },
    { pattern: '\\bmurió\\b|\\bnació\\b|me casé|me separé|\\bperdí\\b|tuve un|\\bcumpleaños\\b|\\baniversario\\b|me operé', weight: 9,  type: 'life_event', enabled: true, description: 'Eventos de vida importantes' },
    { pattern: '\\bsiempre\\b|\\bnunca\\b|\\bprefiero\\b|me gusta|\\bodio\\b|no me gusta|me encanta|\\bdetesto\\b',         weight: 8,  type: 'preference', enabled: true, description: 'Preferencias del usuario' },
    { pattern: 'la solución fue|aprendí que|el error era|funciona con|el fix fue|descubrí que', weight: 7,  type: 'knowledge',  enabled: true, description: 'Conocimiento o aprendizaje técnico' },
    { pattern: 'el \\d{1,2}\\/\\d{1,2}|el \\d{1,2} de \\w+|desde \\w+ pasado',                weight: 6,  type: 'date_event', enabled: true, description: 'Fechas y eventos temporales' },
  ],
  settings: {
    nudgeEnabled:                true,
    nudgeMinWeight:              7,
    tokenBudget:                 800,
    fallbackTopN:                3,
    consolidationEnabled:        true,
    consolidationCostThreshold:  0.005,
    debug:                       false,  // activar con true o con DEBUG_MEMORY=1 env var
  },
  // Tópicos de interés configurables por agente — el consolidador aprende de estos
  topics: [],
  // Ejemplo de tópico:
  // { name: 'programación', description: 'código, bugs, proyectos tech', keywords: ['código', 'bug', 'error', 'node', 'función'], autoSave: true, learnedAt: '2026-03-17' }
};

// Cache: agentKey → { data, loadedAt }
const prefsCache = new Map();

function _mergePrefs(base, override) {
  return {
    version:  override.version  || base.version,
    signals:  override.signals  || base.signals,   // override completo de señales
    settings: { ...base.settings, ...(override.settings || {}) },
    topics:   override.topics   ?? base.topics ?? [],  // tópicos: override gana, fallback a base
  };
}

/**
 * Carga preferencias con prioridad: agente > defaults.json > hardcoded.
 * Cachea 30s para evitar I/O en cada mensaje.
 */
function getPreferences(agentKey) {
  const cacheKey = agentKey || '_global';
  const cached   = prefsCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < 30000) return cached.data;

  let agentPrefs  = null;
  let globalPrefs = null;

  if (agentKey) {
    const p = path.join(_agentDir(agentKey), 'preferences.json');
    if (fs.existsSync(p)) {
      try { agentPrefs = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }
  }

  const globalPath = path.join(MEMORY_DIR, 'defaults.json');
  if (fs.existsSync(globalPath)) {
    try { globalPrefs = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch {}
  }

  const base  = globalPrefs ? _mergePrefs(DEFAULT_PREFERENCES, globalPrefs) : DEFAULT_PREFERENCES;
  const final = agentPrefs  ? _mergePrefs(base, agentPrefs)                 : base;

  prefsCache.set(cacheKey, { data: final, loadedAt: Date.now() });
  return final;
}

function invalidatePrefsCache(agentKey) {
  prefsCache.delete(agentKey || '_global');
  dbg('config', `cache invalidado para "${agentKey || '_global'}"`);
}

function resetPreferences(agentKey) {
  const p = path.join(_agentDir(agentKey), 'preferences.json');
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    invalidatePrefsCache(agentKey);
    return true;
  }
  return false;
}

const _SIGNAL_LABELS = {
  explicit:   'solicitud de recordar',
  personal:   'información personal',
  life_event: 'evento de vida importante',
  preference: 'preferencia del usuario',
  knowledge:  'aprendizaje técnico',
  date_event: 'fecha o evento',
};

/**
 * Analiza el texto y devuelve las señales de importancia detectadas.
 * @returns {{ maxWeight: number, signals: object[], shouldNudge: boolean }}
 */
function detectSignals(agentKey, text) {
  if (!text || !text.trim()) return { maxWeight: 0, signals: [], shouldNudge: false };

  const prefs = getPreferences(agentKey);
  const found = [];

  for (const sig of prefs.signals) {
    if (sig.enabled === false) continue;
    try {
      if (new RegExp(sig.pattern, 'i').test(text)) found.push(sig);
    } catch { /* patrón inválido */ }
  }

  const maxWeight   = found.length ? Math.max(...found.map(s => s.weight)) : 0;
  const nudgeMin    = prefs.settings.nudgeMinWeight ?? 7;
  const shouldNudge = prefs.settings.nudgeEnabled !== false && maxWeight >= nudgeMin;

  if (found.length) {
    dbg('signals', `"${text.slice(0, 60)}…" → [${found.map(s => s.type).join(', ')}] max=${maxWeight} nudge=${shouldNudge}`);
  }

  return { maxWeight, signals: found, shouldNudge };
}

/**
 * Construye el texto del nudge que se añade al mensaje del usuario.
 */
function buildNudge(signals) {
  const types  = [...new Set(signals.map(s => s.type))];
  const weight = Math.max(...signals.map(s => s.weight));
  const labels = types.map(t => _SIGNAL_LABELS[t] || t).join(', ');

  // Ejemplos de tags según el tipo de señal
  const tagExamples = {
    explicit:   '[tema-pedido, contexto-especifico]',
    personal:   '[nombre, empresa, ciudad, herramienta]',
    life_event: '[persona, evento, fecha, relacion]',
    preference: '[objeto-preferido, acción, contexto]  ej: [darkmode, cafe, editor]',
    knowledge:  '[lenguaje, error-code, solucion, herramienta]',
    date_event: '[persona, fecha, mes, evento]',
  };
  const typeEx = types.map(t => tagExamples[t] || '[tag1, tag2]').join(' / ');

  return (
    `\n\n[SISTEMA — ACCIÓN REQUERIDA: Se detectó ${labels} (importancia ${weight}/10). ` +
    `DEBÉS guardar esto usando <save_memory file="nombre-tema.md"> con tags específicos del contenido. ` +
    `Ejemplo de tags para este tipo: ${typeEx}. ` +
    `NO uses tags genéricos como [personal, usuario, info]. ` +
    `Hacé esto ANTES de responder al usuario — el usuario no verá las etiquetas.]`
  );
}

// ─── Inyección en system prompt ──────────────────────────────────────────────

/**
 * Construye el bloque de memoria usando embeddings vectoriales.
 * Se llama cuando el provider activo soporta embeddings (OpenAI / Gemini).
 * Es async: calcula vectores faltantes y los persiste en SQLite.
 * @returns {Promise<string>}
 */
async function _buildMemoryContextByEmbeddings(agentKey, userMessage, provider, apiKey, embMod) {
  try {
    const results = await embMod.searchByEmbedding(db, agentKey, userMessage, provider, apiKey);

    if (!results.length) {
      dbg('ctx', `embeddings: sin resultados para agent="${agentKey}" → spreading fallback`);
      // Fallback a spreading activation
      const keywords = extractKeywords(userMessage);
      const spreading = spreadingActivation(agentKey, keywords);
      if (!spreading.length) return '';
      const ids = spreading.map(r => r.id);
      setImmediate(() => { try { trackAccess(ids); reinforceConnections(ids); } catch {} });
      const parts = spreading.map(r => {
        const tagLine = r.tags.length ? `tags: [${r.tags.join(', ')}]` : '';
        return `### ${r.title}\n${tagLine ? tagLine + '\n\n' : ''}${r.content}`;
      });
      return `## Memoria relevante\n\n${parts.join('\n\n---\n\n')}`;
    }

    const ids = results.map(r => r.id);
    setImmediate(() => { try { trackAccess(ids); reinforceConnections(ids); } catch {} });

    dbg('ctx', `embeddings: ${results.length} nota(s) para agent="${agentKey}" provider="${provider}"`);
    if (_isDebugOn()) {
      for (const r of results) {
        dbg('ctx', `  → "${r.title}" [${r.tags}] cosine=${r.score.toFixed(3)}`);
      }
    }

    const parts = results.map(r => {
      const tagLine = r.tags.length ? `tags: [${r.tags.join(', ')}]` : '';
      return `### ${r.title}\n${tagLine ? tagLine + '\n\n' : ''}${r.content}`;
    });
    return `## Memoria relevante\n\n${parts.join('\n\n---\n\n')}`;
  } catch (err) {
    dbg('ctx', `embeddings error: ${err.message} → spreading fallback`);
    // Fallback silencioso a spreading activation
    try {
      const keywords = extractKeywords(userMessage);
      const spreading = spreadingActivation(agentKey, keywords);
      if (!spreading.length) return '';
      const parts = spreading.map(r => {
        const tagLine = r.tags.length ? `tags: [${r.tags.join(', ')}]` : '';
        return `### ${r.title}\n${tagLine ? tagLine + '\n\n' : ''}${r.content}`;
      });
      return `## Memoria relevante\n\n${parts.join('\n\n---\n\n')}`;
    } catch { return ''; }
  }
}

/**
 * Construye el bloque de memoria para inyectar en el system prompt.
 * @param {string}          agentKey
 * @param {string[]|string} memoryFilesOrMessage
 *   - Array de filenames → comportamiento legacy (carga todos)
 *   - String → nuevo: spreading activation por texto del usuario
 * @param {object}  [opts]
 * @param {string}  [opts.provider]  Provider activo ('openai'|'gemini') para usar embeddings
 * @param {string}  [opts.apiKey]    API key del provider para embeddings
 * @returns {string|Promise<string>}
 */
function buildMemoryContext(agentKey, memoryFilesOrMessage = [], opts = {}) {
  if (!agentKey) return '';

  // Retrocompatibilidad: si es array, carga los archivos literalmente
  if (Array.isArray(memoryFilesOrMessage)) {
    const memoryFiles = memoryFilesOrMessage;
    if (!memoryFiles.length) return '';
    const parts = [];
    for (const filename of memoryFiles) {
      try {
        const content = read(agentKey, filename);
        if (content && content.trim()) {
          parts.push(`### ${filename}\n${content.trim()}`);
        }
      } catch { /* ignorar archivos no legibles */ }
    }
    if (!parts.length) return '';
    return `## Memoria persistente del agente\n\n${parts.join('\n\n---\n\n')}`;
  }

  const userMessage = typeof memoryFilesOrMessage === 'string' ? memoryFilesOrMessage : '';

  // Embeddings: intentar local primero (todos los providers), fallback a API, luego spreading
  const { provider, apiKey } = opts;
  let embeddingsModule = null;
  try { embeddingsModule = require('./embeddings'); } catch {}

  if (db && embeddingsModule) {
    // Intentar embeddings locales primero (todos los providers incluyendo claude-code)
    // Fallback: API embeddings (si provider soporta) → spreading activation
    dbg('ctx', `intentando embeddings locales para provider="${provider}"`);
    const spreadingFallback = () => {
      dbg('ctx', `fallback a spreading activation`);
      try {
        const keywords = extractKeywords(userMessage);
        const spreading = spreadingActivation(agentKey, keywords);
        if (!spreading.length) return '';
        const ids = spreading.map(r => r.id);
        const notes = db.prepare(`SELECT id, filename, title, content FROM notes WHERE id IN (${ids.join(',')})`).all();
        const noteMap = new Map(notes.map(n => [n.id, n]));
        const parts = [];
        for (const r of spreading) {
          const n = noteMap.get(r.id);
          if (n) parts.push(`  → "${n.title}" cosine=${r.score.toFixed(3)}`);
        }
        if (parts.length) dbg('ctx', parts.join('\n'));
        return spreading.length ? notes.map(n => `### ${n.title}\n${n.content}`).join('\n\n---\n\n') : '';
      } catch { return ''; }
    };

    return _buildMemoryContextByEmbeddings(agentKey, userMessage, 'local', null, embeddingsModule)
      .catch(localErr => {
        dbg('ctx', `embeddings locales fallaron: ${localErr.message}`);
        if (provider && apiKey && embeddingsModule.supportsEmbeddings(provider)) {
          dbg('ctx', `fallback a embeddings API provider="${provider}"`);
          return _buildMemoryContextByEmbeddings(agentKey, userMessage, provider, apiKey, embeddingsModule);
        }
        return spreadingFallback();
      });
  }

  // Spreading activation (síncrono, default para claude-code y anthropic)
  try {
    const keywords = extractKeywords(userMessage);
    let results    = spreadingActivation(agentKey, keywords);

    // Fallback: si no hay resultados semánticos, recuperar las notas más recientes/importantes
    if (!results.length && db) {
      dbg('ctx', `sin resultados semánticos → fallback a top notas recientes`);
      const fallback = db.prepare(`
        SELECT n.id, n.filename, n.title, n.content, n.importance, n.access_count,
               n.created_at, n.last_accessed
        FROM notes n
        WHERE n.agent_key = ?
        ORDER BY n.importance DESC, n.updated_at DESC
        LIMIT 3
      `).all(agentKey);
      results = fallback.map(n => {
        const tagRows = db.prepare(
          'SELECT t.name FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ?'
        ).all(n.id);
        return { id: n.id, filename: n.filename, title: n.title, content: n.content,
                 tags: tagRows.map(r => r.name), importance: n.importance,
                 accessCount: n.access_count, score: 0 };
      });
    }

    if (!results.length) return '';

    // trackAccess y reinforceConnections de forma asíncrona (no bloquear)
    const ids = results.map(r => r.id);
    setImmediate(() => {
      try { trackAccess(ids); } catch {}
      try { reinforceConnections(ids); } catch {}
    });

    const totalTokens = results.reduce((n, r) => n + Math.ceil(r.content.length / 4), 0);
    dbg('ctx', `inyectando ${results.length} nota(s) ~${totalTokens} tokens para agent="${agentKey}"`);
    if (_isDebugOn()) {
      for (const r of results) dbg('ctx', `  → "${r.title}" [${r.tags}] score=${r.score.toFixed(3)}`);
    }

    const parts = results.map(r => {
      const tagLine = r.tags.length ? `tags: [${r.tags.join(', ')}]` : '';
      return `### ${r.title}\n${tagLine ? tagLine + '\n\n' : ''}${r.content}`;
    });
    return `## Memoria relevante\n\n${parts.join('\n\n---\n\n')}`;
  } catch {
    // Si SQLite no está disponible, silencioso
    return '';
  }
}

// ─── Instrucciones de la herramienta ─────────────────────────────────────────

const TOOL_INSTRUCTIONS = `
## Herramienta de memoria

Guardá información persistente usando estas etiquetas EN tu respuesta.
El sistema las extrae automáticamente — el usuario NO las ve.

### Guardar nota nueva (reemplaza si ya existe):
<save_memory file="nombre-descriptivo.md">
---
title: Título corto del contenido
tags: [sustantivo1, sustantivo2, sustantivo3]
importance: 8
---

Contenido conciso de lo que hay que recordar.
</save_memory>

### Agregar a nota existente:
<append_memory file="nombre-existente.md">
- Dato adicional a agregar
</append_memory>

### REGLAS CRÍTICAS:

**Una nota por tema** — NO mezclar trabajo + mascota + preferencias en un solo archivo.
  ✓ mascotas.md, trabajo.md, preferencias.md  (archivos separados)
  ✗ memoria-usuario.md con todo mezclado     (dificulta la búsqueda)

**Tags = sustantivos del contenido** (lo que está EN la nota, no categorías):
  ✓ [thor, perro, golden, muerte] para "murió Thor el golden retriever"
  ✓ [typescript, esmodules, ts2307, tsconfig] para un error de TypeScript
  ✓ [darkmode, café, editor, conciso] para preferencias de estilo
  ✗ [personal, usuario, info, recuerdo, datos] — no sirven para buscar

**Importance** (qué tan importante es para conversaciones futuras):
  10: datos de identidad (nombre, empresa, ciudad)
  9:  eventos de vida (nacimientos, muertes, relaciones)
  8:  proyectos activos, decisiones técnicas importantes
  7:  preferencias del usuario, configuraciones
  6:  errores resueltos con técnica específica, fechas
  5:  contexto general (defecto)

**Cuándo SIEMPRE guardar** (la [Nota del sistema] lo indica):
- El usuario dice "recuerda", "no olvides", "memorizá"
- El usuario revela información personal (nombre, empresa, ciudad, edad)
- Ocurre un evento de vida (muerte, nacimiento, cumpleaños, relación)
- El usuario expresa preferencias concretas (siempre/nunca/prefiero/odio)
- Se aprende cómo resolver un error técnico ("el fix fue", "aprendí que", "la solución fue")
- Se menciona una fecha o evento con fecha ("el 15 de agosto", "desde mayo pasado")

**Cuándo NO guardar:**
- Preguntas factuales sin contexto personal ("cuánto es 5x5")
- Conversación trivial sin info de valor futuro

Para ajustar señales de detección:
<save_memory file="preferences.json">
{"signals": [{"pattern": "regex", "weight": 8, "type": "knowledge", "enabled": true, "description": "desc"}]}
</save_memory>
`.trim();

// ─── Extracción de operaciones de memoria del output del LLM ─────────────────

/**
 * Extrae las operaciones de memoria del texto generado por el LLM.
 * Retorna el texto limpio (sin etiquetas) y la lista de operaciones a ejecutar.
 */
function extractMemoryOps(text) {
  const ops = [];

  let clean = text.replace(
    /<save_memory\s+file="([^"]+)">([\s\S]*?)<\/save_memory>/g,
    (_, file, content) => {
      ops.push({ file: path.basename(file), content: content.trim(), mode: 'write' });
      return '';
    }
  );

  clean = clean.replace(
    /<append_memory\s+file="([^"]+)">([\s\S]*?)<\/append_memory>/g,
    (_, file, content) => {
      ops.push({ file: path.basename(file), content: content.trim(), mode: 'append' });
      return '';
    }
  );

  clean = clean.replace(/\n{3,}/g, '\n\n').trim();

  return { clean, ops };
}

/**
 * Aplica una lista de operaciones de memoria para un agente.
 */
function applyOps(agentKey, ops) {
  const affected = [];
  for (const op of ops) {
    try {
      if (op.mode === 'write') write(agentKey, op.file, op.content);
      else append(agentKey, op.file, op.content);
      affected.push(op.file);
      console.log(`[Memory:${agentKey}] ${op.mode} → ${op.file}`);
    } catch (err) {
      console.error(`[Memory:${agentKey}] Error en ${op.mode} ${op.file}:`, err.message);
    }
  }
  return affected;
}

// ─── SQLite — Schema y conexión ──────────────────────────────────────────────

let db = null;

const DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_key     TEXT NOT NULL,
    filename      TEXT NOT NULL,
    title         TEXT NOT NULL,
    content       TEXT NOT NULL,
    importance    INTEGER DEFAULT 5,
    access_count  INTEGER DEFAULT 0,
    last_accessed DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_key, filename)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS note_tags (
    note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER REFERENCES tags(id)  ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS note_links (
    from_id         INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    to_id           INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    co_access_count INTEGER DEFAULT 0,
    type            TEXT DEFAULT 'explicit',
    PRIMARY KEY (from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS consolidation_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_key   TEXT NOT NULL,
    chat_id     TEXT,
    turns       TEXT NOT NULL,          -- JSON: [{text, types, ts}]
    source      TEXT DEFAULT 'signal',  -- 'signal' | 'session_end' | 'manual'
    status      TEXT DEFAULT 'pending', -- 'pending' | 'processing' | 'done' | 'error'
    error       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS note_embeddings (
    note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,           -- 'openai' | 'gemini'
    model      TEXT NOT NULL,           -- nombre exacto del modelo de embeddings
    vector     TEXT NOT NULL,           -- JSON array de floats
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (note_id, provider)
  );
`;

function initDB() {
  try {
    const Database = require('./storage/sqlite-wrapper');
    if (!Database.isInitialized()) {
      // sql.js aún no inicializado — se llamará initDBAsync() después
      console.log('[Memory] sql.js pendiente, initDB diferido');
      return;
    }
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    db = new Database(path.join(MEMORY_DIR, 'index.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(DB_SCHEMA);

    // Índices para performance
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent_key);
        CREATE INDEX IF NOT EXISTS idx_queue_status ON consolidation_queue(status);
        CREATE INDEX IF NOT EXISTS idx_note_links_from ON note_links(from_id);
        CREATE INDEX IF NOT EXISTS idx_note_links_to ON note_links(to_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_note ON note_embeddings(note_id);
      `);
    } catch (e) { console.error('[Memory] Error creando índices:', e.message); }

    // Crear defaults.json si no existe (primera vez)
    const defaultsPath = path.join(MEMORY_DIR, 'defaults.json');
    if (!fs.existsSync(defaultsPath)) {
      fs.writeFileSync(defaultsPath, JSON.stringify(DEFAULT_PREFERENCES, null, 2), 'utf8');
      console.log('[Memory] defaults.json creado en', defaultsPath);
    }

    // Indexar todas las notas existentes al inicio (sin bloquear)
    setImmediate(() => indexAllNotes().catch(err => {
      console.error('[Memory] Error indexando notas:', err.message);
    }));
    console.log('[Memory] SQLite inicializado →', path.join(MEMORY_DIR, 'index.db'));
  } catch (err) {
    console.error('[Memory] No se pudo inicializar SQLite:', err.message);
    db = null;
  }
}

/**
 * Inicializa sql.js WASM + SQLite. Llamar desde index.js antes de bootstrap.
 */
async function initDBAsync() {
  const Database = require('./storage/sqlite-wrapper');
  await Database.initialize();
  initDB();
}

// ─── Frontmatter YAML-lite ────────────────────────────────────────────────────

/**
 * Parser manual de frontmatter YAML (sin dependencia externa).
 * Soporta: title, tags (array inline o multiline), links (array), importance (int 1-10)
 * @returns {{ title, tags, links, importance, body }}
 */
function parseFrontmatter(content, filename) {
  const defaultTitle = filename
    ? path.basename(filename, path.extname(filename))
    : 'Sin título';

  const defaultResult = {
    title: defaultTitle,
    tags: [],
    links: [],
    importance: 5,
    body: content || '',
  };

  if (!content || !content.startsWith('---')) return defaultResult;

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return defaultResult;

  const yamlBlock = content.slice(3, endIdx).trim();
  const body      = content.slice(endIdx + 4).trim();
  const result    = { ...defaultResult, body };

  const lines = yamlBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line     = lines[i].trimEnd();
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key    = line.slice(0, colonIdx).trim().toLowerCase();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (key === 'title') {
      result.title = rawVal.replace(/^['"]|['"]$/g, '') || defaultTitle;
    } else if (key === 'importance') {
      const n = parseInt(rawVal, 10);
      if (!isNaN(n)) result.importance = Math.max(1, Math.min(10, n));
    } else if (key === 'tags' || key === 'links') {
      const arr = [];
      const inlineMatch = rawVal.match(/^\[([^\]]*)\]$/);
      if (inlineMatch) {
        // Inline: tags: [auth, jwt, node]
        for (const item of inlineMatch[1].split(',')) {
          const t = item.trim().replace(/^['"]|['"]$/g, '');
          if (t) arr.push(t.toLowerCase());
        }
        result[key] = arr;
      } else if (rawVal === '') {
        // Multiline:
        //   tags:
        //   - auth
        //   - jwt
        i++;
        while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
          const item = lines[i].replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, '');
          if (item) arr.push(item.toLowerCase());
          i++;
        }
        result[key] = arr;
        continue; // i ya incrementado dentro del while
      } else {
        // Valor único
        const t = rawVal.replace(/^['"]|['"]$/g, '');
        if (t) arr.push(t.toLowerCase());
        result[key] = arr;
      }
    }
    i++;
  }

  return result;
}

// ─── Indexado SQLite ──────────────────────────────────────────────────────────

async function indexNote(agentKey, filename) {
  if (!db) return null;

  const safeFn  = _safeName(filename);
  const content = read(agentKey, safeFn);
  if (!content) return null;

  const { title, tags, links, importance, body } = parseFrontmatter(content, safeFn);
  dbg('index', `${agentKey}/${safeFn} → title="${title}" tags=[${tags}] importance=${importance} links=[${links}]`);

  // Upsert nota
  db.prepare(`
    INSERT INTO notes (agent_key, filename, title, content, importance, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(agent_key, filename) DO UPDATE SET
      title      = excluded.title,
      content    = excluded.content,
      importance = excluded.importance,
      updated_at = CURRENT_TIMESTAMP
  `).run(agentKey, safeFn, title, body, importance);

  const note = db.prepare(
    'SELECT id FROM notes WHERE agent_key = ? AND filename = ?'
  ).get(agentKey, safeFn);
  if (!note) return null;
  const noteId = note.id;

  // Invalidar embeddings guardados (el contenido cambió → recalcular en próxima query)
  try {
    const embMod = require('./embeddings');
    embMod.invalidateVector(db, noteId);
  } catch {}

  // Actualizar tags (borra y recrea)
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  for (const tagName of tags) {
    const name = tagName.toLowerCase();
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    if (tag) {
      db.prepare(
        'INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)'
      ).run(noteId, tag.id);
    }
  }

  // Actualizar links explícitos
  for (const targetFilename of links) {
    const target = db.prepare(
      'SELECT id FROM notes WHERE agent_key = ? AND filename = ?'
    ).get(agentKey, targetFilename);
    if (target) {
      db.prepare(`
        INSERT INTO note_links (from_id, to_id, co_access_count, type)
        VALUES (?, ?, 0, 'explicit')
        ON CONFLICT(from_id, to_id) DO NOTHING
      `).run(noteId, target.id);
    }
  }

  return noteId;
}

async function indexAllNotes(agentKey) {
  if (!db) return;

  let agentDirs;
  if (agentKey) {
    agentDirs = [agentKey];
  } else if (fs.existsSync(MEMORY_DIR)) {
    agentDirs = fs.readdirSync(MEMORY_DIR).filter(d => {
      const full = path.join(MEMORY_DIR, d);
      return fs.statSync(full).isDirectory();
    });
  } else {
    agentDirs = [];
  }

  for (const key of agentDirs) {
    const files = listFiles(key).filter(f => f.filename.endsWith('.md'));
    for (const { filename } of files) {
      try {
        await indexNote(key, filename);
      } catch (err) {
        console.error(`[Memory] Error indexando ${key}/${filename}:`, err.message);
      }
    }
  }
}

// ─── Spreading Activation + ACT-R BLA + Hebb ─────────────────────────────────

const STOPWORDS = new Set([
  'de', 'en', 'el', 'la', 'que', 'es', 'un', 'una', 'y', 'a', 'por', 'con',
  'para', 'los', 'las', 'del', 'al', 'se', 'su', 'no', 'me', 'te', 'le',
  'hay', 'si', 'ya', 'lo', 'mi', 'tu', 'the', 'is', 'in', 'on', 'at', 'to',
  'of', 'and', 'or', 'not', 'with', 'this', 'that', 'tengo', 'tiene',
  'como', 'cuando', 'pero', 'porque', 'todo', 'son', 'fue', 'ser', 'has',
]);

/**
 * Quita acentos / diacríticos → "autenticación" → "autenticacion"
 */
function _stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Tabla de stems / sinónimos para español + terminología técnica.
 * Clave: prefijo normalizado (sin acentos, lowercase).
 * Valor: array de términos canónicos que se agregan como keywords adicionales.
 */
const STEM_TABLE = {
  // Identidad / acceso
  'autenti':    ['auth', 'login'],
  'autoriz':    ['auth', 'permisos'],
  'credenci':   ['auth', 'login'],
  'verific':    ['auth', 'verificacion'],
  'contrase':   ['password', 'auth'],
  'login':      ['auth', 'acceso'],
  'logout':     ['auth', 'acceso'],
  'sesion':     ['auth', 'login', 'sesion'],
  'acceso':     ['auth', 'login'],
  'entra':      ['auth', 'login', 'acceso'],
  'ingresa':    ['auth', 'login', 'acceso'],
  'ingresar':   ['auth', 'login', 'acceso'],
  'registro':   ['auth', 'usuario'],
  'usuario':    ['usuario', 'user'],
  'perfil':     ['usuario', 'perfil'],
  'cuenta':     ['usuario', 'auth'],
  'identidad':  ['auth', 'usuario'],
  // Finanzas / pagos
  'pago':       ['pago', 'finanzas'],
  'cobro':      ['pago', 'finanzas'],
  'factur':     ['factura', 'finanzas'],
  'transacc':   ['transaccion', 'pago'],
  'banco':      ['banco', 'finanzas'],
  'tarjeta':    ['tarjeta', 'pago'],
  'saldo':      ['saldo', 'finanzas'],
  'billetera':  ['billetera', 'pago'],
  'fraude':     ['fraude', 'seguridad'],
  'dinero':     ['finanzas', 'pago'],
  // Código / desarrollo
  'error':      ['error', 'bug'],
  'fallo':      ['error', 'bug'],
  'bug':        ['bug', 'error'],
  'excepci':    ['error', 'excepcion'],
  'crash':      ['error', 'crash'],
  'test':       ['testing', 'prueba'],
  'prueba':     ['testing', 'prueba'],
  'deploy':     ['deploy', 'infra'],
  'desplie':    ['deploy', 'infra'],
  'configur':   ['config', 'configuracion'],
  'instal':     ['instalacion', 'config'],
  'depend':     ['dependencia', 'config'],
  'libreria':   ['dependencia', 'libreria'],
  'paquete':    ['dependencia', 'paquete'],
  // Infraestructura
  'servidor':   ['infra', 'servidor'],
  'docker':     ['docker', 'infra'],
  'contenedor': ['docker', 'infra'],
  'base de d':  ['database', 'bd'],
  'basedatos':  ['database', 'bd'],
  'database':   ['database', 'bd'],
  'postgres':   ['postgresql', 'database'],
  'mysql':      ['mysql', 'database'],
  'redis':      ['redis', 'cache'],
  'cache':      ['cache', 'redis'],
  'api':        ['api', 'backend'],
  'endpoint':   ['api', 'backend'],
  'request':    ['api', 'http'],
  'respuesta':  ['api', 'http'],
  // Proyectos / trabajo
  'proyecto':   ['proyecto'],
  'tarea':      ['tarea', 'trabajo'],
  'ticket':     ['ticket', 'tarea'],
  'reunion':    ['reunion', 'trabajo'],
  'equipo':     ['equipo', 'trabajo'],
  'cliente':    ['cliente', 'trabajo'],
  'empresa':    ['empresa', 'trabajo'],
  // Personal
  'salud':      ['salud', 'personal'],
  'familia':    ['familia', 'personal'],
  'trabajo':    ['trabajo', 'empleo'],
  'empleo':     ['trabajo', 'empleo'],
  'estudia':    ['estudio', 'aprendizaje'],
  'aprend':     ['aprendizaje'],
  'idioma':     ['idioma', 'aprendizaje'],
  'ingles':     ['ingles', 'idioma'],
  'deporte':    ['deporte', 'salud'],
  'ejercici':   ['ejercicio', 'deporte'],
  'comida':     ['comida', 'personal'],
  'viaje':      ['viaje', 'personal'],
  // Tecnología
  'python':     ['python', 'backend'],
  'javascr':    ['javascript', 'frontend'],
  'typescr':    ['typescript', 'javascript'],
  'react':      ['react', 'frontend'],
  'node':       ['nodejs', 'backend'],
  'fastapi':    ['fastapi', 'python'],
  'django':     ['django', 'python'],
  'flask':      ['flask', 'python'],
  'express':    ['express', 'nodejs'],
};

/**
 * Expande keywords con stemming + normalización de acentos.
 * Retorna la unión de keywords originales + sus expansiones.
 * @param {string[]} keywords
 * @returns {string[]}
 */
function expandKeywords(keywords) {
  const result = new Set(keywords);
  for (const kw of keywords) {
    const norm = _stripAccents(kw);
    result.add(norm);
    // Buscar prefijos en STEM_TABLE
    for (const [prefix, expansions] of Object.entries(STEM_TABLE)) {
      if (norm.startsWith(prefix) || kw.startsWith(prefix)) {
        for (const exp of expansions) result.add(exp);
      }
    }
  }
  return [...result];
}

function extractKeywords(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-záéíóúñüa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Recuperación semántica: ACT-R BLA + Spreading Activation + pesos Hebbianos.
 * @param {string}   agentKey
 * @param {string[]} queryKeywords
 * @returns {Array<{id, filename, title, content, tags, importance, accessCount, score}>}
 */
function spreadingActivation(agentKey, queryKeywords) {
  if (!db || !queryKeywords || !queryKeywords.length) return [];

  // Expandir keywords con stemming + normalización de acentos
  const expanded = expandKeywords(queryKeywords);
  dbg('spread', `keywords=[${queryKeywords}] → expanded=[${expanded}] agent=${agentKey}`);

  // ── Paso 1a: Nodos semilla por TAGS (match exacto en expanded set) ─────────
  const placeholders = expanded.map(() => '?').join(', ');

  // Total de notas del agente (para cálculo IDF)
  const totalNotes = Math.max(1, (db.prepare(
    'SELECT COUNT(*) as cnt FROM notes WHERE agent_key = ?'
  ).get(agentKey) || {}).cnt || 1);

  // IDF por tag: log(totalNotes / notas_con_tag) — tags raros pesan más
  const tagIdfMap = new Map();
  const tagFreqs = db.prepare(`
    SELECT t.name, COUNT(DISTINCT nt.note_id) as doc_count
    FROM tags t
    JOIN note_tags nt ON t.id = nt.tag_id
    JOIN notes n      ON nt.note_id = n.id
    WHERE n.agent_key = ? AND t.name IN (${placeholders})
    GROUP BY t.name
  `).all(agentKey, ...expanded);
  for (const row of tagFreqs) {
    tagIdfMap.set(row.name, Math.log(totalNotes / Math.max(1, row.doc_count)));
  }

  dbg('spread', `IDF tags (total=${totalNotes}): ${[...tagIdfMap].map(([t, w]) => `${t}=${w.toFixed(2)}`).join(', ')}`);

  // Seeds: notas que tienen tags matcheados, con sus tags específicos
  const seeds = db.prepare(`
    SELECT n.id, n.title, n.content, n.importance, n.access_count,
           n.created_at, n.last_accessed, n.filename,
           GROUP_CONCAT(t.name) as matched_tags
    FROM notes n
    JOIN note_tags nt ON n.id = nt.note_id
    JOIN tags t       ON nt.tag_id = t.id
    WHERE n.agent_key = ? AND t.name IN (${placeholders})
    GROUP BY n.id
  `).all(agentKey, ...expanded);

  // Mapa: id → { activation, note }
  const activationMap = new Map();

  dbg('spread', `seeds por tags: ${seeds.length}`);

  for (const seed of seeds) {
    // Activación = suma de IDF de cada tag matcheado (tags raros aportan más)
    const matchedTags = seed.matched_tags ? seed.matched_tags.split(',') : [];
    let activation = matchedTags.reduce((sum, tag) => sum + (tagIdfMap.get(tag) || 1), 0);
    const titleNorm = _stripAccents(seed.title.toLowerCase());
    if (expanded.some(k => titleNorm.includes(_stripAccents(k)))) activation += 2;
    activation = Math.min(activation, 10);

    if (activationMap.has(seed.id)) {
      activationMap.get(seed.id).activation += activation;
    } else {
      activationMap.set(seed.id, { activation, note: seed });
    }
  }

  // ── Paso 1b: Nodos semilla por TÍTULO (fuzzy partial match) ───────────────
  // Notas cuyo título contiene alguna de las keywords expandidas,
  // aunque no tengan tags coincidentes. Activación menor (0.5) para diferenciar.
  const allNotes = db.prepare(
    `SELECT id, title, content, importance, access_count, created_at, last_accessed, filename
     FROM notes WHERE agent_key = ?`
  ).all(agentKey);

  let titleMatches = 0;
  for (const note of allNotes) {
    if (activationMap.has(note.id)) continue; // ya captado por tags
    const titleNorm = _stripAccents(note.title.toLowerCase());
    const hasMatch = expanded.some(k => k.length > 3 && titleNorm.includes(_stripAccents(k)));
    if (hasMatch) {
      activationMap.set(note.id, { activation: 0.5, note });
      titleMatches++;
    }
  }

  // ── Paso 1c: Nodos semilla por CONTENIDO (keywords originales largas) ───────
  // Solo keywords originales (no expandidas) con ≥5 chars para evitar falsos positivos.
  // Activación aún menor (0.3) — es el nivel más débil.
  const longOriginal = queryKeywords.filter(k => k.length >= 5);
  let contentMatches = 0;
  if (longOriginal.length > 0) {
    for (const note of allNotes) {
      if (activationMap.has(note.id)) continue; // ya captado
      const bodyNorm = _stripAccents(note.content.slice(0, 1000).toLowerCase());
      const hasMatch = longOriginal.some(k => bodyNorm.includes(_stripAccents(k)));
      if (hasMatch) {
        activationMap.set(note.id, { activation: 0.3, note });
        contentMatches++;
      }
    }
  }

  dbg('spread', `seeds por título: ${titleMatches} | por contenido: ${contentMatches} | total: ${activationMap.size}`);

  if (_isDebugOn()) {
    for (const [id, { activation, note }] of activationMap) {
      dbg('spread', `  seed id=${id} "${note.title}" activation=${activation.toFixed(2)}`);
    }
  }

  // ── Paso 2: Spreading (2 saltos, decay D=0.7) ────────────────────────────
  const D = 0.7;

  const spreadFrom = (nodeIds, hopDecay) => {
    for (const nodeId of nodeIds) {
      const seedAct = activationMap.get(nodeId)?.activation || 0;
      if (seedAct <= 0) continue;

      const links = db.prepare(`
        SELECT nl.to_id   as neighbor_id, nl.co_access_count
        FROM note_links nl WHERE nl.from_id = ?
        UNION
        SELECT nl.from_id as neighbor_id, nl.co_access_count
        FROM note_links nl WHERE nl.to_id = ?
      `).all(nodeId, nodeId);

      for (const link of links) {
        const W      = Math.min(1.0, link.co_access_count / 10);
        const spread = Math.min(1.0, (seedAct / 10) * W * hopDecay);
        if (spread < 0.01) continue;

        if (!activationMap.has(link.neighbor_id)) {
          const neighbor = db.prepare(
            'SELECT id, title, content, importance, access_count, created_at, last_accessed, filename FROM notes WHERE id = ?'
          ).get(link.neighbor_id);
          if (!neighbor) continue;
          activationMap.set(link.neighbor_id, { activation: spread, note: neighbor });
        } else {
          const entry = activationMap.get(link.neighbor_id);
          entry.activation = Math.min(1.0, entry.activation + spread);
        }
      }
    }
  };

  const seedIds  = [...activationMap.keys()];
  spreadFrom(seedIds, D);

  const hop1Ids  = [...activationMap.keys()].filter(id => !seedIds.includes(id));
  dbg('spread', `hop1 propagó a ${hop1Ids.length} vecino(s)`);
  spreadFrom(hop1Ids, D * D);

  const hop2Count = [...activationMap.keys()].filter(id => !seedIds.includes(id) && !hop1Ids.includes(id)).length;
  dbg('spread', `hop2 propagó a ${hop2Count} vecino(s) | total nodos: ${activationMap.size}`);

  if (activationMap.size === 0) return [];

  // Normalizar activaciones a [0, 1]
  const maxAct = Math.max(...[...activationMap.values()].map(e => e.activation));
  if (maxAct > 0) {
    for (const entry of activationMap.values()) {
      entry.activation = entry.activation / maxAct;
    }
  }

  // ── Paso 3: Modulación ACT-R BLA + Ebbinghaus ────────────────────────────
  const now    = Date.now();
  const scored = [];

  for (const [id, { activation, note }] of activationMap) {
    const createdAt    = note.created_at   ? new Date(note.created_at).getTime()   : now;
    const lastAccessed = note.last_accessed ? new Date(note.last_accessed).getTime() : createdAt;
    const lifetimeSec  = Math.max(1, (now - createdAt) / 1000);
    const accessCount  = Math.max(1, note.access_count || 1);
    const importance   = note.importance || 5;

    // ACT-R Base-Level Activation (Anderson, d=0.5)
    const d   = 0.5;
    const B_i = Math.log(accessCount * Math.pow(lifetimeSec, -d) / (1 - d));

    // Ebbinghaus: retention = e^(-days/S), S = importance × 7 días
    const daysSince = (now - lastAccessed) / 86400000;
    const S         = importance * 7;
    const retention = Math.exp(-daysSince / S);

    const finalScore = activation * (1 + Math.max(0, B_i)) * retention;

    const tagRows = db.prepare(`
      SELECT t.name FROM tags t
      JOIN note_tags nt ON t.id = nt.tag_id
      WHERE nt.note_id = ?
    `).all(id);

    scored.push({
      id,
      filename:    note.filename,
      title:       note.title,
      content:     note.content,
      tags:        tagRows.map(r => r.name),
      importance,
      accessCount: note.access_count,
      score:       finalScore,
    });
  }

  // ── Paso 4: Token budget (800 tokens ≈ 3200 chars) ───────────────────────
  scored.sort((a, b) => b.score - a.score);

  if (_isDebugOn()) {
    dbg('spread', 'scores finales (pre-budget):');
    for (const s of scored) {
      dbg('spread', `  id=${s.id} "${s.title}" score=${s.score.toFixed(4)} B=${
        Math.log(Math.max(1, s.accessCount||1) * Math.pow(Math.max(1,(Date.now()-Date.parse(s.note?.created_at||0))/1000), -0.5) / 0.5).toFixed(2)
      } tokens≈${Math.ceil(s.content.length/4)}`);
    }
  }

  const TOKEN_BUDGET = 800;
  let tokenCount = 0;
  const selected = [];

  for (const item of scored) {
    const tokens = Math.ceil(item.content.length / 4);
    if (tokenCount + tokens > TOKEN_BUDGET && selected.length > 0) break;
    tokenCount += tokens;
    selected.push(item);
  }

  dbg('spread', `seleccionadas: ${selected.length}/${scored.length} notas | ~${tokenCount} tokens`);
  return selected;
}

// ─── Aprendizaje Hebbiano ─────────────────────────────────────────────────────

function reinforceConnections(noteIds) {
  if (!db || !noteIds || noteIds.length < 2) return;

  for (let i = 0; i < noteIds.length; i++) {
    for (let j = i + 1; j < noteIds.length; j++) {
      const a = noteIds[i];
      const b = noteIds[j];
      db.prepare(`
        INSERT INTO note_links (from_id, to_id, co_access_count, type)
        VALUES (?, ?, 1, 'learned')
        ON CONFLICT(from_id, to_id) DO UPDATE SET co_access_count = co_access_count + 1
      `).run(a, b);
      dbg('hebb', `co_access id=${a} ↔ id=${b} +1`);
    }
  }
}

// ─── ACT-R: actualizar contadores ────────────────────────────────────────────

function trackAccess(noteIds) {
  if (!db || !noteIds || !noteIds.length) return;
  const placeholders = noteIds.map(() => '?').join(', ');
  db.prepare(`
    UPDATE notes SET
      access_count  = access_count + 1,
      last_accessed = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).run(...noteIds);
  dbg('actr', `access_count++ para ids=[${noteIds}]`);
}

// ─── Grafo para visualización ─────────────────────────────────────────────────

function buildGraph(agentKey) {
  if (!db) return { nodes: [], links: [] };

  const notesQuery = agentKey
    ? db.prepare('SELECT * FROM notes WHERE agent_key = ?').all(agentKey)
    : db.prepare('SELECT * FROM notes').all();

  const nodes = notesQuery.map(n => {
    const tagRows = db.prepare(`
      SELECT t.name FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ?
    `).all(n.id);
    return {
      id:          n.id,
      agentKey:    n.agent_key,
      filename:    n.filename,
      title:       n.title,
      tags:        tagRows.map(r => r.name),
      importance:  n.importance,
      accessCount: n.access_count,
      preview:     n.content.slice(0, 150),
    };
  });

  const linkRows = agentKey
    ? db.prepare(`
        SELECT nl.from_id, nl.to_id, nl.co_access_count, nl.type
        FROM note_links nl
        JOIN notes n1 ON nl.from_id = n1.id
        JOIN notes n2 ON nl.to_id   = n2.id
        WHERE n1.agent_key = ? AND n2.agent_key = ?
      `).all(agentKey, agentKey)
    : db.prepare('SELECT from_id, to_id, co_access_count, type FROM note_links').all();

  const links = linkRows.map(l => ({
    source: l.from_id,
    target: l.to_id,
    weight: Math.min(1.0, l.co_access_count / 10),
    type:   l.type,
  }));

  return { nodes, links };
}

// ─── Inicializar DB al cargar el módulo ──────────────────────────────────────

initDB();

// ─── Exports ─────────────────────────────────────────────────────────────────

/** Expone la instancia de DB para módulos internos (consolidator). Solo lectura de ref. */
function getDB() { return db; }

/**
 * Permite inyectar una instancia de DB externamente (desde bootstrap.js).
 * Útil cuando la DB fue inicializada antes de cargar memory.js,
 * o para reutilizar la misma instancia en toda la app.
 */
function setDB(db_) { db = db_; }

module.exports = {
  MEMORY_DIR,
  DB_SCHEMA,
  listFiles,
  read,
  write,
  append,
  remove,
  buildMemoryContext,
  TOOL_INSTRUCTIONS,
  extractMemoryOps,
  applyOps,
  // Preferencias y detección de señales
  DEFAULT_PREFERENCES,
  getPreferences,
  invalidatePrefsCache,
  resetPreferences,
  detectSignals,
  buildNudge,
  // SQLite
  parseFrontmatter,
  extractKeywords,
  expandKeywords,
  indexNote,
  indexAllNotes,
  spreadingActivation,
  reinforceConnections,
  trackAccess,
  buildGraph,
  getDB,
  setDB,
  initDBAsync,
};
