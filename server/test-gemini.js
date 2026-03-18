'use strict';

/**
 * test-gemini.js — Test rápido del provider Gemini
 * Uso: node test-gemini.js
 */

const gemini = require('./providers/gemini');
const config = require('./provider-config.json');

const apiKey = config.providers?.gemini?.apiKey;
const model  = config.providers?.gemini?.model || gemini.defaultModel;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

function ok(l, d = '')   { console.log(`  ${C.green}✓${C.reset} ${l}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function fail(l, d = '') { console.log(`  ${C.red}✗ ${l}${C.reset}${d ? ` ${C.gray}(${d})${C.reset}` : ''}`); }
function info(l)         { console.log(`  ${C.gray}→ ${l}${C.reset}`); }

async function runTest(label, history, expectFn) {
  console.log(`\n${C.bold}${C.cyan}── ${label}${C.reset}`);
  const chunks = [];
  let done = false;
  const t0 = Date.now();

  try {
    for await (const event of gemini.chat({ systemPrompt: null, history, apiKey, model })) {
      if (event.type === 'text')      { chunks.push(event.text); process.stdout.write(event.text); }
      if (event.type === 'tool_call') { info(`tool_call: ${event.name}(${JSON.stringify(event.args)})`); }
      if (event.type === 'tool_result') { info(`tool_result: ${event.name} → ${String(event.result).slice(0,80)}`); }
      if (event.type === 'done')      { done = true; }
    }
  } catch (err) {
    fail(label, err.message);
    return;
  }

  if (chunks.length) process.stdout.write('\n');
  const fullText = chunks.join('');
  const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);

  info(`${elapsed}s, ${fullText.length} chars`);

  if (!done)      { fail('evento done no recibido'); return; }
  if (!fullText)  { fail('respuesta vacía'); return; }

  if (expectFn) {
    const result = expectFn(fullText);
    if (result === true || result === undefined) ok(label);
    else fail(label, result);
  } else {
    ok(label);
  }
}

async function main() {
  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(56)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  TEST GEMINI API — modelo: ${model}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'═'.repeat(56)}${C.reset}`);

  if (!apiKey) {
    fail('API key no configurada en provider-config.json');
    process.exit(1);
  }
  info(`API key: ${apiKey.slice(0,8)}…`);

  // Test 1: respuesta básica
  await runTest('Chat básico', [
    { role: 'user', content: 'Responde con exactamente estas palabras: GEMINI OK' },
  ], text => /GEMINI\s*OK/i.test(text) || `esperaba "GEMINI OK", recibí: ${text.slice(0,80)}`);

  // Test 2: cálculo simple
  await runTest('Cálculo numérico', [
    { role: 'user', content: '¿Cuánto es 17 × 23? Responde solo el número.' },
  ], text => /391/.test(text) || `esperaba 391, recibí: ${text.slice(0,80)}`);

  // Test 3: historial multi-turno
  await runTest('Historial multi-turno', [
    { role: 'user',      content: 'Mi color favorito es el azul.' },
    { role: 'assistant', content: 'Entendido, tu color favorito es el azul.' },
    { role: 'user',      content: '¿Cuál es mi color favorito? Solo dí el color.' },
  ], text => /azul/i.test(text) || `esperaba "azul", recibí: ${text.slice(0,80)}`);

  // Test 4: tool_call — bash
  await runTest('Tool call (bash: echo)', [
    { role: 'user', content: 'Ejecuta el comando bash: echo "HOLA_GEMINI" y dime qué salió.' },
  ], text => /HOLA_GEMINI/i.test(text) || `esperaba HOLA_GEMINI en respuesta, recibí: ${text.slice(0,120)}`);

  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(56)}${C.reset}\n`);
}

main().catch(err => {
  console.error(`\n${C.red}${C.bold}ERROR FATAL: ${err.message}${C.reset}`);
  process.exit(1);
});
