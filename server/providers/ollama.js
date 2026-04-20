'use strict';

/**
 * Ollama provider v2 — streaming + cancelación.
 *
 * Ollama tiene dos APIs:
 *   - Nativa (/api/chat) — soporta imágenes (vision models) pero NO tools
 *   - OpenAI-compat (/v1/chat/completions) — soporta tools + streaming pero NO imágenes
 *
 * Gotcha histórico: si el caller pasaba `images` + `tools`, la rama vision se ejecutaba e ignoraba
 * silenciosamente las tools. Ahora emitimos error explícito con `code:'unsupported_combo'`.
 *
 * Implementación:
 *   - Vision branch: HTTP nativo con AbortSignal; streaming del body (`"stream": true`) para UX progresivo
 *   - Tool/text branch: delega a `openaiCompatChat` (mismo helper que openai/deepseek/grok)
 *   - describeImage(): utility para que otros providers usen minicpm-v como "ojos"
 */

const OpenAI = require('openai');
const http   = require('http');
const https  = require('https');
const { openaiCompatChat } = require('./base/openaiCompatChat');
const tools  = require('../tools');

const DEFAULT_BASE_URL = 'http://100.64.0.5:11434';
const OLLAMA_VISION_TIMEOUT_MS = 300_000;

// Modelos con soporte de visión (prefijos, se matchean sin tag)
const VISION_PREFIXES = ['minicpm-v', 'llava', 'llava-llama3', 'bakllava'];

// Cache de modelos disponibles
let cachedModels = null;
let cacheExpiry = 0;

function getBaseUrl() {
  return process.env.OLLAMA_URL || DEFAULT_BASE_URL;
}

function isVisionModel(model) {
  if (!model) return false;
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
    cacheExpiry = Date.now() + 30000;
    return cachedModels;
  } catch {
    return cachedModels || [];
  }
}

/**
 * POST a /api/chat con streaming — yielda chunks del body.
 * Ollama stream format: una línea JSON por chunk, terminada en \n. Cada chunk tiene `message.content`
 * (delta incremental) y el último tiene `done: true`.
 *
 * Respeta `signal` para cancelación real del socket.
 */
function* _noop() {} // marker — mantener arrays equivalentes a generators

async function* streamNativeChat(baseUrl, model, messages, signal) {
  const url = new URL('/api/chat', baseUrl);
  const client = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ model, messages, stream: true });

  // Promise que completa con una response stream, o rechaza
  const res = await new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal || undefined,
    }, resolve);
    req.on('error', reject);
    req.setTimeout(OLLAMA_VISION_TIMEOUT_MS, () => { req.destroy(new Error('Timeout Ollama vision (300s)')); });
    req.write(body);
    req.end();
  });

  if (res.statusCode && res.statusCode >= 400) {
    res.resume(); // drenar
    throw new Error(`Ollama respondió ${res.statusCode}`);
  }

  let buf = '';
  for await (const raw of res) {
    if (signal && signal.aborted) {
      try { res.destroy(); } catch {}
      return;
    }
    buf += raw.toString();
    // Ollama emite JSON por línea — partir por \n
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        yield msg;
      } catch {
        // línea malformada — ignorar
      }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf); } catch {}
  }
}
void _noop;

module.exports = {
  name: 'ollama',
  label: 'Ollama (local)',
  defaultModel: 'qwen2.5:7b',
  models: [],

  async fetchModels() {
    const mdls = await fetchAvailableModels();
    this.models = mdls.length ? mdls : ['qwen2.5:7b'];
    return this.models;
  },

  async *chat({
    systemPrompt, history, model, images,
    executeTool: execToolFn, channel, agentRole,
    signal,
  }) {
    const baseUrl = getBaseUrl();
    if (!this.models.length) await this.fetchModels();
    const usedModel = model || this.defaultModel;
    const hasImages = Array.isArray(images) && images.length > 0;

    // Gate: detectar combo no soportado en vez de silenciar
    const toolDefs = tools.toOpenAIFormat({ channel, agentRole });
    const hasTools = toolDefs.length > 0 && !!execToolFn;
    if (hasImages && hasTools) {
      const msg = 'Ollama no soporta imágenes Y tools simultáneamente: la API nativa (visión) no maneja tools, y la API OpenAI-compat no maneja imágenes. Usá un modelo sin visión para tools, o sacá las imágenes para usar tools.';
      yield { type: 'done', fullText: `Error: ${msg}` };
      return;
    }

    // Rama visión (streaming nativo sin tools)
    if (hasImages) {
      const visionModel = isVisionModel(usedModel) ? usedModel
        : this.models.find(m => isVisionModel(m)) || 'minicpm-v:latest';

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      const hist = Array.isArray(history) ? history : [];
      for (const m of hist.slice(0, -1)) {
        messages.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: (typeof m.content === 'string' ? m.content : '') || '',
        });
      }
      const lastMsg = hist[hist.length - 1];
      const lastText = (lastMsg && typeof lastMsg.content === 'string')
        ? lastMsg.content
        : (Array.isArray(lastMsg?.content) ? (lastMsg.content.find(c => c.type === 'text')?.text || '') : '');
      messages.push({
        role: 'user',
        content: lastText,
        images: images.filter(img => img && img.base64).map(img => img.base64),
      });

      let fullText = '';
      try {
        for await (const msg of streamNativeChat(baseUrl, visionModel, messages, signal)) {
          if (signal && signal.aborted) break;
          const content = msg.message?.content;
          if (content) {
            fullText += content;
            yield { type: 'text', text: content };
          }
          if (msg.done) {
            if (msg.prompt_eval_count || msg.eval_count) {
              yield {
                type: 'usage',
                promptTokens: msg.prompt_eval_count || 0,
                completionTokens: msg.eval_count || 0,
              };
            }
            break;
          }
        }
        yield { type: 'done', fullText };
      } catch (err) {
        if (signal && signal.aborted) {
          yield { type: 'done', fullText: fullText || 'Cancelado.' };
          return;
        }
        const em = err.message || String(err);
        if (em.includes('ECONNREFUSED') || em.includes('fetch failed')) {
          yield { type: 'done', fullText: `Error Ollama visión: no se pudo conectar a ${baseUrl}. Verificá que esté corriendo.` };
        } else {
          yield { type: 'done', fullText: `Error Ollama visión: ${em}` };
        }
      }
      return;
    }

    // Rama texto/tools — delegar al helper compartido (streaming + tool loop)
    yield* openaiCompatChat({
      OpenAI,
      clientConfig: { apiKey: 'ollama', baseURL: baseUrl + '/v1' },
      providerLabel: 'Ollama',
      defaultModel: this.defaultModel,
      systemPrompt, history, model: usedModel,
      executeTool: execToolFn, channel, agentRole, signal,
    });
  },

  /**
   * Describe imágenes con minicpm-v (usado como "ojos" para providers sin visión).
   * Redimensiona a max 512px para evitar OOM.
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
    const messages = [{ role: 'user', content: prompt, images: resized }];
    const mdls = await fetchAvailableModels();
    const visionModel = mdls.find(m => isVisionModel(m)) || 'minicpm-v:latest';

    // Usamos una request simple no-stream para describeImage (es síncrono)
    const url = new URL('/api/chat', baseUrl);
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: visionModel, messages, stream: false });
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
      req.setTimeout(OLLAMA_VISION_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Timeout Ollama describeImage')); });
      req.write(body);
      req.end();
    });
  },

  _internal: { isVisionModel, getBaseUrl },
};
