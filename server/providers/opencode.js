'use strict';

/**
 * Provider: OpenCode Zen / OpenCode Go
 * Gateway de modelos curados por OpenCode, API compatible con OpenAI (/chat/completions).
 *   - zen: https://opencode.ai/zen/v1        (pay-as-you-go)
 *   - go:  https://opencode.ai/zen/go/v1     (suscripción $10/mes)
 * Requisitos de Go: User-Agent propio + x-opencode-session estable por conversación.
 */

const OpenAI = require('openai');
const tools  = require('../tools');

const MODES = {
  zen: { baseURL: 'https://opencode.ai/zen/v1',      modelsURL: 'https://opencode.ai/zen/v1/models' },
  go:  { baseURL: 'https://opencode.ai/zen/go/v1',   modelsURL: 'https://opencode.ai/zen/go/v1/models' },
};

// Modelos /chat/completions no-deprecados (fallback si falla GET /models)
const FALLBACK_MODELS = {
  zen: ['glm-5.2', 'glm-5.1', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash', 'minimax-m2.7', 'big-pickle', 'mimo-v2.5-free', 'nemotron-3-ultra-free'],
  go:  ['glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.1', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash', 'minimax-m3', 'minimax-m2.7', 'longcat-2.0'],
};

// Prefijos de modelos que usan otros endpoints (/messages, /responses, /models/<id>)
const EXCLUDED_PREFIXES = ['claude', 'gemini', 'gpt', 'grok', 'muse', 'qwen'];

const MODELS_CACHE_TTL = 30000;

function isChatCompletionsModel(id) {
  return !EXCLUDED_PREFIXES.some(p => id === p || id.startsWith(p));
}

async function fetchAvailableModels(modelsURL) {
  const res = await fetch(modelsURL, {
    headers: { 'User-Agent': 'clawmint/1.4.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .map(m => m.id)
    .filter(Boolean)
    .filter(isChatCompletionsModel);
}

function createOpencodeProvider(mode) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`Modo OpenCode inválido: ${mode}`);

  let cachedModels = null;
  let cacheExpiry = 0;

  return {
    name: mode === 'zen' ? 'zen' : 'go',
    label: mode === 'zen' ? 'OpenCode Zen' : 'OpenCode Go',
    defaultModel: 'glm-5.2',
    models: [],

    async fetchModels() {
      if (cachedModels && Date.now() < cacheExpiry) {
        this.models = cachedModels;
        return this.models;
      }
      try {
        const models = await fetchAvailableModels(cfg.modelsURL);
        if (models.length) {
          cachedModels = models;
          cacheExpiry = Date.now() + MODELS_CACHE_TTL;
        }
      } catch {
        // fallback a cache viejo o lista estática
      }
      this.models = cachedModels || FALLBACK_MODELS[mode];
      return this.models;
    },

    async *chat({ systemPrompt, history, apiKey, model, chatId, executeTool: execToolFn, channel, agentRole }) {
      if (!apiKey) {
        yield { type: 'done', fullText: `Error: API key de ${this.label} no configurada. Configurala en el panel ⚙️.` };
        return;
      }

      if (!this.models.length) await this.fetchModels();
      const usedModel = model || this.defaultModel;

      const client = new OpenAI({
        apiKey,
        baseURL: cfg.baseURL,
        timeout: 60000,
        defaultHeaders: {
          'User-Agent': 'clawmint/1.4.0',
          ...(chatId ? { 'x-opencode-session': String(chatId) } : {}),
        },
      });

      const toolDefs = tools.toOpenAIFormat({ channel, agentRole });
      const execTool = execToolFn || tools.executeTool;

      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      for (const m of history) {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
      }

      let fullText = '';
      let totalPromptTokens = 0, totalCompletionTokens = 0;

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
          yield { type: 'done', fullText: `Error ${this.label}: ${err.message}` };
          return;
        }

        const u = response.usage;
        if (u) {
          totalPromptTokens     += u.prompt_tokens || 0;
          totalCompletionTokens += u.completion_tokens || 0;
        }

        const choice = response.choices?.[0];
        const msg = choice?.message;

        if (!msg) {
          yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
          yield { type: 'done', fullText };
          return;
        }

        if (msg.content) {
          fullText += msg.content;
          yield { type: 'text', text: msg.content };
        }

        const toolCalls = msg.tool_calls || [];

        if (toolCalls.length === 0 || choice.finish_reason === 'stop') {
          yield { type: 'usage', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
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
    },
  };
}

module.exports = { createOpencodeProvider };
