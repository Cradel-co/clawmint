'use strict';

/**
 * memory-consolidator.js
 *
 * Worker de consolidación en background.
 * Procesa la cola SQLite `consolidation_queue` lanzando haiku con `claude -p`
 * en modo auto-accept para que analice turnos pendientes y los guarde en memoria.
 *
 * Flujo:
 *   1. telegram.js llama enqueue() cuando hay _pendingMemory (señal sin save)
 *   2. processQueue() (intervalo cada 2 min) toma items pending
 *   3. Lanza `claude -p --model haiku --permission-mode auto` con instrucción precisa
 *   4. Parsea <save_memory> y <new_topic> del output
 *   5. Aplica operaciones via memory.js
 *   6. Si aparece <new_topic>, emite evento 'memory:topic-suggestion' vía events.js
 *
 * No importa telegram.js → sin dependencia circular.
 *
 * Debug: activar con DEBUG_MEMORY=1 (env) o "settings": { "debug": true } en defaults.json
 */

const childProcess = require('child_process');
const fs        = require('fs');
const path      = require('path');
const memoryModule = require('./memory');
const events       = require('./events');

// ─── Debug logger ─────────────────────────────────────────────────────────────
// Misma lógica que memory.js: env var OR settings.debug en el JSON global

function _isDebugOn() {
  if (process.env.DEBUG_MEMORY === '1') return true;
  try {
    return memoryModule.getPreferences('_global')?.settings?.debug === true;
  } catch { return false; }
}

function dbg(scope, ...args) {
  if (!_isDebugOn()) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`\x1b[36m[consolidator:${scope}]\x1b[0m \x1b[90m${ts}\x1b[0m`, ...args);
}

// ─── Estado ──────────────────────────────────────────────────────────────────

let db           = null;
let _processing  = false;
let _intervalId  = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Inicializa el consolidador con la instancia de DB de memory.js.
 * Arranca el intervalo de procesamiento cada 2 minutos.
 * @param {object} database - instancia better-sqlite3 (puede ser null)
 */
function init(database) {
  db = database;
  if (!db) {
    console.warn('[Consolidator] SQLite no disponible — consolidación deshabilitada.');
    return;
  }

  dbg('init', 'DB recibida, arrancando intervalo de 2 min');

  _intervalId = setInterval(() => {
    dbg('tick', 'intervalo disparado → processQueue()');
    processQueue().catch(err => {
      console.error('[Consolidator] Error en processQueue:', err.message);
    });
  }, 2 * 60 * 1000);
  _intervalId.unref(); // no bloquear el cierre del proceso si no hay otra actividad

  // Procesar items que quedaron pendientes del arranque anterior
  setImmediate(() => {
    dbg('init', 'procesando cola pendiente del arranque anterior');
    processQueue().catch(() => {});
  });

  console.log('[Consolidator] Iniciado — procesando cada 2 min.');
}

// ─── Encolar ─────────────────────────────────────────────────────────────────

/**
 * Agrega ítems a la cola de consolidación.
 * @param {string}   agentKey - clave del agente de memoria
 * @param {string}   chatId   - ID del chat de Telegram (string)
 * @param {object[]} turns    - array de { text, types, ts }
 * @param {string}   source   - 'signal' | 'session_end' | 'manual'
 */
function enqueue(agentKey, chatId, turns, source = 'signal') {
  if (!db) {
    dbg('enqueue', `SKIP — sin DB (agent=${agentKey})`);
    return;
  }
  if (!turns || !turns.length) {
    dbg('enqueue', `SKIP — turns vacío (agent=${agentKey})`);
    return;
  }

  const prefs = memoryModule.getPreferences(agentKey);
  if (prefs.settings.consolidationEnabled === false) {
    dbg('enqueue', `SKIP — consolidation deshabilitado por prefs (agent=${agentKey})`);
    return;
  }

  try {
    const result = db.prepare(`
      INSERT INTO consolidation_queue (agent_key, chat_id, turns, source)
      VALUES (?, ?, ?, ?)
    `).run(agentKey, String(chatId || ''), JSON.stringify(turns), source);

    dbg('enqueue', `OK id=${result.lastInsertRowid} agent=${agentKey} source=${source} turns=${turns.length}`);
    if (_isDebugOn()) {
      for (const [i, t] of turns.entries()) {
        dbg('enqueue', `  [${i + 1}] types=[${t.types?.join(',')||'?'}] text="${t.text?.slice(0, 80)}"`);
      }
    }
  } catch (err) {
    console.error('[Consolidator] Error encolando:', err.message);
  }
}

// ─── Procesar cola ────────────────────────────────────────────────────────────

async function processQueue() {
  if (!db) { dbg('queue', 'SKIP — sin DB'); return; }
  if (_processing) { dbg('queue', 'SKIP — ya procesando'); return; }

  _processing = true;
  const t0 = Date.now();

  try {
    const pending = db.prepare(`
      SELECT * FROM consolidation_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 5
    `).all();

    if (!pending.length) {
      dbg('queue', 'cola vacía — nada que hacer');
      return;
    }

    dbg('queue', `${pending.length} item(s) pendiente(s) → procesando`);

    for (const item of pending) {
      dbg('queue', `→ item id=${item.id} agent=${item.agent_key} source=${item.source} created=${item.created_at}`);
      await _processItem(item);
    }

    dbg('queue', `lote completado en ${Date.now() - t0}ms`);
  } finally {
    _processing = false;
  }
}

// ─── Procesar un ítem ─────────────────────────────────────────────────────────

async function _processItem(item) {
  const t0 = Date.now();
  dbg('item', `inicio id=${item.id} agent=${item.agent_key}`);

  // Marcar como procesando
  db.prepare(`UPDATE consolidation_queue SET status = 'processing' WHERE id = ?`).run(item.id);

  let turns;
  try {
    turns = JSON.parse(item.turns);
    dbg('item', `turns parseados: ${turns.length} fragmento(s)`);
  } catch (err) {
    dbg('item', `ERROR parseando turns: ${err.message}`);
    _markError(item.id, 'JSON inválido en turns');
    return;
  }

  const agentKey = item.agent_key;
  const prefs    = memoryModule.getPreferences(agentKey);
  const topics   = (prefs.topics || []).map(t => t.name).join(', ') || 'ninguno configurado';

  dbg('item', `prefs cargadas — tópicos: [${topics}] nudge=${prefs.settings.nudgeEnabled}`);

  // Recuperar notas existentes del agente para contexto
  let existingNotes = '';
  try {
    const noteRows = db.prepare(`
      SELECT title, filename FROM notes WHERE agent_key = ?
      ORDER BY updated_at DESC LIMIT 5
    `).all(agentKey);
    if (noteRows.length) {
      existingNotes = '\nNotas ya guardadas: ' + noteRows.map(n => `"${n.title}" (${n.filename})`).join(', ');
      dbg('item', `contexto existente: ${noteRows.length} nota(s) →${existingNotes}`);
    } else {
      dbg('item', 'sin notas previas para este agente');
    }
  } catch (err) {
    dbg('item', `WARN al recuperar notas existentes: ${err.message}`);
  }

  const turnsSummary = turns.map((t, i) =>
    `[${i + 1}] ${t.types?.join(',')||'?'}: "${t.text?.slice(0, 200)}"`
  ).join('\n');

  const prompt = buildConsolidationPrompt(agentKey, turnsSummary, topics, existingNotes);
  dbg('item', `prompt construido (${prompt.length} chars)`);
  if (_isDebugOn()) {
    dbg('item', '─── prompt ───────────────────────────────────────────');
    for (const line of prompt.split('\n').slice(0, 20)) dbg('item', `  ${line}`);
    if (prompt.split('\n').length > 20) dbg('item', `  … (${prompt.split('\n').length} líneas total)`);
    dbg('item', '──────────────────────────────────────────────────────');
  }

  dbg('item', `lanzando haiku…`);
  const t1 = Date.now();
  let output = '';
  try {
    output = await _runHaiku(prompt, agentKey);
    dbg('item', `haiku completó en ${Date.now() - t1}ms — output: ${output.length} chars`);
  } catch (err) {
    dbg('item', `ERROR en haiku: ${err.message}`);
    _markError(item.id, err.message);
    return;
  }

  if (_isDebugOn()) {
    dbg('item', '─── output haiku ────────────────────────────────────');
    for (const line of output.split('\n').slice(0, 30)) dbg('item', `  ${line}`);
    if (output.split('\n').length > 30) dbg('item', `  … (${output.split('\n').length} líneas total)`);
    dbg('item', '──────────────────────────────────────────────────────');
  }

  // Parsear y aplicar <save_memory>
  const { ops } = memoryModule.extractMemoryOps(output);
  dbg('item', `operaciones de memoria extraídas: ${ops.length}`);
  if (ops.length > 0) {
    for (const op of ops) {
      dbg('item', `  ${op.mode} → "${op.file}" (${op.content.length} chars)`);
    }
    const saved = memoryModule.applyOps(agentKey, ops);
    console.log(`[Consolidator] ${agentKey} → guardado: ${saved.join(', ')}`);
  } else {
    dbg('item', 'output no contiene <save_memory> — nada guardado');
  }

  // Parsear <new_topic> → emitir sugerencia
  const newTopics = _extractNewTopics(output);
  dbg('item', `nuevos tópicos detectados: ${newTopics.length} → [${newTopics.join(', ')}]`);
  for (const topicName of newTopics) {
    const alreadyExists = (prefs.topics || []).some(t =>
      t.name.toLowerCase() === topicName.toLowerCase()
    );
    if (alreadyExists) {
      dbg('item', `  tópico "${topicName}" ya existe en prefs — ignorando`);
    } else {
      dbg('item', `  emitiendo memory:topic-suggestion para "${topicName}" → chatId=${item.chat_id}`);
      events.emit('memory:topic-suggestion', {
        agentKey,
        chatId:      item.chat_id,
        topicName,
        sourceItemId: item.id,
      });
    }
  }

  // Marcar como done
  db.prepare(
    `UPDATE consolidation_queue SET status = 'done', processed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(item.id);
  dbg('item', `DONE id=${item.id} en ${Date.now() - t0}ms`);
}

// ─── Construir prompt ─────────────────────────────────────────────────────────

function buildConsolidationPrompt(agentKey, turnsSummary, topics, existingNotes) {
  return `Sos un asistente de memoria. Tu única tarea es analizar estos fragmentos de conversación y decidir si merecen guardarse en memoria persistente.

Agente: ${agentKey}
Tópicos de interés configurados: ${topics}${existingNotes}

Fragmentos a analizar:
${turnsSummary}

Instrucciones ESTRICTAS:
1. Si algún fragmento contiene información valiosa para recordar (preferencias, datos personales, eventos de vida, conocimiento técnico aprendido), guardala con <save_memory>.
2. Usá SIEMPRE frontmatter con title, tags específicos (sustantivos del contenido, NO "personal" o "usuario"), e importance (1-10).
3. Si detectás un tema nuevo que no está en los tópicos configurados y que sería útil rastrear, indicalo con <new_topic>nombre_del_tema</new_topic>.
4. Si nada vale guardarse, respondé solo: "nada que guardar".
5. NO expliques ni comentes. Solo etiquetas o "nada que guardar".

Formato de etiquetas:
<save_memory file="nombre-descriptivo.md">
---
title: Título corto
tags: [tag1, tag2, tag3]
importance: 7
---

Contenido conciso de lo que debe recordarse.
</save_memory>

<new_topic>nombre_del_topico</new_topic>`;
}

// ─── Extraer new_topic ────────────────────────────────────────────────────────

function _extractNewTopics(text) {
  const topics = [];
  const regex  = /<new_topic>([^<]+)<\/new_topic>/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (name) topics.push(name);
  }
  return topics;
}

// ─── Ejecutar haiku ───────────────────────────────────────────────────────────

function _runHaiku(prompt, agentKey) {
  return new Promise((resolve, reject) => {
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '-p',
      '--model', 'claude-haiku-4-5-20251001',
      '--output-format', 'text',
    ];

    const cwd = path.join(memoryModule.MEMORY_DIR, agentKey);
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    // Sanitizar env
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    dbg('haiku', `spawn: claude ${claudeArgs.join(' ')}`);
    dbg('haiku', `cwd: ${cwd}`);

    const child = childProcess.spawn('claude', claudeArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout    = '';
    let stderr    = '';
    let timedOut  = false;
    let stdoutLen = 0;

    const timeout = setTimeout(() => {
      timedOut = true;
      dbg('haiku', 'TIMEOUT (30s) — matando proceso');
      child.kill('SIGTERM');
      reject(new Error('haiku timeout (30s)'));
    }, 30000);

    child.stdout.on('data', chunk => {
      const str = chunk.toString();
      stdout   += str;
      stdoutLen += str.length;
      dbg('haiku', `stdout chunk ${str.length} chars (total ${stdoutLen})`);
    });

    child.stderr.on('data', chunk => {
      const str = chunk.toString();
      stderr += str;
      dbg('haiku', `stderr: ${str.slice(0, 200).replace(/\n/g, '↵')}`);
    });

    child.stdin.write(prompt);
    child.stdin.end();
    dbg('haiku', `prompt enviado por stdin (${prompt.length} chars)`);

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;
      dbg('haiku', `proceso cerrado — code=${code} signal=${signal} stdout=${stdout.length} chars stderr=${stderr.length} chars`);
      if (code !== 0 && !stdout.trim()) {
        dbg('haiku', `ERROR — stderr completo: ${stderr.slice(0, 500)}`);
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        if (code !== 0) {
          dbg('haiku', `WARN: código de salida ${code} pero hay stdout — usando output igual`);
        }
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      dbg('haiku', `ERROR spawn: ${err.message}`);
      reject(err);
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _markError(itemId, errorMsg) {
  try {
    db.prepare(
      `UPDATE consolidation_queue SET status = 'error', error = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(errorMsg, itemId);
  } catch {}
  console.error(`[Consolidator] item=${itemId} error: ${errorMsg}`);
  dbg('error', `item=${itemId} → ${errorMsg}`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getStats(agentKey) {
  if (!db) { dbg('stats', 'sin DB'); return null; }

  const rows = agentKey
    ? db.prepare(`SELECT status, COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ? GROUP BY status`).all(agentKey)
    : db.prepare(`SELECT status, COUNT(*) as cnt FROM consolidation_queue GROUP BY status`).all();

  const stats = { pending: 0, processing: 0, done: 0, error: 0 };
  for (const row of rows) {
    if (row.status in stats) stats[row.status] = row.cnt;
  }

  dbg('stats', `agent=${agentKey || 'global'} →`, JSON.stringify(stats));
  return stats;
}

// ─── Agregar tópico ───────────────────────────────────────────────────────────

/**
 * Agrega un tópico a las preferencias del agente.
 * @param {string} agentKey
 * @param {string} topicName  - nombre normalizado (snake_case)
 * @param {string} [description]
 * @returns {boolean} true si se agregó, false si ya existía
 */
function addTopic(agentKey, topicName, description = '') {
  const agentDir  = path.join(memoryModule.MEMORY_DIR, agentKey);
  const prefsPath = path.join(agentDir, 'preferences.json');

  dbg('addTopic', `agentKey=${agentKey} topicName="${topicName}"`);

  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

  let current = {};
  if (fs.existsSync(prefsPath)) {
    try {
      current = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      dbg('addTopic', `preferences.json cargado — topics existentes: ${(current.topics||[]).map(t=>t.name).join(', ') || 'ninguno'}`);
    } catch (err) {
      dbg('addTopic', `WARN al parsear preferences.json: ${err.message}`);
    }
  } else {
    dbg('addTopic', 'preferences.json no existe — se creará');
  }

  if (!current.topics) current.topics = [];

  const alreadyExists = current.topics.some(t =>
    t.name.toLowerCase() === topicName.toLowerCase()
  );

  if (alreadyExists) {
    dbg('addTopic', `tópico "${topicName}" ya existe — SKIP`);
    return false;
  }

  const newTopic = {
    name:        topicName,
    description: description || topicName.replace(/_/g, ' '),
    keywords:    [],
    autoSave:    true,
    learnedAt:   new Date().toISOString().slice(0, 10),
  };
  current.topics.push(newTopic);

  memoryModule.write(agentKey, 'preferences.json', JSON.stringify(current, null, 2));
  dbg('addTopic', `tópico "${topicName}" agregado para agent=${agentKey} →`, JSON.stringify(newTopic));
  return true;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,
  enqueue,
  processQueue,
  getStats,
  addTopic,
};
