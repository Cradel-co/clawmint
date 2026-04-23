'use strict';

/**
 * routes/tools-admin.js — admin-only. Lista completa de tools registradas.
 *
 * Endpoints:
 *   GET  /api/tools/all               — snapshot completo (core + MCP externos)
 *   GET  /api/tools/disabled          — tools desactivadas por MCP_DISABLED_TOOLS env
 *   POST /api/tools/toggle            — toggle on/off (persist via chat_settings)
 */

const express = require('express');

module.exports = function createToolsAdminRouter({ chatSettingsRepo, usersRepo, logger } = {}) {
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

  router.get('/all', requireAdmin, (_req, res) => {
    try {
      const toolsIndex = require('../mcp/tools');
      const allTools = typeof toolsIndex.all === 'function'
        ? toolsIndex.all({ agentRole: 'coordinator' })
        : (toolsIndex.ALL_TOOLS || []);
      let getExternalToolDefs;
      try { ({ getExternalToolDefs } = require('../mcp-client-pool')); } catch { /* pool no inicializado */ }

      const envDisabled = new Set(
        (process.env.MCP_DISABLED_TOOLS || '')
          .split(',').map(s => s.trim()).filter(Boolean)
      );
      const userDisabled = new Set(chatSettingsRepo.getGlobal?.('config:tools-disabled') || []);

      const core = allTools.map(t => ({
        name: t.name,
        description: t.description || '',
        category: t.category || categorize(t.name),
        adminOnly: !!t.adminOnly,
        coordinatorOnly: !!t.coordinatorOnly,
        channel: t.channel || null,
        source: 'core',
        disabled_env:  envDisabled.has(t.name),
        disabled_user: userDisabled.has(t.name),
      }));

      // MCP externos
      let external = [];
      try {
        const defs = typeof getExternalToolDefs === 'function' ? getExternalToolDefs() : [];
        external = defs.map(d => ({
          name: d.name,
          description: d.description || '',
          category: 'mcp-external',
          source: 'mcp',
          disabled_env:  envDisabled.has(d.name),
          disabled_user: userDisabled.has(d.name),
        }));
      } catch { /* mcp pool no inicializado */ }

      res.json({
        tools: [...core, ...external],
        env_disabled: Array.from(envDisabled),
        user_disabled: Array.from(userDisabled),
      });
    } catch (err) {
      log.error && log.error('[tools-admin]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/toggle', requireAdmin, (req, res) => {
    try {
      const { name, disabled } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name requerido' });
      const current = new Set(chatSettingsRepo.getGlobal?.('config:tools-disabled') || []);
      if (disabled) current.add(name); else current.delete(name);
      chatSettingsRepo.setGlobal('config:tools-disabled', Array.from(current));
      res.json({ ok: true, name, disabled: !!disabled, user_disabled: Array.from(current) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
};

function categorize(name) {
  if (!name) return 'other';
  if (name.startsWith('pty_'))      return 'pty';
  if (name === 'bash' || name === 'git') return 'shell';
  if (name.startsWith('read_') || name.startsWith('write_') || name.startsWith('edit_') || name.startsWith('list_') || name.startsWith('search_') || name === 'glob' || name === 'grep') return 'files';
  if (name.startsWith('memory_'))   return 'memory';
  if (name.startsWith('task_'))     return 'tasks';
  if (name.startsWith('telegram_')) return 'telegram';
  if (name.startsWith('webchat_'))  return 'webchat';
  if (name.startsWith('contact_'))  return 'contacts';
  if (name.startsWith('web'))       return 'web';
  if (name.startsWith('cron_') || name === 'schedule_action' || name.startsWith('list_scheduled') || name.startsWith('cancel_scheduled') || name.startsWith('update_scheduled')) return 'scheduler';
  if (name === 'schedule_wakeup' || name === 'ask_user_question' || name === 'push_notification') return 'agentic';
  if (name.startsWith('lsp_'))      return 'lsp';
  if (name.startsWith('mcp_'))      return 'mcp';
  if (name === 'delegate_task' || name === 'ask_agent' || name === 'list_agents' || name === 'list_subagent_types') return 'orchestration';
  if (name === 'tool_search' || name === 'tool_load') return 'catalog';
  if (name.startsWith('critter')) return 'critter';
  if (name.startsWith('enter_plan_mode') || name.startsWith('exit_plan_mode')) return 'plan';
  if (name === 'notebook_edit')   return 'notebook';
  if (name === 'monitor_process') return 'monitor';
  if (name === 'workspace_status') return 'workspace';
  if (name.startsWith('skill_'))  return 'skills';
  if (name.startsWith('user_'))   return 'users';
  return 'other';
}
