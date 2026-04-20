'use strict';

/**
 * openaiCompatChat — lógica compartida para providers que usan la API OpenAI-compatible
 * (OpenAI, DeepSeek, Grok, Ollama con `--openai-compat`).
 *
 * Features:
 *   - Streaming real vía `stream: true` (chunks `delta.content` → 'text' event)
 *   - Tool calls con acumulación por `index` (llegan fragmentados)
 *   - JSON parsing seguro en `tool_call_end`: si falla, emite error explícito al modelo
 *     para que corrija (en vez de silenciar con `{}`)
 *   - Cancelación real vía AbortSignal pasado como option al SDK
 *   - Loop multi-turno: tool_use → tool_result → continue hasta `finish_reason: stop`
 *
 * El provider concreto solo provee el cliente (OpenAI con baseURL/apiKey específica)
 * y los metadatos (label, defaultModel, models).
 */

const tools = require('../../tools');

/**
 * @param {Object} deps
 * @param {import('openai').default} deps.OpenAI — clase OpenAI SDK
 * @param {Object} deps.clientConfig — { apiKey, baseURL?, timeout? }
 * @param {string} deps.providerLabel — 'OpenAI' | 'DeepSeek' | 'Grok'
 * @param {string} deps.defaultModel
 * @returns {AsyncGenerator} generator para usar dentro de provider.chat()
 */
async function* openaiCompatChat({
  OpenAI,
  clientConfig,
  providerLabel,
  defaultModel,
  systemPrompt,
  history,
  model,
  executeTool: execToolFn,
  channel,
  agentRole,
  signal,
}) {
  if (!clientConfig.apiKey) {
    yield { type: 'done', fullText: `Error: API key de ${providerLabel} no configurada. Configurala en el panel ⚙️.` };
    return;
  }

  const client    = new OpenAI(clientConfig);
  const usedModel = model || defaultModel;
  const toolDefs  = tools.toOpenAIFormat({ channel, agentRole });
  const execTool  = execToolFn || tools.executeTool;

  // Construir messages
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const m of history || []) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: Array.isArray(m.content) ? m.content : (m.content || ''),
    });
  }

  let fullText = '';
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  while (true) {
    if (signal && signal.aborted) {
      yield { type: 'done', fullText: fullText || 'Cancelado.' };
      return;
    }

    const req = {
      model: usedModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (toolDefs && toolDefs.length) {
      req.tools = toolDefs;
      req.tool_choice = 'auto';
    }

    // Estado del turno actual
    let turnText = '';
    /** Map<index, {id?, name?, argumentsRaw: string}> — tool_calls en construcción */
    const toolCallsByIndex = new Map();
    let finishReason = null;
    let turnUsage = null;

    try {
      const stream = signal
        ? await client.chat.completions.create(req, { signal })
        : await client.chat.completions.create(req);

      for await (const chunk of stream) {
        if (signal && signal.aborted) break;

        // stream_options: { include_usage: true } → último chunk trae .usage (choices vacío)
        if (chunk.usage) {
          turnUsage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // Texto progresivo
        if (delta.content) {
          turnText += delta.content;
          fullText += delta.content;
          yield { type: 'text', text: delta.content };
        }

        // Tool calls fragmentados — acumular por index
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallsByIndex.has(idx)) {
              toolCallsByIndex.set(idx, { id: null, name: null, argumentsRaw: '' });
            }
            const acc = toolCallsByIndex.get(idx);
            if (tc.id) acc.id = tc.id;
            if (tc.function) {
              if (tc.function.name) acc.name = tc.function.name;
              if (typeof tc.function.arguments === 'string') {
                acc.argumentsRaw += tc.function.arguments;
              }
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      if (signal && signal.aborted) {
        yield { type: 'done', fullText: fullText || 'Cancelado por el usuario.' };
        return;
      }
      yield { type: 'done', fullText: `Error ${providerLabel}: ${err.message}` };
      return;
    }

    // Acumular usage del turno
    if (turnUsage) {
      totalPromptTokens     += turnUsage.prompt_tokens     || 0;
      totalCompletionTokens += turnUsage.completion_tokens || 0;
    }

    // Reconstruir assistant message desde los fragmentos
    const toolCalls = Array.from(toolCallsByIndex.values())
      .filter(tc => tc.id && tc.name)
      .map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argumentsRaw || '' },
      }));

    // Fin de turno sin tools → emitir usage + done
    if (toolCalls.length === 0 || finishReason === 'stop') {
      yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
      yield { type: 'done', fullText };
      return;
    }

    // Agregar assistant turn al history (OpenAI requiere que incluya tool_calls para correlacionar)
    messages.push({
      role: 'assistant',
      content: turnText || null,
      tool_calls: toolCalls,
    });

    // Ejecutar cada tool_call
    for (const tc of toolCalls) {
      if (signal && signal.aborted) {
        yield { type: 'done', fullText: fullText || 'Cancelado durante ejecución de tool.' };
        return;
      }

      const fnName = tc.function.name;
      const rawArgs = tc.function.arguments || '';
      let fnArgs;
      let argsError = null;
      try {
        fnArgs = rawArgs ? JSON.parse(rawArgs) : {};
      } catch (err) {
        fnArgs = {};
        argsError = { raw: rawArgs, message: err.message };
      }

      yield { type: 'tool_call', name: fnName, args: fnArgs };

      let result;
      if (argsError) {
        // No silenciar — responder al modelo con error descriptivo para que corrija
        result = `Error: argumentos para ${fnName} no son JSON válido (${argsError.message}). Raw recibido: ${argsError.raw.slice(0, 500)}. Re-intenta con JSON válido.`;
      } else {
        try {
          result = await execTool(fnName, fnArgs);
        } catch (err) {
          result = `Error ejecutando ${fnName}: ${err.message}`;
        }
      }

      yield { type: 'tool_result', name: fnName, result };

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: String(result),
      });
    }
    // Continuar loop — el modelo responderá sabiendo los resultados
  }
}

module.exports = { openaiCompatChat };
