'use strict';

/**
 * JobQuotaService — limita creación y ejecución de jobs (crons, wakeups).
 *
 * Cuotas:
 *   - `maxActivePerUser` (default 10): crons activos simultáneos por usuario.
 *   - `maxInvocationsPerHour` (default 60): invocaciones totales por usuario en ventana 1h.
 *   - `minIntervalSeconds` (default 60): frecuencia mínima; crons < 1 min requieren admin.
 *
 * Overrides por env:
 *   JOB_QUOTA_MAX_ACTIVE_PER_USER, JOB_QUOTA_MAX_INVOCATIONS_PER_HOUR, JOB_QUOTA_MIN_INTERVAL_SECONDS
 *
 * Entradas:
 *   - `canCreate({userId, cronExpr, isAdmin})` — chequea ambas cuotas
 *   - `recordInvocation(userId)` — cuenta en la ventana rolling
 *
 * El estado de invocaciones vive in-memory con window sliding. El conteo de
 * activos se delega al caller (scheduler) vía callback `getActiveCount`.
 */

const DEFAULTS = Object.freeze({
  maxActivePerUser: 10,
  maxInvocationsPerHour: 60,
  minIntervalSeconds: 60,
});

function _intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class JobQuotaService {
  /**
   * @param {object} [opts]
   * @param {function} [opts.getActiveCount] — `(userId) => number` — cantidad de jobs activos
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this._getActive = typeof opts.getActiveCount === 'function' ? opts.getActiveCount : () => 0;
    this._logger = opts.logger || console;
    this._maxActive = _intEnv('JOB_QUOTA_MAX_ACTIVE_PER_USER', DEFAULTS.maxActivePerUser);
    this._maxPerHour = _intEnv('JOB_QUOTA_MAX_INVOCATIONS_PER_HOUR', DEFAULTS.maxInvocationsPerHour);
    this._minIntervalSec = _intEnv('JOB_QUOTA_MIN_INTERVAL_SECONDS', DEFAULTS.minIntervalSeconds);
    /** @type {Map<string, number[]>} userId → timestamps de invocaciones (ms) en última hora */
    this._invocations = new Map();
  }

  /**
   * Intenta autorizar la creación de un cron.
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCreate({ userId, cronExpr, isAdmin = false } = {}) {
    if (!userId) return { allowed: false, reason: 'userId requerido' };

    // 1. Frecuencia mínima (salvo admin)
    if (cronExpr && !isAdmin) {
      const minSec = this._estimateMinInterval(cronExpr);
      if (minSec !== null && minSec < this._minIntervalSec) {
        return {
          allowed: false,
          reason: `frecuencia < ${this._minIntervalSec}s requiere admin (intervalo estimado: ${minSec}s)`,
        };
      }
    }

    // 2. Activos por user
    const active = this._getActive(userId);
    if (active >= this._maxActive) {
      return { allowed: false, reason: `máximo de ${this._maxActive} crons activos por usuario alcanzado` };
    }

    return { allowed: true };
  }

  /**
   * Registra una invocación. Retorna {allowed, reason?} basado en cuota horaria.
   */
  recordInvocation(userId) {
    if (!userId) return { allowed: false, reason: 'userId requerido' };
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const entries = (this._invocations.get(userId) || []).filter(t => t > oneHourAgo);

    if (entries.length >= this._maxPerHour) {
      return {
        allowed: false,
        reason: `cuota horaria alcanzada (${this._maxPerHour} invocaciones/hora)`,
      };
    }

    entries.push(now);
    this._invocations.set(userId, entries);
    return { allowed: true, count: entries.length };
  }

  /** Útil para debug/admin: cuántas invocaciones lleva un user en la última hora. */
  getInvocationsLastHour(userId) {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const entries = (this._invocations.get(userId) || []).filter(t => t > oneHourAgo);
    return entries.length;
  }

  /** Estima intervalo mínimo entre invocaciones desde un cron expr. null si no se puede inferir. */
  _estimateMinInterval(cronExpr) {
    if (!cronExpr || typeof cronExpr !== 'string') return null;
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;
    // Campo 0: segundos (6-field) — si está y es `*` o `*/N`, inferir
    // Campo 0 en 5-field es minutos. Detectamos 6-field si el primer campo es segundos.
    // Heurística: si parts.length === 6 y primer campo parece "segundo-like" (0-59), asumimos 6-field.
    let minuteIdx = 0;
    if (parts.length === 6) {
      const secField = parts[0];
      if (secField === '*' || secField.startsWith('*/')) {
        const step = secField === '*' ? 1 : parseInt(secField.slice(2), 10);
        return Number.isFinite(step) && step > 0 ? step : 1;
      }
      minuteIdx = 1;
    }
    const minuteField = parts[minuteIdx];
    if (minuteField === '*') return 60;
    if (minuteField.startsWith('*/')) {
      const step = parseInt(minuteField.slice(2), 10);
      return Number.isFinite(step) && step > 0 ? step * 60 : 60;
    }
    return null; // no se puede estimar conservadoramente
  }
}

JobQuotaService.DEFAULTS = DEFAULTS;
module.exports = JobQuotaService;
