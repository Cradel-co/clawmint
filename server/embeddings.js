'use strict';

const path = require('path');

/**
 * embeddings.js
 *
 * Soporte de embeddings vectoriales para recuperación semántica.
 * Providers soportados: local (bge-small), openai, gemini.
 *
 * Provider local usa @huggingface/transformers con bge-small-en-v1.5 (384 dims, ~130 MB).
 * Se carga lazy, auto-descarga después de 5min inactivo.
 * Usa ModelResourceManager para no coexistir con Whisper en memoria.
 *
 * Los vectores se guardan en SQLite (note_embeddings) como JSON serializado.
 */

const modelManager = require('./core/ModelResourceManager');

// ─── Modelos de embeddings por provider ──────────────────────────────────────

const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5'; // 384 dims, ~130 MB
const LOCAL_MEMORY_REQUIRED = 200 * 1024 * 1024; // 200 MB headroom
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

const EMBED_MODELS = {
  local:   LOCAL_MODEL,                 // 384 dims
  openai:  'text-embedding-3-small',    // 1536 dims
  gemini:  'gemini-embedding-001',      // 3072 dims
};

// Providers que soportan embeddings
const SUPPORTED = new Set(['local', 'openai', 'gemini']);

/** Retorna true si el provider tiene API de embeddings */
function supportsEmbeddings(provider) {
  return SUPPORTED.has(provider);
}

// ─── Modelo local (bge-small) ────────────────────────────────────────────────

let _localPipeline = null;
let _localLoading = null;
let _idleTimer = null;

function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _unloadLocal(), IDLE_TIMEOUT_MS);
}

function _unloadLocal() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_localPipeline) {
    _localPipeline = null;
    modelManager.release('embeddings');
    console.log('[embeddings] Modelo local descargado por inactividad');
    if (typeof global.gc === 'function') global.gc();
  }
}

async function _loadLocal() {
  if (_localPipeline) { _resetIdleTimer(); return _localPipeline; }
  if (_localLoading) return _localLoading;

  _localLoading = (async () => {
    try {
      // Verificar memoria antes de cargar
      if (!modelManager.checkMemory(LOCAL_MEMORY_REQUIRED)) {
        const info = modelManager.memoryInfo();
        throw new Error(`Memoria insuficiente para embeddings: disponible ${info.heapAvailableMB}MB, necesario ~200MB`);
      }

      // Adquirir slot (descarga Whisper si está cargado)
      await modelManager.acquire('embeddings', _unloadLocal);

      console.log(`[embeddings] Cargando modelo local ${LOCAL_MODEL}...`);
      let pipeline, env;
      try {
        ({ pipeline, env } = await import('@huggingface/transformers'));
      } catch (importErr) {
        throw new Error(`@huggingface/transformers no instalado: ${importErr.message}`);
      }
      env.cacheDir = path.join(__dirname, 'models-cache');

      _localPipeline = await pipeline('feature-extraction', LOCAL_MODEL, {
        dtype: 'q8',
        device: 'cpu',
      });

      console.log(`[embeddings] Modelo local cargado OK`);
      _resetIdleTimer();
      return _localPipeline;
    } catch (err) {
      _localPipeline = null;
      modelManager.release('embeddings');
      throw err;
    } finally {
      _localLoading = null;
    }
  })();
  return _localLoading;
}

/**
 * Genera embedding local con bge-small.
 * @param {string} text
 * @returns {Promise<number[]>} vector de 384 dimensiones
 */
async function embedLocal(text) {
  const pipe = await _loadLocal();
  const output = await pipe(text, { pooling: 'cls', normalize: true });
  // Transformers.js puede retornar Tensor con .data (Float32Array) o array directo
  if (output?.data) return Array.from(output.data);
  if (output?.tolist) return output.tolist();
  if (Array.isArray(output)) return output;
  throw new Error('Formato de embedding local no reconocido');
}

// ─── API calls de embeddings ──────────────────────────────────────────────────

/**
 * Calcula el embedding de un texto usando el provider indicado.
 * @param {string} text
 * @param {string} provider   'openai' | 'gemini'
 * @param {string} apiKey
 * @returns {Promise<number[]>}
 */
async function embed(text, provider, apiKey) {
  if (!text || !text.trim()) throw new Error('Texto vacío');
  const truncated = text.slice(0, 8000);

  if (provider === 'local') {
    return embedLocal(truncated);
  }

  if (provider === 'openai') {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({
      model: EMBED_MODELS.openai,
      input: truncated,
    });
    return res.data[0].embedding;
  }

  if (provider === 'gemini') {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.embedContent({
      model: EMBED_MODELS.gemini,
      contents: truncated,
    });
    return res.embeddings[0].values;
  }

  throw new Error(`Provider "${provider}" no soporta embeddings`);
}

// ─── Álgebra vectorial ────────────────────────────────────────────────────────

/**
 * Similitud coseno entre dos vectores. Rango [0, 1].
 * Retorna 0 si alguno es nulo o de longitud 0.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Caché en memoria (SQLite como almacenamiento persistente) ────────────────

// Caché en RAM para evitar deserializar JSON en cada query
// key: `${noteId}:${provider}` → Float32Array o null
const _vectorCache = new Map();

function _cacheKey(noteId, provider) { return `${noteId}:${provider}`; }

/**
 * Obtiene el vector de una nota desde SQLite.
 * @param {object} db   instancia better-sqlite3
 * @param {number} noteId
 * @param {string} provider
 * @returns {number[]|null}
 */
function getVector(db, noteId, provider) {
  const k = _cacheKey(noteId, provider);
  if (_vectorCache.has(k)) return _vectorCache.get(k);

  const row = db.prepare(
    'SELECT vector FROM note_embeddings WHERE note_id = ? AND provider = ?'
  ).get(noteId, provider);

  if (!row) { _vectorCache.set(k, null); return null; }

  try {
    const vec = JSON.parse(row.vector);
    _vectorCache.set(k, vec);
    return vec;
  } catch {
    return null;
  }
}

/**
 * Guarda el vector de una nota en SQLite.
 * @param {object} db
 * @param {number} noteId
 * @param {string} provider
 * @param {number[]} vector
 */
function saveVector(db, noteId, provider, vector) {
  db.prepare(`
    INSERT INTO note_embeddings (note_id, provider, model, vector)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (note_id, provider) DO UPDATE SET
      vector = excluded.vector,
      model  = excluded.model,
      updated_at = CURRENT_TIMESTAMP
  `).run(noteId, provider, EMBED_MODELS[provider] || provider, JSON.stringify(vector));

  _vectorCache.set(_cacheKey(noteId, provider), vector);
}

/**
 * Invalida el vector de una nota (llamar cuando se actualiza el contenido).
 */
function invalidateVector(db, noteId, provider) {
  if (provider) {
    db.prepare('DELETE FROM note_embeddings WHERE note_id = ? AND provider = ?').run(noteId, provider);
    _vectorCache.delete(_cacheKey(noteId, provider));
  } else {
    // Invalida todos los providers para esa nota
    db.prepare('DELETE FROM note_embeddings WHERE note_id = ?').run(noteId);
    for (const k of _vectorCache.keys()) {
      if (k.startsWith(`${noteId}:`)) _vectorCache.delete(k);
    }
  }
}

// ─── Búsqueda por similitud ───────────────────────────────────────────────────

/**
 * Recupera las notas más similares a un texto usando embeddings.
 * Si alguna nota no tiene vector guardado, lo calcula y lo persiste (lazy).
 *
 * @param {object}   db
 * @param {string}   agentKey
 * @param {string}   queryText
 * @param {string}   provider
 * @param {string}   apiKey
 * @param {object}   [opts]
 * @param {number}   [opts.topK=5]          Máximo de notas a retornar
 * @param {number}   [opts.minScore=0.30]   Similitud mínima (0=cualquiera, 1=idéntico)
 * @param {number}   [opts.tokenBudget=800] Budget en tokens (~chars/4)
 * @returns {Promise<Array<{id, filename, title, content, tags, importance, score}>>}
 */
async function searchByEmbedding(db, agentKey, queryText, provider, apiKey, opts = {}) {
  const { topK = 5, minScore = 0.30, tokenBudget = 800 } = opts;

  // 1. Embedding del query
  const queryVec = await embed(queryText, provider, apiKey);

  // 2. Obtener todas las notas del agente
  const notes = db.prepare(`
    SELECT n.id, n.filename, n.title, n.content, n.importance, n.access_count,
           n.created_at, n.last_accessed
    FROM notes n
    WHERE n.agent_key = ?
  `).all(agentKey);

  if (!notes.length) return [];

  // 3. Calcular similitud (computar vectores faltantes lazy)
  const scored = [];
  const toCompute = [];

  for (const note of notes) {
    const vec = getVector(db, note.id, provider);
    if (vec) {
      const sim = cosineSimilarity(queryVec, vec);
      scored.push({ ...note, score: sim });
    } else {
      toCompute.push(note);
    }
  }

  // 4. Computar vectores faltantes en paralelo (máx 10 a la vez)
  const BATCH = 10;
  for (let i = 0; i < toCompute.length; i += BATCH) {
    const batch = toCompute.slice(i, i + BATCH);
    await Promise.all(batch.map(async note => {
      try {
        const text = `${note.title}\n${note.content}`.slice(0, 4000);
        const vec  = await embed(text, provider, apiKey);
        saveVector(db, note.id, provider, vec);
        const sim  = cosineSimilarity(queryVec, vec);
        scored.push({ ...note, score: sim });
      } catch (err) {
        // Si falla el embedding de una nota, ignorarla silenciosamente
        console.error(`[Embeddings] Error vectorizando nota ${note.id}:`, err.message);
      }
    }));
  }

  // 5. Filtrar por score mínimo, ordenar y aplicar token budget
  const filtered = scored
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // 6. Obtener tags para las notas top
  let tokenCount = 0;
  const selected = [];
  for (const item of filtered) {
    if (selected.length >= topK) break;
    const tokens = Math.ceil(item.content.length / 4);
    if (tokenCount + tokens > tokenBudget && selected.length > 0) break;
    tokenCount += tokens;

    const tagRows = db.prepare(`
      SELECT t.name FROM tags t
      JOIN note_tags nt ON t.id = nt.tag_id
      WHERE nt.note_id = ?
    `).all(item.id);

    selected.push({
      id:          item.id,
      filename:    item.filename,
      title:       item.title,
      content:     item.content,
      tags:        tagRows.map(r => r.name),
      importance:  item.importance,
      accessCount: item.access_count,
      score:       item.score,
    });
  }

  return selected;
}

module.exports = {
  supportsEmbeddings,
  embed,
  embedLocal,
  cosineSimilarity,
  getVector,
  saveVector,
  invalidateVector,
  searchByEmbedding,
  EMBED_MODELS,
  LOCAL_MODEL,
  unloadLocal: _unloadLocal,
};
