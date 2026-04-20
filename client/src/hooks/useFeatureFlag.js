/**
 * useFeatureFlag — helpers para los feature flags VITE_FEATURE_* del cliente.
 *
 * Los flags se setean como env vars del build. En dev: `.env.local`; en packaged
 * (Tauri bundler): env al momento de `vite build`. El valor es 'true' / 'false'
 * string; si no está seteado, default false.
 *
 * Uso:
 *   import { isFeature, useFeature } from '../hooks/useFeatureFlag';
 *   if (isFeature('NEW_UI')) { ... }
 *   const enabled = useFeature('PERMISSIONS_PANEL');
 */

/** Sync check para usar fuera de componentes (logic, early-returns). */
export function isFeature(name) {
  const key = `VITE_FEATURE_${name}`;
  return import.meta.env[key] === 'true';
}

/** Hook equivalente — mismo valor pero para leer en render con React conventions. */
export function useFeature(name) {
  return isFeature(name);
}

/** Lista consolidada de flags disponibles (útil para debugging y settings UI). */
export const FEATURE_FLAGS = [
  'NEW_UI',              // Fase A — paleta OC-2 + primitives
  'PERMISSIONS_PANEL',   // Fase B
  'HOOKS_PANEL',         // Fase B
  'METRICS_DASHBOARD',   // Fase B
  'USERS_PANEL',         // Fase B
  'WORKSPACES_PANEL',    // Fase B
  'TASKS_PANEL',         // Fase C
  'SCHEDULER_PANEL',     // Fase C
  'TYPED_MEMORY_PANEL',  // Fase C
  'SESSION_SHARING_UI',  // Fase C
  'MCP_OAUTH_WIZARD',    // Fase C
  'COMMAND_PALETTE',     // Fase D
  'KEYBINDINGS_PANEL',   // Fase D
  'LOGS_STREAMING',      // Fase D
  'COMPACTION_PANEL',    // Fase E
  'MODEL_TIERS_PANEL',   // Fase E
  'TOOLS_FILTER_PANEL',  // Fase E
  'LSP_PANEL',           // Fase E
  'ORCHESTRATION_PANEL', // Fase E
  'SKILLS_PANEL',        // Fase C (independiente del existente en memory)
  'INTEGRATIONS_PANEL',  // Roadmap Fase 2+4.2 — hub de integraciones externas
  'DEVICES_PANEL',       // Roadmap Fase 5.1 — Home Assistant / dispositivos
  'MUSIC_PANEL',         // Roadmap Fase 5.4 — Spotify / música
];

/** Retorna un dict con todos los flags + su estado. Útil para settings UI. */
export function getAllFeatureFlags() {
  const out = {};
  for (const f of FEATURE_FLAGS) out[f] = isFeature(f);
  return out;
}
