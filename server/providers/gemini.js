'use strict';

/**
 * Gemini provider v2 — streaming + cancelación.
 *
 * Usa `ai.models.generateContentStream()` (SDK @google/genai v1.45+) para emitir
 * chunks progresivos. La cancelación se propaga vía `abortSignal` en las opciones.
 *
 * Diferencias con providers OpenAI-compat:
 *   - `systemInstruction` se pasa en `config`, no como primer message role=system
 *   - Tool definitions van en `config.tools[0].functionDeclarations`
 *   - Imágenes se inyectan como `inlineData` en el `parts` del último user turn
 *   - functionCall llega normalmente completo en un solo chunk (no fragmentado como OpenAI)
 *   - Los function results se reenvían con role='user' y parts con `functionResponse`
 */

const { GoogleGenAI } = require('@google/genai');
const tools = require('../tools');

module.exports = {
  name: 'gemini',
  label: 'Google Gemini',
  defaultModel: 'gemini-2.5-flash',
  models: ['gemini-2.5-flash', 'gemini-2.5-pro'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool: execToolFn, images, channel, agentRole, signal }) {
    if (!apiKey) {
      yield { type: 'done', fullText: 'Error: API key de Gemini no configurada. Configurala en el panel ⚙️.' };
      return;
    }

    const ai        = new GoogleGenAI({ apiKey });
    const usedModel = model || this.defaultModel;
    const toolDefs  = tools.toGeminiFormat({ channel, agentRole });
    const execTool  = execToolFn || tools.executeTool;
    const hist      = Array.isArray(history) ? history : [];

    // Convertir history a formato Gemini (excluyendo el último mensaje — se construye aparte con imágenes)
    const baseContents = hist.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: (typeof m.content === 'string' ? m.content : '') || '' }],
    }));

    const lastMsg  = hist[hist.length - 1];
    const userText = (lastMsg && typeof lastMsg.content === 'string') ? lastMsg.content : '';

    // Último user turn: imágenes (si hay) + texto
    const lastParts = [];
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img && img.base64) {
          lastParts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
        }
      }
    }
    lastParts.push({ text: userText });

    const config = {};
    if (toolDefs && toolDefs.length) config.tools = [{ functionDeclarations: toolDefs }];
    if (systemPrompt) config.systemInstruction = systemPrompt;
    if (signal) config.abortSignal = signal;

    let currentContents = [...baseContents, { role: 'user', parts: lastParts }];
    let fullText = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    while (true) {
      if (signal && signal.aborted) {
        yield { type: 'done', fullText: fullText || 'Cancelado.' };
        return;
      }

      // Estado del turno
      let turnText = '';
      const turnParts = []; // ensamblado de parts del model — para reenvío al history
      const functionCalls = [];
      let finishReason = null;

      try {
        const stream = await ai.models.generateContentStream({
          model: usedModel,
          contents: currentContents,
          config,
        });

        for await (const chunk of stream) {
          if (signal && signal.aborted) break;

          // Usage metadata puede venir en cualquier chunk, incluso sin candidates
          if (chunk.usageMetadata) {
            totalPromptTokens     += chunk.usageMetadata.promptTokenCount     || 0;
            totalCompletionTokens += chunk.usageMetadata.candidatesTokenCount || 0;
          }

          const candidate = chunk.candidates && chunk.candidates[0];
          if (!candidate) continue;

          if (candidate.finishReason) finishReason = candidate.finishReason;

          const parts = (candidate.content && candidate.content.parts) || [];
          for (const part of parts) {
            if (part.text) {
              turnText += part.text;
              fullText += part.text;
              yield { type: 'text', text: part.text };
              turnParts.push({ text: part.text });
            } else if (part.functionCall) {
              functionCalls.push(part.functionCall);
              turnParts.push(part);
            } else {
              turnParts.push(part);
            }
          }
        }
      } catch (err) {
        if (signal && signal.aborted) {
          yield { type: 'done', fullText: fullText || 'Cancelado por el usuario.' };
          return;
        }
        yield { type: 'done', fullText: `Error Gemini: ${err.message}` };
        return;
      }

      // Fin de turno: sin function calls O finish reason indica término
      if (functionCalls.length === 0) {
        yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
        yield { type: 'done', fullText };
        return;
      }

      // Agregar turn del model al history (preservar parts completos)
      currentContents.push({ role: 'model', parts: turnParts });

      // Ejecutar function calls
      const functionResponses = [];
      for (const fc of functionCalls) {
        if (signal && signal.aborted) {
          yield { type: 'done', fullText: fullText || 'Cancelado durante ejecución de tool.' };
          return;
        }

        const fnName = fc.name || '(sin nombre)';
        const fnArgs = fc.args || {};
        yield { type: 'tool_call', name: fnName, args: fnArgs };

        let result;
        try {
          result = await execTool(fnName, fnArgs);
        } catch (err) {
          result = `Error ejecutando ${fnName}: ${err.message}`;
        }
        yield { type: 'tool_result', name: fnName, result };

        functionResponses.push({
          functionResponse: {
            name: fnName,
            response: { output: String(result) },
          },
        });
      }

      currentContents.push({ role: 'user', parts: functionResponses });

      // Discard finishReason para el próximo turno — la condición de salida arriba maneja el fin
      void finishReason;
    }
  },
};
