'use strict';
const express = require('express');
const crypto  = require('crypto');

const CLI_PROVIDERS = new Set(['claude-code', 'gemini-cli']);

function parseModel(modelId, providerConfig) {
  const cfg = providerConfig.getConfig();
  const defaultProvider = cfg.default || 'anthropic';

  if (!modelId || modelId === 'default') return { provider: defaultProvider, model: null };

  const slash = modelId.indexOf('/');
  if (slash === -1) return { provider: modelId, model: null };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => b.text || '').join('');
  return String(content || '');
}

const DEFAULT_COMPAT_MODEL = 'anthropic/claude-haiku-4-5-20251001';

module.exports = function createOpenAICompatRouter({ providersModule, providerConfig, systemConfigRepo, logger }) {
  const router = express.Router();

  function getStaticApiKey() {
    if (process.env.OPENAI_COMPAT_API_KEY) return process.env.OPENAI_COMPAT_API_KEY;
    if (systemConfigRepo) return systemConfigRepo.get('openai_compat_api_key');
    return null;
  }

  function getCompatDefaultModel() {
    if (process.env.OPENAI_COMPAT_DEFAULT_MODEL) return process.env.OPENAI_COMPAT_DEFAULT_MODEL;
    if (systemConfigRepo) {
      const stored = systemConfigRepo.get('openai_compat_default_model');
      if (stored) return stored;
    }
    return DEFAULT_COMPAT_MODEL;
  }

  function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({
        error: { message: 'Falta el header Authorization: Bearer <api-key>', type: 'invalid_request_error', code: 'missing_api_key' },
      });
    }

    const apiKey = getStaticApiKey();
    if (!apiKey) {
      return res.status(503).json({
        error: { message: 'API key no configurada en el servidor. Configurá OPENAI_COMPAT_API_KEY o usá el panel admin.', type: 'server_error', code: 'api_key_not_set' },
      });
    }

    if (token !== apiKey) {
      return res.status(401).json({
        error: { message: 'API key inválida', type: 'authentication_error', code: 'invalid_api_key' },
      });
    }

    next();
  }

  // GET /v1/models
  router.get('/models', authMiddleware, async (_req, res) => {
    try {
      const providers = await providersModule.listAsync();
      const created   = Math.floor(Date.now() / 1000);
      const data      = [{ id: 'default', object: 'model', created, owned_by: 'clawmint' }];

      for (const p of providers) {
        if (CLI_PROVIDERS.has(p.name)) continue;
        const provObj = providersModule.get(p.name);
        if (typeof provObj?.chat !== 'function') continue;

        data.push({ id: p.name, object: 'model', created, owned_by: 'clawmint' });
        for (const m of (p.models || [])) {
          data.push({ id: `${p.name}/${m}`, object: 'model', created, owned_by: 'clawmint' });
        }
      }

      res.json({ object: 'list', data });
    } catch (err) {
      logger?.error?.('[openai-compat] GET /models error:', err.message);
      res.status(500).json({ error: { message: err.message, type: 'server_error' } });
    }
  });

  // POST /v1/chat/completions
  router.post('/chat/completions', authMiddleware, async (req, res) => {
    const { messages, model: modelId, stream = false, max_tokens } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages es requerido y debe ser un array no vacío', type: 'invalid_request_error' } });
    }

    const resolvedModelId = modelId || getCompatDefaultModel();
    const { provider: providerName, model: modelName } = parseModel(resolvedModelId, providerConfig);

    if (CLI_PROVIDERS.has(providerName)) {
      return res.status(400).json({
        error: { message: `El provider '${providerName}' es CLI-only y no es compatible con este endpoint. Usá: anthropic, openai, ollama, gemini, grok, deepseek.`, type: 'invalid_request_error' },
      });
    }

    const provObj = providersModule.get(providerName);
    if (!provObj || typeof provObj.chat !== 'function') {
      return res.status(400).json({ error: { message: `Provider '${providerName}' no encontrado o no soporta chat`, type: 'invalid_request_error' } });
    }

    const apiKey  = providerConfig.getApiKey(providerName);
    const cfg     = providerConfig.getConfig();
    const useModel = modelName || cfg.providers?.[providerName]?.model || provObj.defaultModel;

    const systemMsg    = messages.find(m => m.role === 'system');
    const systemPrompt = systemMsg ? normalizeContent(systemMsg.content) : '';
    const history      = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: normalizeContent(m.content) }));

    if (history.length === 0 || !history.some(m => m.role === 'user')) {
      return res.status(400).json({ error: { message: 'Se requiere al menos un mensaje con role "user"', type: 'invalid_request_error' } });
    }

    // Noop executor — impide que los providers usen el executor global de MCP (bash, read_file, etc.)
    // cuando el modelo intenta llamar tools. Las tools del servidor no están disponibles en este modo.
    const noopExecuteTool = async (toolName) => ({
      error: `Tool '${toolName}' no disponible en modo API compatible. Respondé directamente sin usar herramientas.`,
      isError: true,
    });

    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created      = Math.floor(Date.now() / 1000);
    const abortCtrl    = new AbortController();
    req.on('close', () => abortCtrl.abort());

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendChunk = (delta, finishReason = null) => {
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: resolvedModelId,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      sendChunk({ role: 'assistant', content: '' });

      let accumulated = '';
      let usage       = null;

      try {
        const gen = provObj.chat({ systemPrompt, history, apiKey, model: useModel, maxTokens: max_tokens || undefined, signal: abortCtrl.signal, executeTool: noopExecuteTool });

        for await (const event of gen) {
          if (event.type === 'text') {
            const delta = event.text.slice(accumulated.length);
            accumulated = event.text;
            if (delta) sendChunk({ content: delta });
          } else if (event.type === 'done') {
            const full  = event.fullText || '';
            const delta = full.slice(accumulated.length);
            if (delta) { sendChunk({ content: delta }); accumulated = full; }
          } else if (event.type === 'usage') {
            usage = event;
          }
        }

        const finishChunk = {
          id: completionId, object: 'chat.completion.chunk', created,
          model: resolvedModelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        if (usage) finishChunk.usage = { prompt_tokens: usage.promptTokens || 0, completion_tokens: usage.completionTokens || 0, total_tokens: (usage.promptTokens || 0) + (usage.completionTokens || 0) };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        if (err.name !== 'AbortError') {
          logger?.error?.('[openai-compat] stream error:', err.message);
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }

    } else {
      let accumulated = '';
      let fullText    = '';
      let usage       = null;

      try {
        const gen = provObj.chat({ systemPrompt, history, apiKey, model: useModel, maxTokens: max_tokens || undefined, signal: abortCtrl.signal, executeTool: noopExecuteTool });

        for await (const event of gen) {
          if (event.type === 'text')    accumulated = event.text;
          else if (event.type === 'done')  fullText = event.fullText || accumulated;
          else if (event.type === 'usage') usage    = event;
        }

        if (!fullText) fullText = accumulated;

        const response = {
          id: completionId,
          object: 'chat.completion',
          created,
          model: resolvedModelId,
          choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
        };
        if (usage) response.usage = { prompt_tokens: usage.promptTokens || 0, completion_tokens: usage.completionTokens || 0, total_tokens: (usage.promptTokens || 0) + (usage.completionTokens || 0) };
        res.json(response);
      } catch (err) {
        logger?.error?.('[openai-compat] non-stream error:', err.message);
        res.status(500).json({ error: { message: err.message, type: 'server_error', code: 'server_error' } });
      }
    }
  });

  return router;
};
