'use strict';

/**
 * test-telegram-gemini.js
 *
 * Imita exactamente el pipeline de TelegramBot._sendToApiProvider con provider=gemini.
 * No requiere Telegram real — simula el objeto `chat` y captura los "mensajes" enviados.
 *
 * Uso: node test-telegram-gemini.js
 */

const providersModule = require('./providers');
const providerConfig  = require('./provider-config');
const memoryModule    = require('./memory');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m',
  gray: '\x1b[90m', yellow: '\x1b[33m', blue: '\x1b[34m',
};

let passed = 0, failed = 0;
function ok(l, d = '')   { passed++; console.log(`  ${C.green}✓${C.reset} ${l}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function fail(l, d = '') { failed++; console.log(`  ${C.red}✗ ${l}${C.reset}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function info(l)         { console.log(`  ${C.gray}→ ${l}${C.reset}`); }
function section(l)      { console.log(`\n${C.bold}${C.cyan}── ${l}${C.reset}`); }
function header(l)       { console.log(`\n${C.bold}${C.blue}${'═'.repeat(60)}\n  ${l}\n${'═'.repeat(60)}${C.reset}`); }

// ─── Pipeline imitado de _sendToApiProvider ────────────────────────────────────
async function sendToApiProvider(text, chat, providerName, agentKey = null) {
  const provider = providersModule.get(providerName);
  const apiKey   = providerConfig.getApiKey(providerName);
  const cfg      = providerConfig.getConfig();
  const model    = cfg.providers?.[providerName]?.model || provider.defaultModel;

  // Construir system prompt (igual que telegram.js)
  const basePrompt = 'Sos un asistente útil. Respondé de forma concisa y clara.';
  const memCtxRaw  = agentKey
    ? memoryModule.buildMemoryContext(agentKey, text, { provider: providerName, apiKey })
    : '';
  const memoryCtx  = (memCtxRaw && typeof memCtxRaw.then === 'function')
    ? await memCtxRaw.catch(() => '')
    : (memCtxRaw || '');

  const { shouldNudge, signals } = memoryModule.detectSignals(agentKey, text);
  const toolInstr   = (agentKey && shouldNudge) ? memoryModule.TOOL_INSTRUCTIONS : '';
  const systemPrompt = [basePrompt, memoryCtx, toolInstr].filter(Boolean).join('\n\n');

  const userContent = shouldNudge ? text + memoryModule.buildNudge(signals) : text;

  if (!chat.aiHistory) chat.aiHistory = [];
  chat.aiHistory.push({ role: 'user', content: userContent });

  // "Mensajes enviados" — equivale a sendMessage/editMessageText
  const sentMessages = [];
  const toolCalls    = [];

  let accumulated = '';

  const gen = provider.chat({ systemPrompt, history: chat.aiHistory, apiKey, model });

  for await (const event of gen) {
    if (event.type === 'text') {
      accumulated += event.text;
      sentMessages.push({ type: 'edit', text: accumulated });
    } else if (event.type === 'tool_call') {
      toolCalls.push(event);
      sentMessages.push({ type: 'tool_preview', text: `🔧 ${event.name}(${JSON.stringify(event.args).slice(0, 100)})` });
    } else if (event.type === 'tool_result') {
      sentMessages.push({ type: 'tool_result', text: `${event.name} → ${String(event.result).slice(0, 100)}` });
    } else if (event.type === 'done') {
      accumulated = event.fullText || accumulated;
    }
  }

  // Extraer ops de memoria
  let finalText = accumulated;
  let savedFiles = [];
  if (agentKey && finalText) {
    const { clean, ops } = memoryModule.extractMemoryOps(finalText);
    if (ops.length > 0) {
      savedFiles = memoryModule.applyOps(agentKey, ops);
      finalText = clean || finalText;
    }
  }

  chat.aiHistory.push({ role: 'assistant', content: finalText });

  return { finalText, sentMessages, toolCalls, savedFiles, model, systemPromptLen: systemPrompt.length };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  header('TEST TELEGRAM → GEMINI  (pipeline real _sendToApiProvider)');

  const PROVIDER = 'gemini';
  const AGENT    = 'test_telegram_gemini_' + Date.now().toString(36);

  // Verificar config
  const apiKey = providerConfig.getApiKey(PROVIDER);
  if (!apiKey) { fail('API key de gemini no configurada'); process.exit(1); }
  info(`provider: ${PROVIDER} | apiKey: ${apiKey.slice(0,8)}… | agente: ${AGENT}`);

  // ── TEST 1: Conversación simple ──────────────────────────────────────────────
  section('TEST 1 — Respuesta básica (sin memoria, sin tool)');
  {
    const chat = { provider: PROVIDER, aiHistory: [] };
    const t0   = Date.now();
    const r    = await sendToApiProvider('Cuánto es 8 por 9? Solo el número.', chat, PROVIDER);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    info(`modelo: ${r.model} | system prompt: ${r.systemPromptLen} chars`);
    info(`respuesta: "${r.finalText.trim()}"`);
    info(`historial: ${chat.aiHistory.length} mensajes | ${elapsed}s`);

    const has72 = /72/.test(r.finalText);
    has72 ? ok('respuesta correcta (72)', r.finalText.trim()) : fail('esperaba 72', r.finalText.trim());
    chat.aiHistory.length === 2
      ? ok('aiHistory tiene 2 mensajes (user + assistant)')
      : fail(`aiHistory debería tener 2, tiene ${chat.aiHistory.length}`);
  }

  // ── TEST 2: Historial multi-turno ────────────────────────────────────────────
  section('TEST 2 — Historial multi-turno acumulado');
  {
    const chat = { provider: PROVIDER, aiHistory: [] };

    await sendToApiProvider('Mi número de suerte es el 42.', chat, PROVIDER);
    const r2 = await sendToApiProvider('Cuál es mi número de suerte?', chat, PROVIDER);

    info(`respuesta turno 2: "${r2.finalText.trim().slice(0, 100)}"`);
    info(`historial acumulado: ${chat.aiHistory.length} mensajes`);

    /42/.test(r2.finalText)
      ? ok('recuerda el número de suerte (42) en turno 2')
      : fail('no recordó el 42', r2.finalText.trim().slice(0, 100));

    chat.aiHistory.length === 4
      ? ok('aiHistory 4 mensajes (2 turnos)')
      : fail(`aiHistory debería tener 4, tiene ${chat.aiHistory.length}`);
  }

  // ── TEST 3: Tool call (bash) ──────────────────────────────────────────────────
  section('TEST 3 — Tool call: bash');
  {
    const chat = { provider: PROVIDER, aiHistory: [] };
    const r    = await sendToApiProvider('Ejecutá: echo "TELEGRAM_GEMINI_OK" y decime la salida exacta.', chat, PROVIDER);

    info(`tool calls: ${r.toolCalls.length}`);
    for (const tc of r.toolCalls) info(`  🔧 ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)})`);
    info(`respuesta: "${r.finalText.trim().slice(0, 150)}"`);

    r.toolCalls.length > 0
      ? ok(`hizo ${r.toolCalls.length} tool call(s)`, r.toolCalls.map(t=>t.name).join(', '))
      : fail('no hizo ningún tool call');

    /TELEGRAM_GEMINI_OK/.test(r.finalText)
      ? ok('respuesta final contiene salida del bash')
      : fail('no encontró TELEGRAM_GEMINI_OK en respuesta', r.finalText.slice(0, 150));
  }

  // ── TEST 4: Memoria — guardar nota ────────────────────────────────────────────
  section('TEST 4 — Memoria: guardar info personal');
  {
    const chat = { provider: PROVIDER, aiHistory: [] };
    const r    = await sendToApiProvider(
      'Me llamo Laura, soy diseñadora UX y trabajo en Figma todos los días.',
      chat, PROVIDER, AGENT
    );

    info(`tool instructions inyectadas: ${r.systemPromptLen > 200 ? 'sí' : 'no'}`);
    info(`respuesta: "${r.finalText.trim().slice(0, 120)}"`);
    info(`notas guardadas: [${r.savedFiles.join(', ') || 'ninguna'}]`);

    // Verificar señal de memoria
    const { shouldNudge } = memoryModule.detectSignals(AGENT, 'Me llamo Laura, soy diseñadora UX');
    shouldNudge
      ? ok('detectó señal de memoria (nombre/trabajo)')
      : fail('no detectó señal de memoria');

    // Nota puede o no guardarse en 1 turno dependiendo del nudge
    if (r.savedFiles.length > 0) {
      ok(`guardó ${r.savedFiles.length} nota(s)`, r.savedFiles.join(', '));
    } else {
      info('no guardó en este turno (normal sin nudge fuerte)');
    }
  }

  // ── TEST 5: System prompt con memoria preexistente ────────────────────────────
  section('TEST 5 — System prompt incluye memoria guardada');
  {
    // Inyectar nota manual
    memoryModule.write(AGENT, 'perfil.md', '---\ntitle: Perfil\ntags: [laura,ux,figma]\nimportance: 8\n---\nLaura es diseñadora UX que trabaja en Figma.');
    memoryModule.indexAllNotes(AGENT);

    const chat = { provider: PROVIDER, aiHistory: [] };
    const r    = await sendToApiProvider('Qué sabés de mí?', chat, PROVIDER, AGENT);

    info(`system prompt size: ${r.systemPromptLen} chars`);
    info(`respuesta: "${r.finalText.trim().slice(0, 200)}"`);

    r.systemPromptLen > 200
      ? ok('system prompt incluye contexto de memoria')
      : fail('system prompt parece vacío', `${r.systemPromptLen} chars`);

    /laura|figma|ux|diseñadora/i.test(r.finalText)
      ? ok('respuesta usa info de memoria (laura/figma/ux)')
      : fail('respuesta no menciona datos de la nota', r.finalText.slice(0, 200));
  }

  // ── LIMPIEZA ──────────────────────────────────────────────────────────────────
  section('Limpieza');
  {
    const files = memoryModule.listFiles(AGENT);
    for (const f of files) memoryModule.remove(AGENT, f.filename);
    const db = memoryModule.getDB();
    if (db) db.prepare('DELETE FROM notes WHERE agent_key = ?').run(AGENT);
    ok('notas de test eliminadas');
  }

  // ── RESUMEN ───────────────────────────────────────────────────────────────────
  header('RESUMEN');
  console.log(`  ${C.green}${C.bold}✓ Pasaron: ${passed}${C.reset}`);
  if (failed > 0) console.log(`  ${C.red}${C.bold}✗ Fallaron: ${failed}${C.reset}`);
  else console.log(`  ${C.gray}✗ Fallaron: 0${C.reset}`);
  console.log('');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\n${C.red}${C.bold}ERROR FATAL: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
