'use strict';

const OpenAI = require('openai');
const tools = require('../tools');

module.exports = {
  name: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-4o',
  models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],

  async *chat({ systemPrompt, history, apiKey, model, executeTool: execToolFn }) {
    if (!apiKey) {
      yield { type: 'done', fullText: 'Error: API key de OpenAI no configurada. Configurala en el panel ⚙️.' };
      return;
    }

    const client = new OpenAI({ apiKey });
    const usedModel = model || this.defaultModel;
    const toolDefs  = tools.toOpenAIFormat();
    const execTool  = execToolFn || tools.executeTool;

    // Construir messages OpenAI
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of history) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }

    let fullText = '';

    while (true) {
      let response;
      try {
        response = await client.chat.completions.create({
          model: usedModel,
          messages,
          tools: toolDefs,
          tool_choice: 'auto',
        });
      } catch (err) {
        yield { type: 'done', fullText: `Error OpenAI: ${err.message}` };
        return;
      }

      const choice = response.choices?.[0];
      const msg = choice?.message;

      if (!msg) {
        yield { type: 'done', fullText };
        return;
      }

      if (msg.content) {
        fullText += msg.content;
        yield { type: 'text', text: msg.content };
      }

      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length === 0 || choice.finish_reason === 'stop') {
        yield { type: 'done', fullText };
        return;
      }

      // Agregar respuesta del asistente al historial
      messages.push(msg);

      // Ejecutar tool calls
      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}

        yield { type: 'tool_call', name: fnName, args: fnArgs };
        const result = await execTool(fnName, fnArgs);
        yield { type: 'tool_result', name: fnName, result };

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: String(result),
        });
      }
    }
  },
};
