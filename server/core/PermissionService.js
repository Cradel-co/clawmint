'use strict';

/**
 * PermissionService — fachada sobre PermissionRepository.
 *
 * Expone una API mínima: resolve(toolName, ctx) → 'auto'|'ask'|'deny'.
 * - Flag `PERMISSIONS_ENABLED=false` (default) → siempre retorna 'auto' (bypass).
 * - Sin reglas que matcheen → default 'auto' (retrocompat).
 * - Con match → la action de la regla más específica en el scope más prioritario.
 *
 * Resuelve `role` del usuario consultando `usersRepo` cuando el contexto no lo trae.
 *
 * No conoce de Express, LoopRunner, ni providers. Es consumido por:
 *  - `services/ConversationService` (permission gate antes del mode wrapper)
 *  - `routes/permissions.js` (CRUD admin)
 */

const { resolveUserId } = require('../mcp/tools/user-sandbox');

class PermissionService {
  /**
   * @param {object} deps
   * @param {PermissionRepository} deps.repo
   * @param {object} [deps.usersRepo]     — para resolver role
   * @param {boolean} [deps.enabled]      — si se omite, lee PERMISSIONS_ENABLED env
   * @param {object} [deps.logger]
   */
  constructor({ repo, usersRepo = null, enabled, logger = console } = {}) {
    if (!repo) throw new Error('PermissionService: repo requerido');
    this._repo = repo;
    this._usersRepo = usersRepo;
    this._logger = logger;
    this._enabled = typeof enabled === 'boolean'
      ? enabled
      : process.env.PERMISSIONS_ENABLED === 'true';

    // A3 — grants efímeros por chat: patrones de tools con expiresAt timestamp.
    // Usados por skills que declaran allowedTools en frontmatter para bajar 'ask' → 'auto'
    // durante la ventana del turn (default 5 min).
    /** @type {Map<string, Array<{pattern: string, expiresAt: number}>>} */
    this._tempGrants = new Map();
  }

  get enabled() { return this._enabled; }

  /**
   * Resuelve la acción para un tool en un contexto.
   * @param {string} toolName
   * @param {object} ctx
   * @returns {'auto'|'ask'|'deny'}
   */
  resolve(toolName, ctx = {}) {
    if (!this._enabled) return 'auto';
    if (!toolName) return 'auto';

    const resolvedCtx = {
      chatId:  ctx.chatId || null,
      userId:  ctx.userId || resolveUserId(ctx) || null,
      role:    ctx.role || this._resolveRole(ctx),
      channel: ctx.channel || null,
    };

    const match = this._repo.resolve(toolName, resolvedCtx);
    const baseAction = match ? match.action : 'auto';

    // A3 — si la regla pide 'ask', revisar grant efímero del chat que podría bajarla a 'auto'.
    // No aplica a 'deny' (seguridad nunca se baja con grant) ni a 'auto' (ya es permisivo).
    if (baseAction === 'ask' && resolvedCtx.chatId && this._hasTempGrant(resolvedCtx.chatId, toolName)) {
      return 'auto';
    }
    return baseAction;
  }

  /**
   * A3 — Otorga permiso efímero para que tools matcheando patrones se resuelvan como 'auto'
   * durante la ventana indicada. Usado por skill_invoke cuando el skill declara allowedTools.
   *
   * Patrones soportados: exacto (`bash`) o prefijo glob (`files_*`, `memory_*`).
   *
   * @param {string} chatId
   * @param {Array<string>} patterns
   * @param {number} [ttlMs=300000]  default 5 minutos
   */
  grantTemporary(chatId, patterns, ttlMs = 5 * 60 * 1000) {
    if (!chatId) return;
    if (!Array.isArray(patterns) || !patterns.length) return;
    const expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 0);
    const existing = this._tempGrants.get(String(chatId)) || [];
    const merged = existing.filter(g => g.expiresAt > Date.now());
    for (const p of patterns) {
      const pat = String(p).trim();
      if (!pat) continue;
      // Reemplaza si ya existe un grant del mismo patrón (extiende TTL)
      const idx = merged.findIndex(g => g.pattern === pat);
      if (idx >= 0) merged[idx].expiresAt = expiresAt;
      else merged.push({ pattern: pat, expiresAt });
    }
    this._tempGrants.set(String(chatId), merged);
  }

  /** Limpia grants de un chat. Útil al terminar el turno o en tests. */
  clearTemporaryGrants(chatId) {
    if (!chatId) return;
    this._tempGrants.delete(String(chatId));
  }

  _hasTempGrant(chatId, toolName) {
    const grants = this._tempGrants.get(String(chatId));
    if (!grants || !grants.length) return false;
    const now = Date.now();
    // Compacta y checkea
    const live = grants.filter(g => g.expiresAt > now);
    if (live.length !== grants.length) this._tempGrants.set(String(chatId), live);
    for (const g of live) {
      if (_matchesPattern(toolName, g.pattern)) return true;
    }
    return false;
  }

  _resolveRole(ctx) {
    if (!this._usersRepo) return null;
    const userId = ctx.userId || resolveUserId(ctx);
    if (!userId) return null;
    try {
      const user = this._usersRepo.getById(userId);
      return user ? user.role || 'user' : null;
    } catch { return null; }
  }

  // ── API CRUD para routes admin ──────────────────────────────────────────

  list(filter)      { return this._repo.list(filter); }
  create(fields)    { return this._repo.create(fields); }
  remove(id)        { return this._repo.remove(id); }
  getById(id)       { return this._repo.getById(id); }
  count()           { return this._repo.count(); }
}

// Glob-lite: soporta '*' como wildcard al final del patrón.
function _matchesPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern === name) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

PermissionService._internal = { _matchesPattern };
module.exports = PermissionService;
