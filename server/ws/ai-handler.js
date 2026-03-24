'use strict';

const crypto = require('crypto');

/**
 * Factory para startAISession — sesión AI acoplada al WS, soporta múltiples providers.
 *
 * @param {Object} deps
 * @param {Object} deps.providersModule
 * @param {Object} deps.agents
 * @param {Object} deps.memory
 * @param {Object} deps.providerConfig
 * @returns {Function} startAISession(ws, opts)
 */
function createAIHandler({ providersModule, agents, memory, providerConfig }) {

  // Historial de sesiones AI persistente entre reconexiones WS
  // sessionId → { history: [], ts: number }
  const aiSessionHistories = new Map();

  // Limpiar entradas de más de 24h cada hora
  setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, entry] of aiSessionHistories) {
      if (entry.ts < cutoff) aiSessionHistories.delete(id);
    }
  }, 60 * 60 * 1000).unref();

  function startAISession(ws, opts) {
    const providerName = opts.provider || 'anthropic';
    const provider = providersModule.get(providerName);

    // Asignar sessionId propio y enviar al cliente para reconexiones futuras
    const sessionId = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'session_id', id: sessionId }));

    // Recuperar historial previo si el cliente reconectó con un sessionId anterior
    const prevEntry = opts.sessionId ? aiSessionHistories.get(opts.sessionId) : null;
    const history = prevEntry ? prevEntry.history : [];
    aiSessionHistories.set(sessionId, { history, ts: Date.now() });
    let inputBuffer = '';
    let processing = false;

    // Memoria del agente
    const agentKey = opts.agentKey || null;
    const agentDef = agentKey ? agents.get(agentKey) : null;
    const memoryFiles = agentDef?.memoryFiles || [];

    const basePrompt = opts.systemPrompt ||
      'Sos un asistente útil. Respondé de forma concisa y clara. ' +
      'Usá texto plano sin markdown ya que tu respuesta se mostrará en una terminal.';

    const toolInstructions = agentKey ? memory.TOOL_INSTRUCTIONS : '';
    // systemPrompt se actualiza en el primer mensaje con la memoria relevante
    let systemPrompt = [basePrompt, toolInstructions].filter(Boolean).join('\n\n');
    let memoryInjected = false;

    const apiKey  = providerConfig.getApiKey(providerName);
    const model   = opts.model || providerConfig.getConfig().providers[providerName]?.model || provider.defaultModel;

    const providerLabel = provider.label || providerName;
    send(`\x1b[1;32m╔══ ${providerLabel} ══╗\x1b[0m\r\n`);
    send('\x1b[90mEscribí tu mensaje y presioná Enter. Ctrl+C para cancelar línea.\x1b[0m\r\n\r\n');
    prompt();

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== 'input') return;
        if (processing) return;

        for (const char of msg.data) {
          if (char === '\r' || char === '\n') {
            const line = inputBuffer.trim();
            inputBuffer = '';
            send('\r\n');
            if (line) await askAI(line);
            else prompt();
          } else if (char === '\x7f' || char === '\x08') {
            if (inputBuffer.length > 0) {
              inputBuffer = inputBuffer.slice(0, -1);
              send('\x08 \x08');
            }
          } else if (char === '\x03') {
            inputBuffer = '';
            send('^C\r\n');
            prompt();
          } else {
            inputBuffer += char;
            send(char);
          }
        }
      } catch { /* ignorar */ }
    });

    async function askAI(userMessage) {
      processing = true;
      // Inyectar memoria en el primer mensaje con el texto real del usuario
      if (agentKey && !memoryInjected) {
        memoryInjected = true;
        const memCtx = memory.buildMemoryContext(agentKey, userMessage);
        if (memCtx) {
          systemPrompt = [basePrompt, memCtx, toolInstructions].filter(Boolean).join('\n\n');
        }
      }
      history.push({ role: 'user', content: userMessage });
      send(`\x1b[36m${providerLabel}:\x1b[0m `);

      try {
        let fullText = '';
        const gen = provider.chat({ systemPrompt, history, apiKey, model });

        for await (const event of gen) {
          if (event.type === 'text') {
            const chunk = event.text.replace(/\n/g, '\r\n');
            send(chunk);
            fullText = event.text; // se acumula en 'done'
          } else if (event.type === 'tool_call') {
            send(`\r\n\x1b[90m🔧 ${event.name}(${JSON.stringify(event.args)})\x1b[0m\r\n`);
          } else if (event.type === 'tool_result') {
            const preview = String(event.result).slice(0, 200);
            send(`\x1b[90m→ ${preview}${event.result?.length > 200 ? '…' : ''}\x1b[0m\r\n`);
            send(`\x1b[36m${providerLabel}:\x1b[0m `);
          } else if (event.type === 'done') {
            fullText = event.fullText;
          }
        }

        // Extraer y aplicar operaciones de memoria
        if (agentKey && fullText) {
          const { clean, ops } = memory.extractMemoryOps(fullText);
          if (ops.length > 0) {
            const saved = memory.applyOps(agentKey, ops);
            fullText = clean;
            send(`\r\n\x1b[90m💾 Memoria guardada: ${saved.join(', ')}\x1b[0m`);
          }
        }

        history.push({ role: 'assistant', content: fullText });
        send('\r\n\r\n');
      } catch (err) {
        send(`\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n\r\n`);
      }

      processing = false;
      prompt();
    }

    function prompt() { send('\x1b[33mvos>\x1b[0m '); }

    function send(text) {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ type: 'output', data: text }));
    }
  }

  return startAISession;
}

module.exports = createAIHandler;
