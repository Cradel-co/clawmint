'use strict';

/**
 * mcp/tools/agenticParked.js — schedule_wakeup + ask_user_question.
 *
 * Fase 9 cierre (post Fase 4 extra): ambas tools ya están implementadas
 * usando ResumableSessionsRepository (schedule_wakeup) y
 * LoopRunner.suspend() (ask_user_question).
 *
 * El nombre del archivo se mantiene "agenticParked.js" por retrocompat con
 * imports existentes; las tools ya NO están parked.
 */

const SCHEDULE_WAKEUP = {
  name: 'schedule_wakeup',
  description: 'Termina el turn actual y programa que el chat se reactive en N segundos con un prompt de resume. Útil para "revisá esto en 5 minutos" o "recordame mañana a las 9". El resumePrompt se inyecta como mensaje del usuario al vencer el delay.',
  params: {
    delaySeconds: 'number',
    reason:       'string',
    resumePrompt: '?string',
  },
  async execute(args = {}, ctx = {}) {
    const { delaySeconds, reason, resumePrompt } = args;
    if (!delaySeconds || typeof delaySeconds !== 'number' || delaySeconds <= 0) {
      return 'Error: delaySeconds debe ser un número positivo en segundos';
    }
    if (delaySeconds > 30 * 24 * 3600) {
      return 'Error: delaySeconds máximo 30 días';
    }
    if (!reason || typeof reason !== 'string') {
      return 'Error: reason requerido (explicación de por qué schedule)';
    }

    const repo = ctx.resumableSessionsRepo;
    if (!repo) return 'Error: ResumableSessionsRepository no disponible en ctx';
    if (!ctx.chatId) return 'Error: chatId requerido en ctx (no se puede programar un wakeup sin chat asociado)';

    const history = Array.isArray(ctx.history) ? ctx.history.slice(-50) : [];
    const contextPayload = {
      botKey: ctx.botKey || null,
    };
    const finalPrompt = resumePrompt || `[wakeup programado] ${reason}`;
    const trigger_at = Date.now() + Math.floor(delaySeconds * 1000);

    try {
      const record = repo.create({
        chat_id:       String(ctx.chatId),
        agent_key:     ctx.agentKey || null,
        provider:      ctx.provider || null,
        model:         ctx.model || null,
        channel:       ctx.channel || null,
        history,
        context:       contextPayload,
        resume_prompt: finalPrompt,
        trigger_at,
      });
      const when = new Date(trigger_at).toISOString();
      return `schedule_wakeup programado (id=${record.id}) — se disparará en ${delaySeconds}s (${when}) con prompt: ${finalPrompt.slice(0, 100)}`;
    } catch (err) {
      return `Error programando wakeup: ${err.message}`;
    }
  },
};

const ASK_USER_QUESTION = {
  name: 'ask_user_question',
  description: 'Hace una pregunta al usuario y pausa el loop hasta recibir respuesta. Usala cuando necesitás confirmación, elección entre opciones, o clarificación antes de proceder. El próximo mensaje del usuario en ese chat se interpreta como respuesta (no como un turn nuevo).',
  params: {
    question:       'string',
    options:        '?array',
    timeoutSeconds: '?number',
  },
  async execute(args = {}, ctx = {}) {
    const { question, options, timeoutSeconds } = args;
    if (!question || typeof question !== 'string') return 'Error: question requerido';
    if (!ctx.chatId) return 'Error: chatId requerido en ctx';

    const loopRunner = ctx.loopRunner || (ctx._convSvc && ctx._convSvc._loopRunner);
    if (!loopRunner || typeof loopRunner.suspend !== 'function') {
      return 'Error: LoopRunner con soporte suspend() no disponible';
    }

    const timeoutMs = Math.max(30_000, Math.min(30 * 60_000, (Number(timeoutSeconds) || 600) * 1000));

    try {
      const answer = await loopRunner.suspend({
        chatId:   String(ctx.chatId),
        question,
        options:  Array.isArray(options) ? options : null,
        timeoutMs,
      });
      return `Respuesta del usuario: ${answer}`;
    } catch (err) {
      if (/timeout/i.test(err.message)) {
        return `Sin respuesta del usuario dentro de ${Math.floor(timeoutMs/1000)}s (timeout). Continuá con el flujo sin esa info.`;
      }
      if (/superseded|cancelled/i.test(err.message)) {
        return `Pregunta cancelada: ${err.message}. Continuá con el flujo.`;
      }
      return `Error en ask_user_question: ${err.message}`;
    }
  },
};

module.exports = [SCHEDULE_WAKEUP, ASK_USER_QUESTION];
