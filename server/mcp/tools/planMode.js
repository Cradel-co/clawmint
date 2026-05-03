'use strict';

/**
 * mcp/tools/planMode.js — tools para entrar/salir de plan mode granular.
 *
 * Expone:
 *   - `enter_plan_mode(reason?)` — el modelo entra en modo read-only para
 *     esta sub-tarea. El LoopRunner/ConversationService debe consultar
 *     `planModeService.isActive(chatId)` al construir execToolFn.
 *   - `exit_plan_mode()` — vuelve al modo normal.
 *
 * Auto-exit: si el modelo no llama `exit_plan_mode` en 5 min, el servicio
 * lo saca automáticamente y emite evento `plan_mode:timeout`.
 */

const ENTER = {
  name: 'enter_plan_mode',
  description: 'Entra en modo plan: las tools quedarán en modo read-only simulado hasta que llames exit_plan_mode. Auto-exit tras 5 min. Útil para analizar/diseñar sin efectos secundarios dentro de un turn.',
  params: { reason: '?string' },
  execute(args = {}, ctx = {}) {
    if (!ctx.planModeService) return 'Error: planModeService no disponible';
    if (!ctx.chatId) return 'Error: chatId no disponible en ctx';
    try {
      const r = ctx.planModeService.enter(ctx.chatId, args.reason || null);
      const mins = Math.round((r.expiresAt - r.enteredAt) / 60_000);
      return `Plan mode activo para chat ${ctx.chatId}. Auto-exit en ~${mins} min si no llamás exit_plan_mode.`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

const EXIT = {
  name: 'exit_plan_mode',
  description: 'Sale de plan mode. Las tools vuelven a ejecutarse normalmente.',
  params: {},
  execute(_args = {}, ctx = {}) {
    if (!ctx.planModeService) return 'Error: planModeService no disponible';
    if (!ctx.chatId) return 'Error: chatId no disponible';
    const wasActive = ctx.planModeService.exit(ctx.chatId);
    return wasActive ? 'Plan mode desactivado.' : 'No estaba en plan mode.';
  },
};

module.exports = [ENTER, EXIT];
