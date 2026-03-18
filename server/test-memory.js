'use strict';

/**
 * test-memory.js — Prueba integral del sistema de memoria sin Telegram.
 * Simula: indexado, spreading activation, señales, nudge, consolidación, preferencias, Hebb, ACT-R.
 *
 * Uso: node test-memory.js [--consolidar]
 *   --consolidar  también lanza haiku real (tarda ~30s por ítem)
 */

process.env.DEBUG_MEMORY = '1';

const fs   = require('fs');
const path = require('path');

// ─── Colores ──────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
  magenta: '\x1b[35m',
};

let passed = 0, failed = 0, skipped = 0;

function header(title) {
  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(60)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'═'.repeat(60)}${C.reset}`);
}

function section(title) {
  console.log(`\n${C.bold}${C.blue}── ${title}${C.reset}`);
}

function ok(label, detail = '') {
  passed++;
  console.log(`  ${C.green}✓${C.reset} ${label}${detail ? ` ${C.gray}(${detail})${C.reset}` : ''}`);
}

function fail(label, detail = '') {
  failed++;
  console.log(`  ${C.red}✗${C.reset} ${C.red}${label}${C.reset}${detail ? ` ${C.gray}(${detail})${C.reset}` : ''}`);
}

function skip(label) {
  skipped++;
  console.log(`  ${C.yellow}⊘${C.reset} ${C.yellow}${label}${C.reset}`);
}

function info(label) {
  console.log(`  ${C.gray}→ ${label}${C.reset}`);
}

function assert(cond, label, detail = '') {
  cond ? ok(label, detail) : fail(label, detail);
  return cond;
}

// ─── Setup: directorio de prueba temporal ────────────────────────────────────

const ORIG_MEMORY_DIR = path.join(__dirname, 'memory');
const TEST_MEMORY_DIR = path.join(__dirname, 'memory-test-' + Date.now());

// Parchear MEMORY_DIR antes de cargar el módulo
// Usamos un override temporal vía variable de entorno no disponible → hacemos mock del path
// En lugar de eso cargamos el módulo y modificamos internals con monkey-patch temporal.

header('SETUP — Entorno de prueba');
info(`Directorio temporal: ${TEST_MEMORY_DIR}`);
fs.mkdirSync(TEST_MEMORY_DIR, { recursive: true });

// Cargamos el módulo. Usa server/memory como MEMORY_DIR real.
// Para aislar, escribimos en un sub-agente de prueba que limpiaremos después.
const memory = require('./memory');
const TEST_AGENT = 'test_agent_' + Date.now().toString(36);
const TEST_AGENT2 = 'test_agent2_' + Date.now().toString(36);

info(`Agente de prueba: ${TEST_AGENT}`);
ok('módulo memory cargado');

const consolidator = (() => {
  try {
    const m = require('./memory-consolidator');
    m.init(memory.getDB());
    ok('módulo memory-consolidator cargado');
    return m;
  } catch (e) {
    fail('memory-consolidator: ' + e.message);
    return null;
  }
})();

// ─── SUITE 1: parseFrontmatter ────────────────────────────────────────────────

header('SUITE 1 — parseFrontmatter');

section('Nota con frontmatter completo');
{
  const content = `---
title: Error de JWT en producción
tags: [jwt, auth, node, error]
links: [nodejs-tips.md]
importance: 8
---

El error "invalid signature" ocurría cuando el token se generaba con una clave diferente.
La solución fue unificar la variable JWT_SECRET en todas las instancias del servicio.`;

  const r = memory.parseFrontmatter(content, 'jwt-error.md');
  assert(r.title === 'Error de JWT en producción', 'title', r.title);
  assert(r.tags.length === 4, 'tags (4)', r.tags.join(', '));
  assert(r.tags.includes('jwt'), 'tag jwt incluido');
  assert(r.importance === 8, 'importance=8', String(r.importance));
  assert(r.links.includes('nodejs-tips.md'), 'link incluido');
  assert(r.body.includes('invalid signature'), 'body sin frontmatter');
}

section('Nota sin frontmatter');
{
  const r = memory.parseFrontmatter('Solo texto plano', 'plain.md');
  assert(r.title === 'plain', 'title fallback = filename sin ext', r.title);
  assert(r.tags.length === 0, 'tags vacíos');
  assert(r.importance === 5, 'importance default=5');
  assert(r.body === 'Solo texto plano', 'body completo');
}

section('Tags multiline');
{
  const content = `---
title: Mi nota
tags:
  - programación
  - python
  - django
importance: 7
---

Cuerpo de nota.`;
  const r = memory.parseFrontmatter(content, 'multi.md');
  assert(r.tags.length === 3, 'tags multiline (3)', r.tags.join(', '));
  assert(r.tags.includes('django'), 'tag django incluido');
}

section('Importance fuera de rango');
{
  const high = memory.parseFrontmatter(`---\ntitle: t\nimportance: 99\n---\nx`, 'x.md');
  const low  = memory.parseFrontmatter(`---\ntitle: t\nimportance: -5\n---\nx`, 'x.md');
  assert(high.importance === 10, 'importance clamp max=10', String(high.importance));
  assert(low.importance === 1,   'importance clamp min=1',  String(low.importance));
}

// ─── SUITE 2: CRUD + indexado ──────────────────────────────────────────────────

header('SUITE 2 — CRUD + indexado SQLite');

const NOTAS = [
  {
    file: 'mascotas.md',
    content: `---
title: Mascotas del usuario
tags: [perro, gato, mascota, animal]
importance: 8
---

El usuario tiene un perro llamado Thor y un gato llamado Luna.
Thor es un golden retriever de 3 años. Luna tiene 2 años.`,
  },
  {
    file: 'trabajo.md',
    content: `---
title: Lugar de trabajo del usuario
tags: [trabajo, empresa, fullstack, javascript]
importance: 7
---

Trabaja como desarrollador fullstack en una startup de fintech llamada PayFast.
Usa Node.js y React. El equipo tiene 8 personas.`,
  },
  {
    file: 'proyecto.md',
    content: `---
title: Proyecto principal - Clawmint
tags: [proyecto, clawmint, nodejs, terminal, websocket]
importance: 9
---

Proyecto personal: Clawmint — terminal en tiempo real con WebSocket, node-pty y bot de Telegram.
Stack: Node.js 22, Express, React 18, xterm.js, Anthropic SDK.`,
  },
  {
    file: 'preferencias.md',
    content: `---
title: Preferencias del usuario
tags: [preferencia, café, música, rock, idioma]
importance: 7
---

Prefiere el café negro sin azúcar. Le gusta el rock clásico.
Habla español e inglés. Prefiere respuestas concisas.`,
  },
  {
    file: 'errores-comunes.md',
    content: `---
title: Errores frecuentes en Node.js
tags: [node, error, bug, stacktrace, commonjs]
importance: 8
---

El error "Cannot use import statement" ocurre al mezclar ESM y CJS.
Solución: usar require() o configurar "type": "module" en package.json.
Stack overflow con --stack-size=65536 en WSL2 con node-pty.`,
  },
  {
    file: 'salud.md',
    content: `---
title: Información de salud del usuario
tags: [salud, alergia, dieta, médico]
importance: 9
---

Alérgico a la penicilina. Sigue dieta sin gluten desde 2024.
Cumpleaños el 15 de agosto. Tiene visita médica anual en enero.`,
  },
  {
    file: 'aprendizaje.md',
    content: `---
title: Cosas aprendidas recientemente
tags: [aprendizaje, sqlite, spreading-activation, memoria]
importance: 8
links: [proyecto.md]
---

Aprendió que SQLite con WAL mode es muy eficiente para lecturas concurrentes.
Spreading activation con decay D=0.7 y 2 saltos es suficiente para recuperación semántica.`,
  },
];

section(`Escribiendo ${NOTAS.length} notas de prueba`);
for (const nota of NOTAS) {
  memory.write(TEST_AGENT, nota.file, nota.content);
  ok(`write → ${nota.file}`);
}

section('Indexar todas las notas');
let indexOk = false;
(async () => {
  await memory.indexAllNotes(TEST_AGENT);
  indexOk = true;
})();

// Esperar indexado (sincronizamos con una pequeña pausa)
const waitFor = (ms) => new Promise(r => setTimeout(r, ms));

// ─── SUITE 3: Spreading Activation ────────────────────────────────────────────

async function runTests() {
  await waitFor(500); // Dar tiempo al indexado async

  header('SUITE 3 — Spreading Activation + ACT-R');

  section('Query: "perro gato"');
  {
    const keywords = memory.extractKeywords('tengo un perro y un gato en casa');
    info(`keywords extraídas: [${keywords.join(', ')}]`);
    assert(keywords.includes('perro'), 'keyword perro');
    assert(keywords.includes('gato'), 'keyword gato');
    assert(!keywords.includes('en'), 'stopword "en" filtrada');

    const results = memory.spreadingActivation(TEST_AGENT, keywords);
    assert(results.length > 0, `resultados (${results.length})`, results.map(r => r.title).join(', '));
    if (results.length > 0) {
      assert(results[0].title === 'Mascotas del usuario', 'nota de mascotas primero', results[0].title);
      assert(typeof results[0].score === 'number' && results[0].score > 0, 'score > 0', results[0].score.toFixed(4));
      for (const r of results) {
        info(`  score=${r.score.toFixed(4)} "${r.title}" tags=[${r.tags.join(',')}]`);
      }
    }
  }

  section('Query: "node error"');
  {
    const kw = memory.extractKeywords('tengo un error en node que no entiendo');
    const results = memory.spreadingActivation(TEST_AGENT, kw);
    assert(results.length > 0, `resultados (${results.length})`);
    const tieneError = results.some(r => r.filename === 'errores-comunes.md');
    assert(tieneError, 'errores-comunes.md en resultados');
    for (const r of results) info(`  score=${r.score.toFixed(4)} "${r.title}"`);
  }

  section('Query: "sqlite aprendizaje"');
  {
    const kw = memory.extractKeywords('aprendí algo sobre sqlite hoy');
    const results = memory.spreadingActivation(TEST_AGENT, kw);
    const tieneAprendizaje = results.some(r => r.filename === 'aprendizaje.md');
    assert(tieneAprendizaje, 'aprendizaje.md recuperado');
    // Por el link a proyecto.md, debería propagarse
    const tieneProyecto = results.some(r => r.filename === 'proyecto.md');
    info(`spreading a proyecto.md (via link): ${tieneProyecto ? '✓ propagó' : '— no propagó aún (co_access=0)'}`);
  }

  section('Token budget: query amplia');
  {
    const kw = ['node', 'proyecto', 'trabajo', 'mascota', 'error', 'aprendizaje'];
    const results = memory.spreadingActivation(TEST_AGENT, kw);
    const totalTokens = results.reduce((n, r) => n + Math.ceil(r.content.length / 4), 0);
    assert(totalTokens <= 800, `budget ≤ 800 tokens (${totalTokens})`, `${totalTokens} tokens`);
    assert(results.length >= 1, `al menos 1 resultado (${results.length})`);
    info(`  seleccionadas ${results.length} notas, ~${totalTokens} tokens`);
  }

  section('Fallback cuando keywords no matchean nada');
  {
    const ctx = memory.buildMemoryContext(TEST_AGENT, 'hola como estas');
    assert(ctx.length > 0, 'fallback devuelve algo (top-3 recientes)');
    info(`fallback: ${ctx.slice(0, 100)}…`);
  }

  // ─── SUITE 4: ACT-R + Hebb ────────────────────────────────────────────────

  header('SUITE 4 — ACT-R (trackAccess) + Hebb (reinforceConnections)');

  section('trackAccess: incrementar contadores');
  {
    const db = memory.getDB();
    if (!db) { skip('SQLite no disponible'); }
    else {
      const kw = memory.extractKeywords('mi perro y mi gato');
      const before = memory.spreadingActivation(TEST_AGENT, kw);
      const ids = before.map(r => r.id);

      if (ids.length > 0) {
        const countBefore = db.prepare(
          `SELECT access_count FROM notes WHERE id = ?`
        ).get(ids[0])?.access_count || 0;

        memory.trackAccess(ids);
        memory.trackAccess(ids); // dos veces

        const countAfter = db.prepare(
          `SELECT access_count FROM notes WHERE id = ?`
        ).get(ids[0])?.access_count || 0;

        assert(countAfter >= countBefore + 2, `access_count aumentó (${countBefore} → ${countAfter})`, `id=${ids[0]}`);
      } else {
        skip('sin resultados para trackAccess');
      }
    }
  }

  section('reinforceConnections: aprendizaje Hebbiano');
  {
    const db = memory.getDB();
    if (!db) { skip('SQLite no disponible'); }
    else {
      const kw1 = memory.extractKeywords('perro mascota animal');
      const kw2 = memory.extractKeywords('trabajo empresa desarrollador');

      const r1 = memory.spreadingActivation(TEST_AGENT, kw1);
      const r2 = memory.spreadingActivation(TEST_AGENT, kw2);

      const allIds = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];

      if (allIds.length >= 2) {
        // Simular co-recuperación 3 veces
        memory.reinforceConnections(allIds);
        memory.reinforceConnections(allIds);
        memory.reinforceConnections(allIds);

        const links = db.prepare(`
          SELECT co_access_count FROM note_links
          WHERE from_id = ? AND to_id = ?
        `).get(allIds[0], allIds[1]);

        assert(links && links.co_access_count >= 3, `co_access_count ≥ 3 (${links?.co_access_count})`, `ids ${allIds[0]}↔${allIds[1]}`);

        // El peso Hebbiano = min(1, co_access / 10)
        const W = Math.min(1, (links?.co_access_count || 0) / 10);
        info(`  W=${W.toFixed(2)} (co_access=${links?.co_access_count})`);
      } else {
        skip('menos de 2 nodos para Hebb');
      }
    }
  }

  section('Spreading se fortalece después de Hebb');
  {
    // Simular co-recuperación masiva entre mascotas y trabajo
    const db = memory.getDB();
    if (db) {
      const row1 = db.prepare(`SELECT id FROM notes WHERE agent_key=? AND filename=?`).get(TEST_AGENT, 'mascotas.md');
      const row2 = db.prepare(`SELECT id FROM notes WHERE agent_key=? AND filename=?`).get(TEST_AGENT, 'trabajo.md');

      if (row1 && row2) {
        // Co-recuperar 10 veces para llegar a W=1.0
        for (let i = 0; i < 10; i++) {
          memory.reinforceConnections([row1.id, row2.id]);
        }
        const link = db.prepare(`SELECT co_access_count FROM note_links WHERE from_id=? AND to_id=?`).get(row1.id, row2.id)
                  || db.prepare(`SELECT co_access_count FROM note_links WHERE from_id=? AND to_id=?`).get(row2.id, row1.id);
        const W = Math.min(1, (link?.co_access_count || 0) / 10);
        assert(W >= 0.9, `W saturado ≥ 0.9 (${W.toFixed(2)})`, `co_access=${link?.co_access_count}`);
        info(`  Consultar "perro" ahora debería recuperar también "trabajo" vía Hebb`);

        // Verificar
        const kw = memory.extractKeywords('mi perro thor');
        const results = memory.spreadingActivation(TEST_AGENT, kw);
        const incluyeTrabajo = results.some(r => r.filename === 'trabajo.md');
        info(`  "perro" → trabajo.md incluido vía spreading: ${incluyeTrabajo ? '✓' : '— (co_access bajo o sin saltos suficientes)'}`);
      }
    }
  }

  // ─── SUITE 5: buildMemoryContext ──────────────────────────────────────────

  header('SUITE 5 — buildMemoryContext (inyección de contexto)');

  const mensajes = [
    { texto: 'mi perro thor estuvo enfermo', espera: 'mascotas' },
    { texto: 'hay un error en node con el import', espera: 'errores' },
    { texto: 'cómo va el proyecto clawmint', espera: 'proyecto' },
    { texto: 'qué aprendí sobre sqlite', espera: 'aprendizaje' },
    { texto: 'tengo alergia y tengo turno médico', espera: 'salud' },
    { texto: 'hola qué onda', espera: 'fallback (top-3)' },
  ];

  for (const m of mensajes) {
    const ctx = memory.buildMemoryContext(TEST_AGENT, m.texto);
    const hasCtx = ctx.length > 0;
    assert(hasCtx, `"${m.texto.slice(0, 35)}…" → ${m.espera}`, `${ctx.length} chars`);
    if (hasCtx) info(`  ${ctx.split('\n').find(l => l.startsWith('###')) || ctx.slice(0, 80)}`);
  }

  section('Retrocompatibilidad (array de filenames)');
  {
    const ctx = memory.buildMemoryContext(TEST_AGENT, ['mascotas.md', 'trabajo.md']);
    assert(ctx.includes('Thor'), 'carga mascotas.md por filename');
    assert(ctx.includes('PayFast'), 'carga trabajo.md por filename');
  }

  // ─── SUITE 6: Detección de señales + nudge ────────────────────────────────

  header('SUITE 6 — Detección de señales y nudge');

  const casosSeñales = [
    { texto: 'recuerda que prefiero el café negro',           esperaTipo: 'explicit',   minWeight: 8 },
    { texto: 'me llamo Marcos y trabajo en PayFast',          esperaTipo: 'personal',   minWeight: 8 },
    { texto: 'murió mi abuela el viernes',                    esperaTipo: 'life_event', minWeight: 8 },
    { texto: 'siempre prefiero dark mode en los editores',    esperaTipo: 'preference', minWeight: 7 },
    { texto: 'el error era que faltaba el await en el fetch', esperaTipo: 'knowledge',  minWeight: 6 },
    { texto: 'el 15 de agosto es mi cumpleaños',              esperaTipo: 'date_event', minWeight: 5 },
    { texto: 'cómo está el clima hoy',                        esperaTipo: null,         minWeight: 0 },
  ];

  for (const c of casosSeñales) {
    const { maxWeight, signals, shouldNudge } = memory.detectSignals(TEST_AGENT, c.texto);
    if (c.esperaTipo === null) {
      assert(!shouldNudge, `"${c.texto.slice(0, 40)}" → sin señal`, `maxWeight=${maxWeight}`);
    } else {
      const tieneEsperado = signals.some(s => s.type === c.esperaTipo);
      assert(tieneEsperado, `detecta ${c.esperaTipo}`, `tipos=[${signals.map(s=>s.type).join(',')}] peso=${maxWeight}`);
      assert(maxWeight >= c.minWeight, `peso ≥ ${c.minWeight}`, `maxWeight=${maxWeight}`);
    }
  }

  section('buildNudge genera texto correcto');
  {
    const { signals } = memory.detectSignals(TEST_AGENT, 'recuerda que me llamo Marcos');
    if (signals.length > 0) {
      const nudge = memory.buildNudge(signals);
      assert(nudge.includes('[SISTEMA'), 'contiene [SISTEMA');
      assert(nudge.includes('save_memory'), 'menciona save_memory');
      assert(nudge.includes('tags específicos'), 'menciona tags específicos');
      info(`  nudge: ${nudge.slice(0, 120)}…`);
    } else {
      skip('sin señales para testear nudge');
    }
  }

  // ─── SUITE 7: extractMemoryOps + applyOps ─────────────────────────────────

  header('SUITE 7 — extractMemoryOps + applyOps');

  section('Extracción básica');
  {
    const llmResponse = `Voy a guardar eso en mi memoria.

<save_memory file="viaje.md">
---
title: Viaje a España
tags: [viaje, españa, madrid, vacaciones]
importance: 8
---

El usuario viajó a Madrid en marzo 2025. Visitó el Prado y el Retiro.
</save_memory>

¡Guardado! También voy a agregar una nota técnica.

<append_memory file="proyecto.md">
- Versión 2.0 planificada para Q2 2026
</append_memory>`;

    const { clean, ops } = memory.extractMemoryOps(llmResponse);
    assert(ops.length === 2, `extrajo 2 ops (${ops.length})`);
    assert(ops[0].mode === 'write', 'primera op: write', ops[0].mode);
    assert(ops[0].file === 'viaje.md', 'archivo viaje.md', ops[0].file);
    assert(ops[1].mode === 'append', 'segunda op: append', ops[1].mode);
    assert(!clean.includes('<save_memory'), 'etiquetas removidas del texto limpio');
    assert(clean.includes('¡Guardado!'), 'texto normal preservado');
    info(`  clean: "${clean.slice(0, 80).replace(/\n/g, '↵')}"`);
  }

  section('applyOps: escribir y leer de vuelta');
  {
    const ops = [{
      mode: 'write',
      file: 'test-nota.md',
      content: `---
title: Nota de prueba
tags: [prueba, test, automatizado]
importance: 6
---

Esta nota fue creada por el test automatizado.`,
    }];
    const saved = memory.applyOps(TEST_AGENT, ops);
    assert(saved.includes('test-nota.md'), 'archivo guardado', saved.join(', '));
    const content = memory.read(TEST_AGENT, 'test-nota.md');
    assert(content && content.includes('automatizado'), 'contenido verificado');
  }

  // ─── SUITE 8: Cola de consolidación ─────────────────────────────────────────

  header('SUITE 8 — Cola de consolidación (sin haiku real)');

  if (!consolidator) {
    skip('consolidator no disponible');
  } else {
    section('enqueue: agregar items a la cola');
    {
      const db = memory.getDB();
      if (!db) { skip('SQLite no disponible'); }
      else {
        const countBefore = db.prepare(
          `SELECT COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ?`
        ).get(TEST_AGENT)?.cnt || 0;

        consolidator.enqueue(TEST_AGENT, '12345', [
          { text: 'murió mi perro Thor ayer', types: ['life_event'], ts: Date.now() },
          { text: 'me llamo Marcos y tengo 30 años', types: ['personal'], ts: Date.now() },
        ], 'signal');

        consolidator.enqueue(TEST_AGENT, '12345', [
          { text: 'aprendí que SQLite WAL es más rápido', types: ['knowledge'], ts: Date.now() },
        ], 'session_end');

        consolidator.enqueue(TEST_AGENT, '12345', [
          { text: 'recuerda que prefiero dark mode', types: ['explicit', 'preference'], ts: Date.now() },
        ], 'manual');

        const countAfter = db.prepare(
          `SELECT COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ?`
        ).get(TEST_AGENT)?.cnt || 0;

        assert(countAfter === countBefore + 3, `3 items encolados (${countBefore} → ${countAfter})`);

        const stats = consolidator.getStats(TEST_AGENT);
        assert(stats.pending >= 3, `pending ≥ 3 (${stats.pending})`);
        info(`  stats: ${JSON.stringify(stats)}`);
      }
    }

    section('consolidationEnabled=false: no encola');
    {
      const db = memory.getDB();
      if (db) {
        const countBefore = db.prepare(
          `SELECT COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ?`
        ).get(TEST_AGENT2)?.cnt || 0;

        // Crear prefs que desactivan consolidación
        memory.write(TEST_AGENT2, 'preferences.json', JSON.stringify({
          settings: { consolidationEnabled: false }
        }));

        consolidator.enqueue(TEST_AGENT2, '99999', [
          { text: 'murió mi gato', types: ['life_event'], ts: Date.now() }
        ], 'signal');

        const countAfter = db.prepare(
          `SELECT COUNT(*) as cnt FROM consolidation_queue WHERE agent_key = ?`
        ).get(TEST_AGENT2)?.cnt || 0;

        assert(countAfter === countBefore, 'consolidación deshabilitada → no encoló');
      }
    }

    section('processQueue sin haiku (testear extracción de output)');
    {
      // Simular directamente el parseo de output de haiku
      const fakeHaikuOutput = `
<save_memory file="thor-fallecimiento.md">
---
title: Fallecimiento de Thor
tags: [thor, perro, muerte, mascota, duelo]
importance: 9
---

El perro Thor del usuario falleció. Era un golden retriever de 3 años.
El usuario lo mencionó con tristeza el 17 de marzo de 2026.
</save_memory>

<new_topic>mascotas</new_topic>
<new_topic>eventos_familiares</new_topic>
`;
      const { ops } = memory.extractMemoryOps(fakeHaikuOutput);
      assert(ops.length === 1, `1 op extraída del output fake (${ops.length})`);
      assert(ops[0].file === 'thor-fallecimiento.md', 'archivo correcto', ops[0].file);

      // Verificar parseo de frontmatter del contenido
      const parsed = memory.parseFrontmatter(ops[0].content, ops[0].file);
      assert(parsed.tags.includes('thor'), 'tag thor en nota');
      assert(parsed.importance === 9, 'importance=9');

      // Test _extractNewTopics (llamar directamente via output parseado)
      const topicRegex = /<new_topic>([^<]+)<\/new_topic>/gi;
      const topics = [];
      let m;
      while ((m = topicRegex.exec(fakeHaikuOutput)) !== null) {
        topics.push(m[1].trim());
      }
      assert(topics.length === 2, `2 new_topic extraídos (${topics.join(', ')})`);
    }

    if (process.argv.includes('--consolidar')) {
      section('processQueue CON haiku real (puede tardar ~30s)');
      info('Lanzando haiku para el primer item de la cola…');
      try {
        await consolidator.processQueue();
        const stats = consolidator.getStats(TEST_AGENT);
        info(`  stats post-process: ${JSON.stringify(stats)}`);
        const notesDone = memory.listFiles(TEST_AGENT).filter(f => f.filename.endsWith('.md'));
        ok(`processQueue completó — ${notesDone.length} archivos en memoria`);
        for (const n of notesDone) info(`  → ${n.filename}`);
      } catch (err) {
        fail(`processQueue con haiku: ${err.message}`);
      }
    } else {
      skip('processQueue con haiku real (usar --consolidar para activar)');
    }
  }

  // ─── SUITE 9: Preferencias + tópicos ─────────────────────────────────────

  header('SUITE 9 — Preferencias y tópicos');

  section('getPreferences: merge chain');
  {
    // defaults.json ya fue creado por initDB
    const prefs = memory.getPreferences(TEST_AGENT);
    assert(Array.isArray(prefs.signals), 'signals es array');
    assert(prefs.signals.length >= 6, `≥ 6 señales (${prefs.signals.length})`);
    assert(typeof prefs.settings.nudgeEnabled === 'boolean', 'nudgeEnabled es boolean');
    assert(typeof prefs.settings.consolidationEnabled === 'boolean', 'consolidationEnabled es boolean');
    assert('debug' in prefs.settings, 'settings.debug existe');
    info(`  señales: ${prefs.signals.map(s => s.type).join(', ')}`);
    info(`  settings: ${JSON.stringify(prefs.settings)}`);
  }

  section('addTopic: agregar tópico a preferencias');
  {
    if (consolidator) {
      const r1 = consolidator.addTopic(TEST_AGENT, 'programacion', 'código y desarrollo');
      const r2 = consolidator.addTopic(TEST_AGENT, 'programacion'); // duplicado
      const r3 = consolidator.addTopic(TEST_AGENT, 'mascotas_y_animales');

      assert(r1 === true,  'primer addTopic → true (nuevo)');
      assert(r2 === false, 'segundo addTopic duplicado → false');
      assert(r3 === true,  'tercer addTopic → true (nuevo)');

      const prefs = memory.getPreferences(TEST_AGENT);
      const topics = prefs.topics || [];
      assert(topics.some(t => t.name === 'programacion'), 'tópico programacion en prefs');
      assert(topics.some(t => t.name === 'mascotas_y_animales'), 'tópico mascotas_y_animales en prefs');
      info(`  tópicos activos: [${topics.map(t => t.name).join(', ')}]`);
    } else {
      skip('consolidator no disponible');
    }
  }

  section('resetPreferences: eliminar preferences.json');
  {
    const ok1 = memory.resetPreferences(TEST_AGENT);
    assert(ok1 === true, 'resetPreferences devolvió true');
    const ok2 = memory.resetPreferences(TEST_AGENT);
    assert(ok2 === false, 'segundo reset devolvió false (ya no existe)');
  }

  // ─── SUITE 10: buildGraph ─────────────────────────────────────────────────

  header('SUITE 10 — buildGraph');

  section('grafo con nodos y links');
  {
    const graph = memory.buildGraph(TEST_AGENT);
    assert(graph.nodes.length >= NOTAS.length, `≥ ${NOTAS.length} nodos (${graph.nodes.length})`);
    assert(Array.isArray(graph.links), 'links es array');

    // Debe tener links Hebbianos creados en SUITE 4
    if (graph.links.length > 0) {
      const link = graph.links[0];
      assert(typeof link.source === 'number', 'link.source es número');
      assert(typeof link.weight === 'number' && link.weight >= 0, 'link.weight ≥ 0', String(link.weight));
      assert(['explicit', 'learned'].includes(link.type), 'link.type válido', link.type);
      info(`  ${graph.links.length} links — ejemplo: id${link.source}→id${link.target} W=${link.weight.toFixed(2)} (${link.type})`);
    }

    for (const node of graph.nodes.slice(0, 3)) {
      info(`  nodo "${node.title}" tags=[${node.tags.join(',')}] importance=${node.importance} accesses=${node.accessCount}`);
    }
  }

  // ─── SUITE 11: Debug condicional por JSON ─────────────────────────────────

  header('SUITE 11 — Debug condicional por JSON');

  section('debug: true en defaults.json → activa logs');
  {
    const defaultsPath = path.join(__dirname, 'memory', 'defaults.json');
    let original = null;
    if (fs.existsSync(defaultsPath)) {
      original = fs.readFileSync(defaultsPath, 'utf8');
    }

    // Escribir con debug: true
    const testDefaults = { settings: { debug: true } };
    fs.writeFileSync(defaultsPath, JSON.stringify(testDefaults, null, 2));
    memory.invalidatePrefsCache('_global');

    const prefs = memory.getPreferences('_global');
    assert(prefs.settings.debug === true, 'debug=true leído desde defaults.json');

    // Restaurar
    if (original) {
      fs.writeFileSync(defaultsPath, original);
    } else {
      fs.unlinkSync(defaultsPath);
    }
    memory.invalidatePrefsCache('_global');
    ok('defaults.json restaurado');
  }

  section('debug: false → sin DEBUG_MEMORY, logs silenciosos');
  {
    const saved = process.env.DEBUG_MEMORY;
    delete process.env.DEBUG_MEMORY;
    memory.invalidatePrefsCache('_global');

    // Si debug=false en prefs y sin env var, dbg() no debería imprimir
    // Lo verificamos indirectamente: que getPreferences retorne false
    const prefs = memory.getPreferences('_global');
    const debugActive = prefs.settings.debug === true;
    assert(!debugActive, 'debug=false en prefs por defecto');

    process.env.DEBUG_MEMORY = saved || '1';
  }

  // ─── SUITE 12: Múltiples agentes ─────────────────────────────────────────

  header('SUITE 12 — Aislamiento entre agentes');

  section('Dos agentes con mismos archivos no se interfieren');
  {
    const AGENTE_B = 'agente_b_' + Date.now().toString(36);
    memory.write(AGENTE_B, 'info.md', `---
title: Info agente B
tags: [agente, beta, separado]
importance: 5
---

Este es el agente B. No debe aparecer en las búsquedas del agente A.`);

    await waitFor(200);
    await memory.indexAllNotes(AGENTE_B);
    await waitFor(200);

    const resultsA = memory.spreadingActivation(TEST_AGENT, ['agente', 'beta']);
    const resultsB = memory.spreadingActivation(AGENTE_B, ['agente', 'beta']);

    const aVeB = resultsA.some(r => r.filename === 'info.md' && r.tags?.includes('beta'));
    const bVeB = resultsB.some(r => r.filename === 'info.md');

    assert(!aVeB, 'agente A no ve notas del agente B');
    assert(bVeB, 'agente B ve sus propias notas', `${resultsB.length} resultados`);

    // Limpiar agente B
    const files = memory.listFiles(AGENTE_B);
    for (const f of files) memory.remove(AGENTE_B, f.filename);
    try { fs.rmdirSync(path.join(__dirname, 'memory', AGENTE_B)); } catch {}
  }

  // ─── Limpieza ─────────────────────────────────────────────────────────────

  header('LIMPIEZA');

  section('Eliminar datos de prueba');
  {
    const files = memory.listFiles(TEST_AGENT);
    for (const f of files) {
      memory.remove(TEST_AGENT, f.filename);
    }
    try { fs.rmdirSync(path.join(__dirname, 'memory', TEST_AGENT)); } catch {}

    const files2 = memory.listFiles(TEST_AGENT2);
    for (const f of files2) {
      memory.remove(TEST_AGENT2, f.filename);
    }
    try { fs.rmdirSync(path.join(__dirname, 'memory', TEST_AGENT2)); } catch {}

    // Limpiar DB
    const db = memory.getDB();
    if (db) {
      db.prepare(`DELETE FROM notes WHERE agent_key LIKE 'test_agent_%'`).run();
      db.prepare(`DELETE FROM consolidation_queue WHERE agent_key LIKE 'test_agent_%'`).run();
      ok('registros SQLite eliminados');
    }

    // Limpiar directorio temporal
    try { fs.rmdirSync(TEST_MEMORY_DIR, { recursive: true }); } catch {}
    ok(`datos de agentes de prueba eliminados`);
  }

  // ─── Resumen ──────────────────────────────────────────────────────────────

  header('RESUMEN');
  console.log(`\n  ${C.green}✓ Pasaron: ${passed}${C.reset}`);
  if (failed > 0) console.log(`  ${C.red}✗ Fallaron: ${failed}${C.reset}`);
  else console.log(`  ${C.gray}✗ Fallaron: ${failed}${C.reset}`);
  if (skipped > 0) console.log(`  ${C.yellow}⊘ Saltados: ${skipped}${C.reset}`);
  console.log('');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error(`\n${C.red}ERROR FATAL: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
