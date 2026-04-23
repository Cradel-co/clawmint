'use strict';

/**
 * routes/config.js — admin-only. Expose flags y tuning que hoy solo son env vars.
 *
 * Endpoints:
 *   GET  /api/config/compaction       — toggles + tuning de compactors
 *   PUT  /api/config/compaction       — actualizar (persist + runtime reload)
 *   GET  /api/config/model-tiers      — tier config (cheap/balanced/premium × provider)
 *   PUT  /api/config/model-tiers
 *   GET  /api/config/features         — snapshot de flags env importantes (read-only)
 *
 * Los valores persisten en `chat_settings` con keys `config:compaction`,
 * `config:model-tiers`. El runtime reload se hace cada request — no hace
 * falta restart para que tome efecto (los compactors leen la config al
 * momento de decidir).
 */

const express = require('express');

module.exports = function createConfigRouter({ chatSettingsRepo, usersRepo, logger } = {}) {
  if (!chatSettingsRepo) throw new Error('chatSettingsRepo requerido');
  const router = express.Router();
  const log = logger || console;

  function requireAdmin(req, res, next) {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const u = usersRepo?.getById?.(req.user.id);
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
      next();
    } catch (err) { res.status(500).json({ error: err.message }); }
  }

  const DEFAULT_COMPACTION = {
    reactive_enabled: process.env.REACTIVE_COMPACT_ENABLED === 'true',
    micro_enabled:    process.env.MICROCOMPACT_ENABLED === 'true',
    microcompact_every_turns: Number(process.env.MICROCOMPACT_EVERY_TURNS) || 10,
    microcompact_keep_last_k: Number(process.env.MICROCOMPACT_KEEP_LAST_K) || 4,
    autocompact_buffer_tokens: Number(process.env.AUTOCOMPACT_BUFFER_TOKENS) || 13000,
    max_consecutive_compact_failures: Number(process.env.MAX_CONSECUTIVE_COMPACT_FAILURES) || 3,
  };

  // ── Compaction ─────────────────────────────────────────────────────────────
  router.get('/compaction', requireAdmin, (_req, res) => {
    try {
      const saved = chatSettingsRepo.getGlobal?.('config:compaction') || null;
      const current = saved ? { ...DEFAULT_COMPACTION, ...saved } : DEFAULT_COMPACTION;
      res.json({ current, defaults: DEFAULT_COMPACTION, overridden: !!saved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/compaction', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const allowed = Object.keys(DEFAULT_COMPACTION);
      const merged = {};
      for (const k of allowed) if (body[k] !== undefined) merged[k] = body[k];
      chatSettingsRepo.setGlobal('config:compaction', merged);
      res.json({ ok: true, saved: merged });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── Model tiers ────────────────────────────────────────────────────────────
  router.get('/model-tiers', requireAdmin, (_req, res) => {
    try {
      const saved = chatSettingsRepo.getGlobal?.('config:model-tiers') || null;
      // Defaults del env (los resolveModelForTier los lee en runtime)
      const defaults = {
        anthropic: {
          cheap:    process.env.ANTHROPIC_CHEAP_MODEL    || 'claude-haiku-4-5',
          balanced: process.env.ANTHROPIC_BALANCED_MODEL || 'claude-sonnet-4-6',
          premium:  process.env.ANTHROPIC_PREMIUM_MODEL  || 'claude-opus-4-7',
        },
        openai: {
          cheap:    process.env.OPENAI_CHEAP_MODEL    || 'gpt-4o-mini',
          balanced: process.env.OPENAI_BALANCED_MODEL || 'gpt-4o',
          premium:  process.env.OPENAI_PREMIUM_MODEL  || 'gpt-5',
        },
        gemini: {
          cheap:    process.env.GEMINI_CHEAP_MODEL    || 'gemini-2.5-flash-lite',
          balanced: process.env.GEMINI_BALANCED_MODEL || 'gemini-2.5-flash',
          premium:  process.env.GEMINI_PREMIUM_MODEL  || 'gemini-2.5-pro',
        },
        grok: {
          cheap:    process.env.GROK_CHEAP_MODEL    || 'grok-3-mini',
          balanced: process.env.GROK_BALANCED_MODEL || 'grok-3',
          premium:  process.env.GROK_PREMIUM_MODEL  || 'grok-4',
        },
        deepseek: {
          cheap:    process.env.DEEPSEEK_CHEAP_MODEL    || 'deepseek-chat',
          premium:  process.env.DEEPSEEK_PREMIUM_MODEL  || 'deepseek-reasoner',
        },
        ollama: {
          cheap:    process.env.OLLAMA_CHEAP_MODEL    || 'llama3.2:3b',
          balanced: process.env.OLLAMA_BALANCED_MODEL || 'qwen2.5:14b',
          premium:  process.env.OLLAMA_PREMIUM_MODEL  || 'llama3.3:70b',
        },
      };
      const current = saved ? mergeDeep(defaults, saved) : defaults;
      res.json({ current, defaults, overridden: !!saved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/model-tiers', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      chatSettingsRepo.setGlobal('config:model-tiers', body);
      res.json({ ok: true, saved: body });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── Features snapshot (read-only) ──────────────────────────────────────────
  router.get('/features', requireAdmin, (_req, res) => {
    res.json({
      permissions_enabled:           process.env.PERMISSIONS_ENABLED === 'true',
      hooks_enabled:                 process.env.HOOKS_ENABLED === 'true',
      lazy_tools_enabled:            process.env.LAZY_TOOLS_ENABLED === 'true',
      microcompact_enabled:          process.env.MICROCOMPACT_ENABLED === 'true',
      reactive_compact_enabled:      process.env.REACTIVE_COMPACT_ENABLED === 'true',
      worktrees_enabled:             process.env.WORKTREES_ENABLED === 'true',
      workspace_adaptors_enabled:    process.env.WORKSPACE_ADAPTORS_ENABLED === 'true',
      mcp_sse_subscriptions_enabled: process.env.MCP_SSE_SUBSCRIPTIONS_ENABLED === 'true',
      session_sharing_enabled:       process.env.SESSION_SHARING_ENABLED === 'true',
      lsp_enabled:                   process.env.LSP_ENABLED === 'true',
      nodriza_enabled:               process.env.NODRIZA_ENABLED === 'true',
    });
  });

  return router;
};

function mergeDeep(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      out[k] = mergeDeep(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
