'use strict';

/**
 * HookLoader — traduce rows del HookRepository a registros en HookRegistry.
 *
 * - `loadAll()` al boot: carga todos los hooks enabled desde el repo.
 * - `registerHook(row)` / `unregisterHook(id)` para sync cuando cambian via API.
 * - `reload()` para hot-reload (endpoint `POST /api/hooks/reload`).
 *
 * Mantiene mapa `dbId → registryId` para poder desregistrar tras update.
 */

class HookLoader {
  constructor({ registry, repo, logger = console, eventBus = null }) {
    if (!registry) throw new Error('registry requerido');
    if (!repo) throw new Error('repo requerido');
    this._registry = registry;
    this._repo = repo;
    this._logger = logger;
    this._bus = eventBus;
    this._dbToRegistryId = new Map();
  }

  async loadAll() {
    this._dbToRegistryId.clear();
    const rows = this._repo.list({ enabled: true });
    for (const row of rows) this.registerHook(row);
    this._logger.info && this._logger.info(`[HookLoader] ${rows.length} hooks cargados`);
    return rows.length;
  }

  registerHook(row) {
    try {
      const registryId = this._registry.register({
        id:          `db-${row.id}`,
        event:       row.event,
        handlerType: row.handler_type,
        handlerRef:  row.handler_ref,
        scopeType:   row.scope_type,
        scopeId:     row.scope_id,
        priority:    row.priority,
        timeoutMs:   row.timeout_ms,
        enabled:     row.enabled,
      });
      this._dbToRegistryId.set(row.id, registryId);
    } catch (err) {
      this._logger.warn && this._logger.warn(`[HookLoader] no se pudo registrar hook #${row.id}: ${err.message}`);
    }
  }

  unregisterHook(dbId) {
    const registryId = this._dbToRegistryId.get(dbId);
    if (!registryId) return false;
    const removed = this._registry.unregister(registryId);
    this._dbToRegistryId.delete(dbId);
    return removed;
  }

  async reload() {
    // Desregistrar todos los que tenemos tracked
    for (const registryId of this._dbToRegistryId.values()) {
      try { this._registry.unregister(registryId); } catch {}
    }
    const count = await this.loadAll();
    if (this._bus && this._bus.emit) {
      try { this._bus.emit('hook:reloaded', { count }); } catch {}
    }
    return count;
  }
}

module.exports = HookLoader;
