'use strict';

const { GoogleGenAI } = require('@google/genai');
const tools = require('../tools');

module.exports = {
  name: 'gemini',
  label: 'Google Gemini',
  defaultModel: 'gemini-2.5-flash',
  models: ['gemini-2.5-flash', 'gemini-2.5-pro'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool: execToolFn, images }) {
    if (!apiKey) {
      yield { type: 'done', fullText: 'Error: API key de Gemini no configurada. Configurala en el panel ⚙️.' };
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const usedModel = model || this.defaultModel;
    const toolDefs  = tools.toGeminiFormat();
    const execTool  = execToolFn || tools.executeTool;

    // Convertir history al formato Gemini
    // history: [{ role: 'user'|'assistant', content: string }]
    const contents = history.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    }));

    // El último mensaje del user
    const lastMsg = history[history.length - 1];
    const userText = lastMsg?.content || '';

    const config = {
      tools: [{ functionDeclarations: toolDefs }],
    };
    if (systemPrompt) config.systemInstruction = systemPrompt;

    let fullText = '';
    // Construir parts del último mensaje con imágenes si las hay
    const lastParts = [];
    if (images && images.length > 0) {
      for (const img of images) {
        lastParts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
      }
    }
    lastParts.push({ text: userText });
    let currentContents = [...contents, { role: 'user', parts: lastParts }];

    while (true) {
      let response;
      try {
        response = await Promise.race([
          ai.models.generateContent({
            model: usedModel,
            contents: currentContents,
            config,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout: Gemini no respondió en 60s')), 60000)
          ),
        ]);
      } catch (err) {
        yield { type: 'done', fullText: `Error Gemini: ${err.message}` };
        return;
      }

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      let assistantText = '';
      const functionCalls = [];

      for (const part of parts) {
        if (part.text) {
          assistantText += part.text;
        } else if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
      }

      if (assistantText) {
        fullText += assistantText;
        yield { type: 'text', text: assistantText };
      }

      if (functionCalls.length === 0) {
        yield { type: 'done', fullText };
        return;
      }

      // Agregar respuesta del modelo al historial
      currentContents.push({ role: 'model', parts });

      // Ejecutar function calls
      const functionResponses = [];
      for (const fc of functionCalls) {
        yield { type: 'tool_call', name: fc.name, args: fc.args };
        const result = await execTool(fc.name, fc.args || {});
        yield { type: 'tool_result', name: fc.name, result };
        functionResponses.push({
          functionResponse: {
            name: fc.name,
            response: { output: String(result) },
          },
        });
      }

      currentContents.push({ role: 'user', parts: functionResponses });
    }
  },
};
