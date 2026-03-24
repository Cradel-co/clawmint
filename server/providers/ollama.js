'use strict';

const OpenAI = require('openai');
const http   = require('http');

const DEFAULT_BASE_URL = 'http://100.64.0.5:11434';

// Modelos con soporte de visión (prefijos, se matchean sin tag)
const VISION_PREFIXES = ['minicpm-v', 'llava', 'llava-llama3', 'bakllava'];

// Cache de modelos disponibles
let cachedModels = null;
let cacheExpiry = 0;

function getBaseUrl() {
  return process.env.OLLAMA_URL || DEFAULT_BASE_URL;
}

function isVisionModel(model) {
  const name = model.split(':')[0];
  return VISION_PREFIXES.some(p => name === p || name.startsWith(p));
}

async function fetchAvailableModels() {
  if (cachedModels && Date.now() < cacheExpiry) return cachedModels;
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    if (!res.ok) return cachedModels || [];
    const data = await res.json();
    cachedModels = (data.models || []).map(m => m.name);
    cacheExpiry = Date.now() + 30000; // cache 30s
    return cachedModels;
  } catch {
    return cachedModels || [];
  }
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
  defaultModel: 'qwen2.5:7b',
  models: [], // se llena dinámicamente con fetchModels()

  async fetchModels() {
    const models = await fetchAvailableModels();
    this.models = models.length ? models : ['qwen2.5:7b'];
    return this.models;
  },

  async *chat({ systemPrompt, history, model, images }) {
    const baseUrl   = getBaseUrl();
    // Cargar modelos disponibles si no hay
    if (!this.models.length) await this.fetchModels();
    const usedModel = model || this.defaultModel;
    const hasImages = images && images.length > 0;

    // Si hay imágenes, usar la API nativa de Ollama (no la compatible con OpenAI)
    if (hasImages) {
      const visionModel = isVisionModel(usedModel) ? usedModel
        : this.models.find(m => isVisionModel(m)) || 'minicpm-v:latest';
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

    // Sin imágenes: usar API compatible con OpenAI (streaming)
    const baseURL = baseUrl + '/v1';
    const client = new OpenAI({ apiKey: 'ollama', baseURL });

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
    const models = await fetchAvailableModels();
    const visionModel = models.find(m => isVisionModel(m)) || 'minicpm-v:latest';
    return ollamaNativeChat(baseUrl, visionModel, messages);
  },
};
