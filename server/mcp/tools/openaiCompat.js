'use strict';

const { isAdmin } = require('./user-sandbox');

const DEFAULT_COMPAT_MODEL = 'anthropic/claude-haiku-4-5-20251001';

/**
 * Obtiene el modelo por defecto del endpoint /v1 (env > systemConfigRepo > hardcoded).
 * Réplica de getCompatDefaultModel() en openai-compat.js.
 */
function resolveDefaultModel(systemConfigRepo) {
  if (process.env.OPENAI_COMPAT_DEFAULT_MODEL) return process.env.OPENAI_COMPAT_DEFAULT_MODEL;
  if (systemConfigRepo) {
    const stored = systemConfigRepo.get('openai_compat_default_model');
    if (stored) return stored;
  }
  return DEFAULT_COMPAT_MODEL;
}

module.exports = [
  {
    name: 'openai_compat_status',
    description: 'Muestra el estado actual del endpoint OpenAI-compatible (/v1): si hay API key configurada y el modelo por defecto activo.',
    params: {},
    async execute(_args, ctx) {
      const { systemConfigRepo } = ctx;

      const envKey    = process.env.OPENAI_COMPAT_API_KEY;
      const storedKey = systemConfigRepo?.get('openai_compat_api_key');
      const activeKey = envKey || storedKey;

      const keyStatus  = !activeKey
        ? '❌ No configurada'
        : envKey
          ? `✅ Variable de entorno OPENAI_COMPAT_API_KEY (${activeKey.slice(0, 8)}…)`
          : `✅ Panel admin (${activeKey.slice(0, 8)}…)`;

      const model = resolveDefaultModel(systemConfigRepo);
      const modelSrc = process.env.OPENAI_COMPAT_DEFAULT_MODEL
        ? 'env var OPENAI_COMPAT_DEFAULT_MODEL'
        : (systemConfigRepo?.get('openai_compat_default_model') ? 'panel admin' : 'built-in default');

      return JSON.stringify({
        endpoint:     '/v1',
        apiKeyStatus: keyStatus,
        defaultModel: model,
        modelSource:  modelSrc,
      }, null, 2);
    },
  },

  {
    name: 'openai_compat_set_key',
    description: 'Configura la API key del endpoint OpenAI-compatible. Solo admin. Pasar key vacía para eliminarla.',
    params: { 'key?': '?string — nueva API key (vacía para eliminar)' },
    async execute({ key = '' }, ctx) {
      if (!isAdmin(ctx)) return 'Error: solo administradores pueden cambiar la API key del endpoint /v1.';

      const { systemConfigRepo } = ctx;
      if (!systemConfigRepo) return 'Error: systemConfigRepo no disponible en este contexto.';

      if (!key || !key.trim()) {
        systemConfigRepo.set('openai_compat_api_key', '');
        return '✅ API key eliminada. El endpoint /v1 quedará deshabilitado hasta configurar una nueva.';
      }

      systemConfigRepo.set('openai_compat_api_key', key.trim());
      return `✅ API key actualizada (${key.trim().slice(0, 8)}…). Clientes externos ya pueden usar /v1.`;
    },
  },

  {
    name: 'openai_compat_set_model',
    description: 'Cambia el proveedor/modelo por defecto del endpoint /v1. Formato: "provider/model" (ej. "anthropic/claude-haiku-4-5-20251001") o "provider" (usa el modelo configurado para ese proveedor). Vacío = restaurar default (Haiku). Solo admin.',
    params: { 'model?': '?string — "provider/model", "provider" o vacío para restaurar el default' },
    async execute({ model = '' }, ctx) {
      if (!isAdmin(ctx)) return 'Error: solo administradores pueden cambiar el modelo por defecto del endpoint /v1.';

      const { systemConfigRepo, providersModule } = ctx;
      if (!systemConfigRepo) return 'Error: systemConfigRepo no disponible en este contexto.';

      const trimmed = (model || '').trim();

      if (!trimmed) {
        systemConfigRepo.set('openai_compat_default_model', '');
        return `✅ Modelo restaurado al default built-in (${DEFAULT_COMPAT_MODEL}).`;
      }

      // Validar que el proveedor exista (si providersModule está disponible)
      if (providersModule) {
        const providerName = trimmed.includes('/') ? trimmed.slice(0, trimmed.indexOf('/')) : trimmed;
        try {
          const providers = await providersModule.listAsync();
          const found = providers.find(p => p.name === providerName);
          if (!found) {
            const names = providers.map(p => p.name).join(', ');
            return `Error: proveedor "${providerName}" no encontrado. Disponibles: ${names}`;
          }
        } catch {
          // Si falla la lista, continuar igual (mejor esfuerzo)
        }
      }

      systemConfigRepo.set('openai_compat_default_model', trimmed);
      return `✅ Modelo por defecto del endpoint /v1 cambiado a "${trimmed}".`;
    },
  },
];
