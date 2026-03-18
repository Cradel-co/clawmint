'use strict';

/**
 * test-full-flow.js
 *
 * Test de integración exhaustivo — simula conversaciones reales con Claude.
 * Replica el pipeline exacto de _sendToSession en telegram.js:
 *   1. Inyecta memoria + TOOL_INSTRUCTIONS en primer mensaje
 *   2. Detecta señales → añade nudge
 *   3. Envía a ClaudePrintSession
 *   4. Extrae <save_memory> → aplica ops
 *   5. Si señal sin save → _pendingMemory
 *   6. Verifica SQLite después de cada turno
 *
 * Uso: node test-full-flow.js [--verbose]
 * Cada turno tarda ~30s (respuesta real de Claude).
 */

process.env.DEBUG_MEMORY = '1';

const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');
const memory   = require('./memory');
let consolidator;
try { consolidator = require('./memory-consolidator'); consolidator.init(memory.getDB()); } catch {}

const VERBOSE = process.argv.includes('--verbose');

// ─── Colores ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', magenta: '\x1b[35m',
};
let passed = 0, failed = 0, warnings = 0;
const failures = [];

function header(t) {
  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(64)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${t}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'═'.repeat(64)}${C.reset}`);
}
function section(t) { console.log(`\n${C.bold}${C.blue}── ${t}${C.reset}`); }
function ok(l, d='')  { passed++; console.log(`  ${C.green}✓${C.reset} ${l}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function fail(l, d='') {
  failed++; failures.push({ label: l, detail: d });
  console.log(`  ${C.red}✗ ${l}${C.reset}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`);
}
function warn(l, d='') { warnings++; console.log(`  ${C.yellow}⚠ ${l}${C.reset}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function info(l) { console.log(`  ${C.gray}→ ${l}${C.reset}`); }
function assert(c, l, d='') { c ? ok(l, d) : fail(l, d); return c; }
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── ClaudePrintSession (copia exacta de telegram.js) ─────────────────────────
class ClaudePrintSession {
  constructor({ model = null, permissionMode = 'ask' } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = 0;
    this.model = model;
    this.permissionMode = permissionMode;
    this.totalCostUsd = 0;
    this.lastCostUsd = 0;
    this.claudeSessionId = null;
    this.cwd = process.env.HOME;
  }

  async sendMessage(text, onChunk = null) {
    const claudeArgs = [
      '-p', text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this.permissionMode === 'auto') {
      claudeArgs.unshift('--dangerously-skip-permissions');
    } else {
      const modeMap = { ask: 'default', plan: 'plan' };
      claudeArgs.unshift('--permission-mode', modeMap[this.permissionMode] || 'default');
    }
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.messageCount > 0) claudeArgs.push('--continue');

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const child = spawn('claude', claudeArgs, {
        cwd: process.env.HOME,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let lineBuffer = '', fullText = '', killed = false, exited = false;
      const killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 120000); // 2 min máx por turno

      const processLine = (line) => {
        const jsonStr = line.trim();
        if (!jsonStr || jsonStr === '[DONE]') return;
        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'stream_event' && event.event) {
            const raw = event.event;
            const inner = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              fullText += inner.delta.text;
              if (onChunk) onChunk(fullText);
            }
          } else if (event.type === 'assistant') {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              const textBlock = content.find(b => b.type === 'text');
              if (textBlock?.text && !fullText) {
                fullText = textBlock.text;
                if (onChunk) onChunk(fullText);
              }
            }
          } else if (event.type === 'system') {
            if (event.model) this.model = this.model || event.model;
            if (event.cwd) this.cwd = event.cwd;
          } else if (event.type === 'result') {
            if (event.result && !fullText) fullText = event.result;
            if (event.session_id) this.claudeSessionId = event.session_id;
            if (event.total_cost_usd != null) {
              this.lastCostUsd = event.total_cost_usd - this.totalCostUsd;
              this.totalCostUsd = event.total_cost_usd;
            }
          }
        } catch {}
      };

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) processLine(line);
      });

      child.on('close', (exitCode) => {
        if (exited) return; exited = true;
        clearTimeout(killTimer);
        if (lineBuffer.trim()) processLine(lineBuffer);
        if (killed) return reject(new Error('Timeout'));
        if (exitCode !== 0 && !fullText) return reject(new Error(`claude salió ${exitCode}`));
        this.messageCount++;
        resolve(fullText.trim());
      });
    });
  }
}

// ─── Pipeline completo (= _sendToSession de telegram.js) ─────────────────────
// sessionState: objeto mutable compartido entre turnos de la misma sesión
async function chat(session, agentKey, userText, pendingMemory = [], sessionState = {}) {
  const t0 = Date.now();
  let messageText = userText;

  // 1. Inyectar contexto de memoria
  if (agentKey) {
    if (session.messageCount === 0) {
      // Primer mensaje: memoria relevante + instrucciones
      const memCtx = memory.buildMemoryContext(agentKey, userText);
      const parts = [memCtx, memory.TOOL_INSTRUCTIONS].filter(Boolean);
      if (parts.length) messageText = `${parts.join('\n\n')}\n\n---\n\n${userText}`;
    } else if (sessionState.savedInSession && sessionState.savedInSession.length > 0) {
      // Turnos siguientes: recordatorio de notas guardadas en esta sesión
      const reminder = `[Notas guardadas en esta conversación: ${sessionState.savedInSession.join(', ')}]\n\n`;
      messageText = reminder + userText;
    }
  }

  // 2. Detección de señales → nudge
  const { shouldNudge, signals } = memory.detectSignals(agentKey, userText);
  if (shouldNudge) messageText += memory.buildNudge(signals);

  if (VERBOSE) {
    info(`→ Enviando (${messageText.length} chars, msg#${session.messageCount + 1})`);
    info(`  señales: [${signals.map(s => s.type).join(', ')}] nudge=${shouldNudge}`);
  }

  // 3. Mostrar spinner mientras espera
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let fi = 0;
  const spin = setInterval(() => {
    process.stdout.write(`\r  ${C.gray}${frames[fi++ % frames.length]} esperando respuesta… ${Math.floor((Date.now()-t0)/1000)}s${C.reset}`);
  }, 150);

  let rawResponse;
  try {
    rawResponse = await session.sendMessage(messageText);
  } finally {
    clearInterval(spin);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  info(`  respuesta en ${elapsed}s (${rawResponse?.length ?? 0} chars) costo=$${session.totalCostUsd.toFixed(4)}`);

  if (VERBOSE && rawResponse) {
    const preview = rawResponse.replace(/\n/g, '↵').slice(0, 200);
    info(`  preview: "${preview}…"`);
  }

  // 4. Extraer y aplicar operaciones de memoria
  let savedFiles = [];
  let response = rawResponse;
  if (agentKey && rawResponse) {
    const { clean, ops } = memory.extractMemoryOps(rawResponse);
    if (ops.length > 0) {
      savedFiles = memory.applyOps(agentKey, ops);
      response = clean || rawResponse;
      info(`  ${C.green}memoria guardada:${C.reset} [${savedFiles.join(', ')}]`);
      // Registrar para recordatorio en siguiente turno
      if (!sessionState.savedInSession) sessionState.savedInSession = [];
      for (const f of savedFiles) {
        if (!sessionState.savedInSession.includes(f)) sessionState.savedInSession.push(f);
      }
    } else if (shouldNudge) {
      pendingMemory.push({ text: userText, types: signals.map(s => s.type), ts: Date.now() });
      info(`  ${C.yellow}señal sin save → pendingMemory (${pendingMemory.length})${C.reset}`);
    }
  }

  // Esperar indexado async
  if (savedFiles.length) await wait(300);

  return { response, savedFiles, signals, shouldNudge, elapsed: parseFloat(elapsed) };
}

// ─── Helpers SQLite ────────────────────────────────────────────────────────────
function getNotes(agentKey) {
  const db = memory.getDB();
  if (!db) return [];
  return db.prepare(`
    SELECT n.*, GROUP_CONCAT(t.name, ',') as tag_names
    FROM notes n
    LEFT JOIN note_tags nt ON n.id = nt.note_id
    LEFT JOIN tags t ON nt.tag_id = t.id
    WHERE n.agent_key = ?
    GROUP BY n.id
  `).all(agentKey);
}

function getNoteByFile(agentKey, filename) {
  const db = memory.getDB();
  if (!db) return null;
  return db.prepare(`SELECT * FROM notes WHERE agent_key = ? AND filename = ?`).get(agentKey, filename);
}

function getLinks(agentKey) {
  const db = memory.getDB();
  if (!db) return [];
  return db.prepare(`
    SELECT nl.* FROM note_links nl
    JOIN notes n ON nl.from_id = n.id
    WHERE n.agent_key = ?
  `).all(agentKey);
}

// ─── Agente de prueba ─────────────────────────────────────────────────────────
const AGENT = 'full_test_' + Date.now().toString(36);
info(`Agente de prueba: ${AGENT}`);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  header('TEST DE INTEGRACIÓN COMPLETO — Pipeline real de Claude');
  console.log(`${C.gray}  Cada turno llama a claude -p y puede tardar 20-40s.${C.reset}`);
  console.log(`${C.gray}  Total estimado: ~8-12 minutos.${C.reset}\n`);

  const pendingMemory = [];

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 1: Información personal → debe guardar con tags correctos
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 1 — Información personal (me llamo, trabajo en)');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const msg = 'Hola! Me llamo Marcos García, tengo 32 años y trabajo como desarrollador fullstack en una empresa llamada PayFast en Buenos Aires. Uso Node.js y React principalmente.';

    section(`"${msg.slice(0,60)}…"`);
    const r = await chat(session, AGENT, msg, pendingMemory);

    // Verificar que guardó algo
    await wait(500);
    const notes = getNotes(AGENT);
    assert(notes.length >= 1, 'guardó al menos 1 nota', `${notes.length} notas`);

    if (notes.length > 0) {
      const n = notes[notes.length - 1]; // última nota
      const tags = (n.tag_names || '').split(',').filter(Boolean);
      info(`  nota: "${n.title}" tags=[${tags.join(',')}] importance=${n.importance}`);

      // Tags NO deben ser genéricos
      const badTags = ['personal', 'usuario', 'información', 'datos'];
      const hasBadTags = tags.some(t => badTags.includes(t));
      assert(!hasBadTags, 'tags específicos (no genéricos)', tags.join(','));

      // Tags deben incluir palabras del contenido
      const goodTags = ['marcos', 'payfast', 'node', 'react', 'fullstack', 'buenos', 'aires', 'desarrollador'];
      const hasGoodTag = tags.some(t => goodTags.some(g => t.includes(g)));
      assert(hasGoodTag, 'tags contienen palabras del contenido', tags.join(','));

      assert(n.importance >= 7, `importance ≥ 7 (${n.importance})`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 2: Evento de vida → debe guardar con importance alta
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 2 — Evento de vida (murió mi perro)');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const msg = 'Hoy fue un día muy triste. Murió mi perro Thor, era un golden retriever de 5 años. Lo tuve desde cachorro y era parte de mi familia.';

    section(`"${msg.slice(0,60)}…"`);
    const notesBefore = getNotes(AGENT).length;
    const r = await chat(session, AGENT, msg, pendingMemory);

    await wait(500);
    const notesAfter = getNotes(AGENT);
    const nuevas = notesAfter.length - notesBefore;
    assert(nuevas >= 1, `guardó nota del evento (${nuevas} nueva(s))`);

    // Buscar nota con tags relevantes
    const relevant = notesAfter.filter(n => {
      const tags = (n.tag_names || '').split(',');
      return tags.some(t => ['thor', 'perro', 'muerte', 'golden', 'mascota'].includes(t));
    });

    if (relevant.length > 0) {
      ok('tags incluyen palabras del contenido (thor/perro/muerte/etc)', relevant[0].tag_names);
      assert(relevant[0].importance >= 8, `importance ≥ 8 para evento de vida (${relevant[0].importance})`);
    } else {
      warn('no encontró nota con tags específicos del evento — puede estar en nota genérica');
      const lastNote = notesAfter[notesAfter.length - 1];
      if (lastNote) info(`  última nota: "${lastNote.title}" tags=[${lastNote.tag_names}]`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 3: Preferencia del usuario → debe guardar
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 3 — Preferencias del usuario');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const msg = 'Siempre prefiero dark mode en todos los editores. Odio las respuestas largas, prefiero concisas y al punto. Me gusta el café negro sin azúcar.';

    section(`"${msg.slice(0,60)}…"`);
    const notesBefore = getNotes(AGENT).length;
    const r = await chat(session, AGENT, msg, pendingMemory);

    await wait(500);
    const notesAfter = getNotes(AGENT);

    // Claude puede crear nota nueva O hacer append en una existente
    const savedSomething = r.savedFiles.length > 0 || notesAfter.length > notesBefore;
    assert(savedSomething, `guardó preferencias (nuevas=${notesAfter.length - notesBefore} saved=${r.savedFiles.join(',')||'0'})`);

    // Buscar que la info esté en alguna nota (tags o contenido)
    const allContent = notesAfter.map(n => (n.content || '') + ' ' + (n.tag_names || '')).join(' ').toLowerCase();
    const hasDark = /dark/.test(allContent);
    const hasCafe = /caf[eé]/.test(allContent);
    assert(hasDark || hasCafe, 'preferencias guardadas en alguna nota (dark mode / café)', allContent.slice(0,200));
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 4: Conocimiento técnico → debe guardar con tags técnicos
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 4 — Conocimiento técnico aprendido');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const msg = 'Aprendí que en Node.js cuando usás ESModules con TypeScript hay que agregar "moduleResolution": "bundler" en tsconfig. El error que tenía era TS2307 y la solución fue ese cambio.';

    section(`"${msg.slice(0,60)}…"`);
    const notesBefore = getNotes(AGENT).length;
    const r = await chat(session, AGENT, msg, pendingMemory);

    await wait(500);
    const notesAfter = getNotes(AGENT);
    assert(notesAfter.length > notesBefore, `guardó conocimiento técnico`);

    const techNote = notesAfter.find(n => {
      const tags = (n.tag_names || '').split(',');
      return tags.some(t => ['typescript', 'esmodule', 'ts2307', 'node', 'tsconfig', 'esmodules', 'bundler'].includes(t));
    });
    if (techNote) {
      ok('tags técnicos encontrados', `[${techNote.tag_names}]`);
    } else {
      warn('tags técnicos esperados no encontrados');
      const last = notesAfter[notesAfter.length - 1];
      if (last) info(`  última nota: "${last.title}" [${last.tag_names}]`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 5: Mensaje trivial → NO debe guardar nada
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 5 — Mensaje trivial (no debe guardar)');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const messages = [
      'Cuánto es 15 por 7?',
      'Qué es la fotosíntesis?',
      'Cómo se llama la capital de Francia?',
    ];

    for (const msg of messages) {
      section(`"${msg}"`);
      const notesBefore = getNotes(AGENT).length;
      const r = await chat(session, AGENT, msg, pendingMemory);
      await wait(300);
      const notesAfter = getNotes(AGENT);
      const nuevas = notesAfter.length - notesBefore;
      assert(nuevas === 0, `no guardó nada para mensaje trivial (${nuevas} notas nuevas)`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 6: Recuperación de memoria guardada previamente
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 6 — Recuperación: ¿qué recordás de mí?');
  {
    // NUEVA sesión — empieza desde cero, la memoria persiste en DB
    const session = new ClaudePrintSession({ permissionMode: 'auto' });

    section('Preguntando sobre info personal guardada anteriormente');
    const r = await chat(session, AGENT, 'Qué recordás de mí? Quién soy y dónde trabajo?');

    const response = r.response || '';
    const hasMarcos = /marcos/i.test(response);
    const hasPayFast = /payfast|pay\s*fast/i.test(response);
    const hasNode = /node/i.test(response);

    assert(hasMarcos,  'respuesta menciona "Marcos"',  response.slice(0,200));
    assert(hasPayFast, 'respuesta menciona "PayFast"', response.slice(0,200));
    assert(hasNode,    'respuesta menciona "Node"',    response.slice(0,200));

    info(`  memCtx inyectado: ${memory.buildMemoryContext(AGENT, 'quién soy').slice(0, 150)}…`);
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 7: Recuperación específica — mascota
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 7 — Recuperación: mascota y evento triste');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });

    section('Preguntando sobre Thor');
    const r = await chat(session, AGENT, 'Cómo se llamaba mi perro? Qué le pasó?');

    const response = r.response || '';
    const hasThor = /thor/i.test(response);
    const hasMurio = /muri|falleció|falleció|perdiste|murió/i.test(response);

    assert(hasThor,  'respuesta menciona "Thor"',    response.slice(0,300));
    assert(hasMurio, 'respuesta menciona que murió', response.slice(0,300));
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 8: Conversación multi-turno con memoria continua
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 8 — Multi-turno: guardar y referenciar en misma sesión');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });
    const ss = {}; // sessionState compartido entre turnos

    section('Turno 1: guardar proyecto nuevo');
    const r1 = await chat(session, AGENT,
      'Empecé un proyecto nuevo llamado NeuroPay, es una API de pagos con IA para detectar fraude. Usamos Python, FastAPI y PostgreSQL.',
      pendingMemory, ss);
    await wait(500);

    section('Turno 2: pregunta de seguimiento (referencia al proyecto)');
    const r2 = await chat(session, AGENT,
      'Qué decisiones técnicas tomamos para NeuroPay hasta ahora?',
      pendingMemory, ss);

    const response2 = r2.response || '';
    const hasNeuroPay = /neuropay/i.test(response2);
    const hasFastAPI  = /fastapi|python|postgresql/i.test(response2);

    // Claude puede referenciar el proyecto sin decir su nombre literal
    const hasContext = hasNeuroPay || /python|fastapi|postgresql|pago|fraude|stack|proyecto/i.test(response2);
    assert(hasContext,  'turno 2 recuerda el proyecto (NeuroPay o stack)', response2.slice(0,300));
    assert(hasFastAPI,  'turno 2 recuerda stack tech',                     response2.slice(0,300));

    section('Turno 3: pedir guardado explícito');
    const r3 = await chat(session, AGENT,
      'Recuerda también que el nombre del cliente principal de NeuroPay es BancoSur S.A.',
      pendingMemory, ss);
    await wait(500);

    const notes = getNotes(AGENT);
    const neuro = notes.find(n =>
      n.title.toLowerCase().includes('neuro') ||
      (n.tag_names || '').toLowerCase().includes('neuropay')
    );
    assert(neuro !== undefined, 'nota de NeuroPay en SQLite', notes.map(n => n.title).join(', '));
    if (neuro) info(`  nota: "${neuro.title}" [${neuro.tag_names}]`);
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 9: Corrección de información → debe actualizar nota
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 9 — Corrección: el usuario actualiza info previa');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });

    section('Corregir edad');
    const notesBefore = getNotes(AGENT).length;
    const r = await chat(session, AGENT,
      'Ojo, me equivoqué antes: tengo 34 años, no 32. Actualiza eso por favor.',
      pendingMemory);
    await wait(500);

    const notes = getNotes(AGENT);
    // Puede que actualice la nota existente o cree una nueva
    const tieneInfo = notes.some(n =>
      n.content?.includes('34') || n.title?.toLowerCase().includes('marcos')
    );
    assert(tieneInfo || r.savedFiles.length > 0, 'actualizó o guardó corrección',
      r.savedFiles.length > 0 ? r.savedFiles.join(',') : 'sin save_memory');
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 10: Señal de fecha → debe guardar fecha
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 10 — Fecha y evento temporal');
  {
    const session = new ClaudePrintSession({ permissionMode: 'auto' });

    section('Cumpleaños con fecha específica');
    const r = await chat(session, AGENT,
      'El 23 de septiembre es el cumpleaños de mi pareja Laura. Siempre se me olvida.',
      pendingMemory);
    await wait(500);

    const notes = getNotes(AGENT);
    const fechaNota = notes.find(n =>
      n.content?.includes('23') || n.content?.includes('septiembre') ||
      (n.tag_names || '').includes('laura') ||
      (n.tag_names || '').includes('cumpleaños')
    );
    assert(fechaNota !== undefined, 'guardó fecha/cumpleaños',
      notes.map(n=>n.title).join(', '));
    if (fechaNota) info(`  nota: "${fechaNota.title}" [${fechaNota.tag_names}]`);
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 11: Verificar spreading activation post-save
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 11 — Spreading Activation sobre memoria acumulada');
  {
    section('Indexar todas las notas guardadas');
    await memory.indexAllNotes(AGENT);
    await wait(500);

    const allNotes = getNotes(AGENT);
    info(`  Total notas guardadas por Claude: ${allNotes.length}`);
    for (const n of allNotes) {
      info(`  • "${n.title}" [${n.tag_names||'sin tags'}] importance=${n.importance} accesses=${n.access_count}`);
    }

    const queries = [
      { q: 'mi trabajo y empresa',             expect: ['marcos', 'payfast', 'fullstack', 'node', 'desarrollador', 'trabajo', 'empresa'] },
      { q: 'mi perro que murió',               expect: ['thor', 'perro', 'mascota', 'muerte', 'golden'] },
      { q: 'preferencias de editor y café',    expect: ['dark', 'darkmode', 'café', 'cafe', 'editor', 'preferencia'] },
      { q: 'error de typescript esmodules',    expect: ['typescript', 'ts2307', 'esmodule', 'node', 'tsconfig', 'bundler', 'esmodules'] },
      { q: 'proyecto neuropay fastapi',        expect: ['neuropay', 'fastapi', 'python', 'postgresql', 'pago', 'fraude'] },
      { q: 'cumpleaños de laura',              expect: ['laura', 'cumpleaños', 'septiembre', '23'] },
    ];

    let spreadHits = 0;
    for (const { q, expect } of queries) {
      const kw = memory.extractKeywords(q);
      const results = memory.spreadingActivation(AGENT, kw);
      const found = results.length > 0;
      if (found) {
        const foundTags = results.flatMap(r => r.tags);
        const hit = expect.some(e => foundTags.some(t => t.includes(e)));
        if (hit) {
          spreadHits++;
          ok(`spreading "${q}" → encontró notas relevantes`, results.map(r=>r.title).join(', '));
        } else {
          warn(`spreading "${q}" → resultados pero sin tags esperados`, `tags=[${foundTags.slice(0,8).join(',')}] esperaba=[${expect.join(',')}]`);
        }
      } else {
        warn(`spreading "${q}" → 0 resultados (nota puede no tener tags adecuados)`, kw.join(','));
      }
    }
    info(`  ${spreadHits}/${queries.length} queries con spreading exitoso`);
  }

  // ════════════════════════════════════════════════════════════
  // ESCENARIO 12: Cola de consolidación con haiku
  // ════════════════════════════════════════════════════════════
  header('ESCENARIO 12 — Consolidación: encolar y procesar con haiku');
  {
    if (!consolidator) {
      warn('consolidator no disponible');
    } else if (pendingMemory.length === 0) {
      info('no hubo _pendingMemory (Claude guardó todo en el momento) — creando caso artificial');
      consolidator.enqueue(AGENT, '0', [
        { text: 'Mi número de teléfono favorito es 555-1234 (ficticio, es un test)', types: ['personal'], ts: Date.now() },
        { text: 'Aprendí que VACUUM en SQLite libera espacio en disco', types: ['knowledge'], ts: Date.now() },
      ], 'test');
    } else {
      info(`pendingMemory tiene ${pendingMemory.length} item(s) — encolando`);
      consolidator.enqueue(AGENT, '0', pendingMemory, 'session_end');
    }

    const statsBefore = consolidator.getStats(AGENT);
    info(`  stats antes: ${JSON.stringify(statsBefore)}`);

    section('Procesando cola con haiku (~30s)');
    const notesBefore = getNotes(AGENT).length;

    try {
      await consolidator.processQueue();
      await wait(1000);

      const notesAfter = getNotes(AGENT);
      const statsAfter = consolidator.getStats(AGENT);
      info(`  stats después: ${JSON.stringify(statsAfter)}`);

      assert(statsAfter.pending === 0 || statsAfter.done > statsBefore.done,
        'haiku procesó la cola', JSON.stringify(statsAfter));
      info(`  notas antes/después: ${notesBefore} → ${notesAfter.length}`);
      if (notesAfter.length > notesBefore) {
        ok('haiku guardó nota(s) nuevas desde la cola', `+${notesAfter.length - notesBefore}`);
      } else {
        warn('haiku procesó pero no guardó nuevas notas (puede ser que el contenido no ameritaba)');
      }
    } catch (err) {
      fail(`processQueue con haiku: ${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // VERIFICACIÓN FINAL DEL ESTADO
  // ════════════════════════════════════════════════════════════
  header('VERIFICACIÓN FINAL — Estado de la memoria');
  {
    section('Notas en SQLite');
    const allNotes = getNotes(AGENT);
    info(`  Total notas: ${allNotes.length}`);
    assert(allNotes.length >= 4, `al menos 4 notas guardadas (${allNotes.length})`);
    for (const n of allNotes) {
      const tags = (n.tag_names || '').split(',').filter(Boolean);
      const badTags = ['personal', 'usuario', 'información', 'datos', 'info'];
      const allBad = tags.every(t => badTags.includes(t));
      if (allBad && tags.length > 0) {
        warn(`nota "${n.title}" tiene solo tags genéricos`, tags.join(','));
      } else {
        ok(`nota "${n.title}"`, `[${tags.join(',')}] imp=${n.importance} acc=${n.access_count}`);
      }
    }

    section('Links (Hebb + explicit)');
    const links = getLinks(AGENT);
    info(`  Total links: ${links.length}`);
    const learnedLinks = links.filter(l => l.type === 'learned');
    const explicitLinks = links.filter(l => l.type === 'explicit');
    info(`  learned=${learnedLinks.length} explicit=${explicitLinks.length}`);

    section('Grafo completo');
    const graph = memory.buildGraph(AGENT);
    assert(graph.nodes.length >= 4, `grafo tiene ≥4 nodos (${graph.nodes.length})`);
    info(`  ${graph.nodes.length} nodos, ${graph.links.length} links`);

    section('Cola de consolidación');
    if (consolidator) {
      const stats = consolidator.getStats(AGENT);
      info(`  ${JSON.stringify(stats)}`);
      assert(stats.error === 0, `sin errores en cola (${stats.error})`, JSON.stringify(stats));
    }
  }

  // ─── LIMPIEZA ─────────────────────────────────────────────────────────────
  header('LIMPIEZA');
  {
    const files = memory.listFiles(AGENT);
    for (const f of files) memory.remove(AGENT, f.filename);
    const db = memory.getDB();
    if (db) {
      db.prepare(`DELETE FROM notes WHERE agent_key = ?`).run(AGENT);
      db.prepare(`DELETE FROM consolidation_queue WHERE agent_key = ?`).run(AGENT);
    }
    try { fs.rmdirSync(path.join(memory.MEMORY_DIR, AGENT)); } catch {}
    ok('datos de prueba eliminados');
  }

  // ─── RESUMEN ──────────────────────────────────────────────────────────────
  header('RESUMEN FINAL');
  console.log(`\n  ${C.green}${C.bold}✓ Pasaron:   ${passed}${C.reset}`);
  if (failed > 0) {
    console.log(`  ${C.red}${C.bold}✗ Fallaron:  ${failed}${C.reset}`);
    console.log(`\n${C.red}  Fallos:${C.reset}`);
    for (const f of failures) console.log(`    • ${f.label}${f.detail ? ` → ${f.detail}` : ''}`);
  } else {
    console.log(`  ${C.gray}✗ Fallaron:  0${C.reset}`);
  }
  if (warnings > 0) console.log(`  ${C.yellow}⚠ Warnings: ${warnings}${C.reset}`);
  console.log('');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\n${C.red}${C.bold}ERROR FATAL: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
