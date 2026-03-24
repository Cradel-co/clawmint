'use strict';

const OpenAI = require('openai');
const http   = require('http');
const tools  = require('../tools');

const DEFAULT_BASE_URL = 'http://100.64.0.5:11434';

// Modelos con soporte de visión
const VISION_MODELS = ['minicpm-v', 'llava', 'llava:13b', 'llava:34b'];

function getBaseUrl() {
  return process.env.OLLAMA_URL || DEFAULT_BASE_URL;
}

/**
 * Envía un mensaje con imágenes a Ollama usando la API nativa (/api/chat)
 * La API compatible con OpenAI no soporta imágenes en Ollama.
 */
function ollamaNativeChat(baseUrl, model, messages) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/chat', baseUrl);
    const body = JSON.stringify({ model, messages, stream: false });
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data.message?.content || '');
        } catch (e) { reject(new Error(`Respuesta inválida de Ollama: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Timeout: Ollama no respondió en 300s')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  name: 'ollama',
  label: 'Ollama (local)',
  defaultModel: 'qwen2.5',
  models: ['qwen2.5', 'minicpm-v', 'llama3.2', 'llama3.1', 'mistral', 'codellama', 'deepseek-coder'],

  async *chat({ systemPrompt, history, model, images, executeTool: execToolFn, channel }) {
    const baseUrl   = getBaseUrl();
    const usedModel = model || this.defaultModel;
    const hasImages = images && images.length > 0;

    // Si hay imágenes, usar la API nativa de Ollama (no la compatible con OpenAI)
    // El path de visión no soporta tools (API nativa no los maneja)
    if (hasImages) {
      const visionModel = VISION_MODELS.includes(usedModel) ? usedModel : 'minicpm-v';
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      for (const m of history.slice(0, -1)) {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
      }

      // Último mensaje con imágenes
      const lastMsg = history[history.length - 1];
      const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : (Array.isArray(lastMsg?.content) ? lastMsg.content.find(c => c.type === 'text')?.text || '' : '');
      messages.push({
        role: 'user',
        content: lastText,
        images: images.map(img => img.base64),
      });

      try {
        const result = await ollamaNativeChat(baseUrl, visionModel, messages);
        yield { type: 'text', text: result };
        yield { type: 'done', fullText: result };
      } catch (err) {
        yield { type: 'text', text: `Error Ollama visión: ${err.message}` };
        yield { type: 'done', fullText: `Error Ollama visión: ${err.message}` };
      }
      return;
    }

    // Sin imágenes: usar API compatible con OpenAI
    const baseURL = baseUrl + '/v1';
    const client = new OpenAI({ apiKey: 'ollama', baseURL });

    const toolDefs = tools.toOpenAIFormat({ channel });
    const execTool = execToolFn || tools.executeTool;
    const hasTools = toolDefs.length > 0 && execToolFn;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of history) {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }

    let fullText = '';

    if (hasTools) {
      // Non-streaming con tool loop (Ollama streaming + tools tiene bugs conocidos)
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
          yield { type: 'done', fullText: `Error Ollama: ${err.message}` };
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

        messages.push(msg);

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
    }

    // Streaming sin tools (comportamiento original)
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

  /**
   * Describe una imagen usando minicpm-v (usado como "ojos" para otros providers)
   * Redimensiona a max 512px para evitar OOM en CPU
   */
  async describeImage(images, prompt = 'Describí detalladamente lo que ves en esta imagen.') {
    const sharp = require('sharp');
    const baseUrl = getBaseUrl();
    const resized = [];
    for (const img of images) {
      try {
        const buf = await sharp(Buffer.from(img.base64, 'base64'))
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        resized.push(buf.toString('base64'));
      } catch {
        resized.push(img.base64);
      }
    }
    const messages = [{
      role: 'user',
      content: prompt,
      images: resized,
    }];
    return ollamaNativeChat(baseUrl, 'minicpm-v', messages);
  },
};
