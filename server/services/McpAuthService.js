'use strict';

/**
 * McpAuthService — fachada que combina `McpAuthRepository` + `TokenCrypto`.
 *
 * Almacena tokens cifrados y los devuelve descifrados a los consumidores.
 * Emite evento `mcp:auth_required` cuando un MCP externo retorna 401/auth_required
 * durante una llamada, para que el canal muestre la URL al usuario.
 */

class McpAuthService {
  /**
   * @param {object} deps
   * @param {McpAuthRepository} deps.repo
   * @param {TokenCrypto}       deps.crypto
   * @param {object}            [deps.eventBus]
   * @param {object}            [deps.logger]
   */
  constructor({ repo, crypto, eventBus = null, logger = console } = {}) {
    if (!repo || !crypto) throw new Error('McpAuthService: repo + crypto requeridos');
    this._repo = repo;
    this._crypto = crypto;
    this._bus = eventBus;
    this._logger = logger;
    /** @type {Map<string, { exchange: ({ code, state, userId, req }) => Promise<{token, token_type?, expires_at?, mcp_name?}>, buildAuthUrl?: Function }>} */
    this._callbackHandlers = new Map();
    /** @type {Map<string, { mcp_name, user_id, created_at }>} state → metadata */
    this._pendingStates = new Map();
    /** @type {Map<string, { status, mcp_name?, error?, at }>} state → resultado reciente (30s TTL) */
    this._recentResults = new Map();
  }

  /**
   * Registra un callback handler para un provider OAuth externo. Fase 11 parked → cerrado.
   *
   * El handler debe exportar:
   *   - `exchange({ code, state, userId, req })` → `{ token, token_type?, expires_at?, mcp_name? }`
   *   - [opcional] `buildAuthUrl({ userId, state, redirectUri })` → URL
   *
   * Ejemplo (stub): `registerCallbackHandler('google', googleHandler)`.
   * El callback HTTP `GET /api/mcp-auth/callback/:provider?code=X&state=Y` delega a este handler.
   */
  registerCallbackHandler(provider, handler) {
    if (!provider || !handler || typeof handler.exchange !== 'function') {
      throw new Error('registerCallbackHandler: provider + handler.exchange requeridos');
    }
    this._callbackHandlers.set(String(provider).toLowerCase(), handler);
  }

  getCallbackHandler(provider) {
    return this._callbackHandlers.get(String(provider || '').toLowerCase()) || null;
  }

  listCallbackHandlers() {
    return Array.from(this._callbackHandlers.keys());
  }

  /**
   * Reserva un `state` opaco para el flujo OAuth. El state se valida cuando el
   * provider redirige al callback. Expira a los 10 minutos.
   */
  createAuthState({ mcp_name, user_id, ttlMs = 600_000 } = {}) {
    if (!mcp_name) throw new Error('mcp_name requerido');
    const state = require('crypto').randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this._pendingStates.set(state, { mcp_name, user_id: user_id || null, created_at: Date.now(), expires_at: expiresAt });
    // Cleanup de states expirados
    this._gcStates();
    return { state, expires_at: expiresAt };
  }

  /** Consume un state (1 uso); retorna metadata o null si inválido/expirado. */
  consumeAuthState(state) {
    if (!state) return null;
    const record = this._pendingStates.get(state);
    if (!record) return null;
    this._pendingStates.delete(state);
    if (record.expires_at < Date.now()) return null;
    return record;
  }

  _gcStates() {
    const now = Date.now();
    for (const [state, rec] of this._pendingStates) {
      if (rec.expires_at < now) this._pendingStates.delete(state);
    }
  }

  /**
   * Completa un callback OAuth: valida state, invoca handler.exchange, persiste token.
   * Usado por el route HTTP `/api/mcp-auth/callback/:provider`.
   */
  async handleCallback({ provider, code, state, req = null }) {
    if (!provider) throw new Error('provider requerido');
    if (!code) throw new Error('code requerido');
    if (!state) throw new Error('state requerido');
    const handler = this.getCallbackHandler(provider);
    if (!handler) throw new Error(`No hay callback handler registrado para provider "${provider}"`);
    const stateRec = this.consumeAuthState(state);
    if (!stateRec) {
      this._recordResult(state, { status: 'error', error: 'state inválido o expirado' });
      throw new Error('state inválido o expirado');
    }

    try {
      const result = await handler.exchange({ code, state, userId: stateRec.user_id, req });
      if (!result || !result.token) throw new Error(`Handler ${provider} no retornó token`);

      const mcp_name = result.mcp_name || stateRec.mcp_name;
      this.saveToken({
        mcp_name,
        user_id: stateRec.user_id,
        token: result.token,
        token_type: result.token_type || 'bearer',
        expires_at: result.expires_at || null,
      });
      this._recordResult(state, { status: 'completed', mcp_name, user_id: stateRec.user_id });
      return { ok: true, mcp_name, user_id: stateRec.user_id };
    } catch (err) {
      this._recordResult(state, { status: 'error', error: err.message });
      throw err;
    }
  }

  /** Registra resultado reciente de un state para que el client pueda pollear. TTL 30s. */
  _recordResult(state, payload) {
    this._recentResults.set(state, { ...payload, at: Date.now() });
    // Cleanup oportunista
    const cutoff = Date.now() - 30_000;
    for (const [k, v] of this._recentResults) {
      if (v.at < cutoff) this._recentResults.delete(k);
    }
  }

  /**
   * Polling del client para saber si el callback completó. Retorna:
   *   - { status: 'pending' }    — state existe como pending, aún no llegó callback
   *   - { status: 'completed', mcp_name } — callback OK
   *   - { status: 'error', error } — callback falló
   *   - { status: 'unknown' }     — state nunca existió o expiró sin callback
   */
  getAuthStatus(state) {
    if (!state) return { status: 'unknown' };
    const recent = this._recentResults.get(state);
    if (recent) {
      const { at, ...rest } = recent;
      return rest;
    }
    const pending = this._pendingStates.get(state);
    if (pending) {
      if (pending.expires_at < Date.now()) return { status: 'unknown' };
      return { status: 'pending', mcp_name: pending.mcp_name };
    }
    return { status: 'unknown' };
  }

  /**
   * Persiste un token (se cifra antes de guardar).
   */
  saveToken({ mcp_name, user_id, token, token_type = 'bearer', expires_at = null }) {
    if (!token) throw new Error('token requerido');
    const encrypted = this._crypto.encrypt(String(token));
    const row = this._repo.upsert({ mcp_name, user_id, encrypted_token: encrypted, token_type, expires_at });
    this._emit('mcp:auth_completed', { mcp_name, user_id, timestamp: Date.now() });
    return row;
  }

  /**
   * Obtiene un token descifrado. Retorna null si no existe.
   */
  getToken(mcp_name, user_id) {
    const row = this._repo.findByMcpUser(mcp_name, user_id);
    if (!row) return null;
    try {
      const token = this._crypto.decrypt(row.encrypted_token);
      return { token, token_type: row.token_type, expires_at: row.expires_at };
    } catch (err) {
      this._logger.warn && this._logger.warn(`[McpAuthService] decrypt falló para mcp=${mcp_name} user=${user_id}: ${err.message}`);
      return null;
    }
  }

  hasToken(mcp_name, user_id) {
    return !!this._repo.findByMcpUser(mcp_name, user_id);
  }

  removeToken(mcp_name, user_id) {
    return this._repo.removeByMcpUser(mcp_name, user_id);
  }

  /**
   * Emite evento `mcp:auth_required` para que el canal muestre URL al usuario.
   */
  requireAuth({ mcp_name, user_id, auth_url, chatId }) {
    this._emit('mcp:auth_required', {
      mcp_name, user_id: user_id || null, auth_url, chatId: chatId || null, timestamp: Date.now(),
    });
  }

  listByUser(user_id) {
    return this._repo.listByUser(user_id).map(r => ({
      mcp_name: r.mcp_name,
      token_type: r.token_type,
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
  }

  _emit(event, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(event, payload); } catch { /* no-op */ }
    }
  }
}

module.exports = McpAuthService;
