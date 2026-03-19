'use strict';

const OpenAI = require('openai');

const DEFAULT_BASE_URL = 'http://100.64.0.1:11434';

module.exports = {
  name: 'ollama',
  label: 'Ollama (local)',
  defaultModel: 'llama3.2',
  models: ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'deepseek-coder'],

  async *chat({ systemPrompt, history, model }) {
    const baseURL = (process.env.OLLAMA_URL || DEFAULT_BASE_URL) + '/v1';

    const client = new OpenAI({ apiKey: 'ollama', baseURL });
    const usedModel = model || this.defaultModel;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of history) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }

    let fullText = '';

    try {
      const stream = await client.chat.completions.create({
        model: usedModel,
        messages,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          yield { type: 'text', text: delta };
        }
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        yield { type: 'text', text: `Error: no se pudo conectar a Ollama en ${baseURL}. Verificá que esté corriendo.` };
      } else {
        yield { type: 'text', text: `Error Ollama: ${msg}` };
      }
    }

    yield { type: 'done', fullText };
  },
};
