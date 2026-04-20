'use strict';

/**
 * paths.js — resolución central de directorios del server.
 *
 * Permite que el mismo código funcione en dos modos:
 *
 *   DEV (repo clonado, `npm start`):
 *     Sin env vars. Todo relativo a `__dirname` (server/), igual que siempre.
 *
 *   PACKAGED (app instalable via Tauri sidecar):
 *     `CLAWMINT_DATA_DIR` apunta al dir de datos escribible (p.ej.
 *     C:\ProgramData\Clawmint o /var/lib/clawmint), y
 *     `CLAWMINT_RESOURCES_DIR` al dir read-only con el client build
 *     (C:\Program Files\Clawmint\resources / /opt/clawmint/resources).
 *
 * Retrocompat: en dev, `CLAWMINT_DATA_DIR` no está seteado → `isPackaged=false`
 * → todos los paths retornan lo mismo que siempre (los paths absolutos del
 * repo). Cero cambios funcionales al pasar al modo dev.
 *
 * Semántica de directorios:
 *   CONFIG_DIR    — JSONs de configuración (agents, bots, mcps, providers, tts, reminders, master-key)
 *   DATA_DIR      — Base de datos y estado mutable (sql.js DB, memory store)
 *   LOG_DIR       — Archivos de log rotados (server.log, logs.json)
 *   MODELS_DIR    — Caches de modelos HF transformers (on-demand download)
 *   RESOURCES_DIR — Read-only: client/dist, assets estáticos bundleados
 */

const path = require('path');
const fs = require('fs');

const isPackaged = !!process.env.CLAWMINT_DATA_DIR;
const dataRoot = process.env.CLAWMINT_DATA_DIR || __dirname;

// En dev mantenemos EXACTAMENTE los paths que el código usaba con __dirname.
// En packaged, subdividimos en carpetas con propósito claro para facilitar backups.
const CONFIG_DIR = isPackaged ? path.join(dataRoot, 'config') : __dirname;
// DATA_DIR: en dev === server dir (para que paths legacy como <server>/memory,
// <server>/memory-test, etc. resuelvan bien); en packaged === <root>/data.
const DATA_DIR   = isPackaged ? path.join(dataRoot, 'data')   : __dirname;
const LOG_DIR    = isPackaged ? path.join(dataRoot, 'logs')   : __dirname;
const MODELS_DIR = isPackaged ? path.join(dataRoot, 'models') : path.join(__dirname, 'models-cache');

// MEMORY_DIR: el código legacy lo usa como `<server>/memory`. Para preservar
// ese path en dev y a la vez darle un subpath claro en packaged, lo exportamos
// explícito en vez de que cada caller componga path.join(DATA_DIR, 'memory').
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// MCPS_DIR: colección de JSONs de MCPs registrados. En dev: <server>/mcps
// (legacy). En packaged: <config>/mcps (persisten entre upgrades).
const MCPS_DIR = isPackaged ? path.join(CONFIG_DIR, 'mcps') : path.join(__dirname, 'mcps');

// RESOURCES_DIR: dir read-only con client/dist y otros assets bundleados.
// En dev apunta al repo (../client/dist existe si hiciste client build).
// En packaged, Tauri setea CLAWMINT_RESOURCES_DIR al dir con los assets copiados.
const RESOURCES_DIR = process.env.CLAWMINT_RESOURCES_DIR
  || (isPackaged ? dataRoot : path.join(__dirname, '..'));

/**
 * Helper para paths de archivos de config comunes.
 * Centraliza los nombres de archivo para que el código no lo haga.
 */
const CONFIG_FILES = {
  bots:            path.join(CONFIG_DIR, 'bots.json'),
  agents:          path.join(CONFIG_DIR, 'agents.json'),
  mcps:            path.join(CONFIG_DIR, 'mcps.json'),
  mcpConfig:       path.join(CONFIG_DIR, 'mcp-config.json'),
  providerConfig:  path.join(CONFIG_DIR, 'provider-config.json'),
  ttsConfig:       path.join(CONFIG_DIR, 'tts-config.json'),
  reminders:       path.join(CONFIG_DIR, 'reminders.json'),
  nodrizaConfig:   path.join(CONFIG_DIR, 'nodriza-config.json'),
  tokenMasterKey:  path.join(CONFIG_DIR, '.token-master.key'),
  jwtSecret:       path.join(CONFIG_DIR, '.jwt-secret.key'),
};

const DATA_FILES = {
  memoryDb:   path.join(MEMORY_DIR, 'index.db'),
};

const LOG_FILES = {
  serverLog:  path.join(LOG_DIR, 'server.log'),
  logsJson:   path.join(LOG_DIR, 'logs.json'),
};

/**
 * Crea los directorios necesarios si no existen. Llamar una vez al bootstrap.
 * No-op en dev (los dirs ya existen en el repo).
 */
function ensureDirs() {
  const dirs = [CONFIG_DIR, DATA_DIR, MEMORY_DIR, LOG_DIR, MODELS_DIR, MCPS_DIR];
  for (const d of dirs) {
    if (!d) continue;
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    } catch (err) {
      // No romper el bootstrap por permisos; el módulo que necesite el dir fallará después con un error más claro.
      process.stderr.write(`[paths] mkdir fallo en ${d}: ${err.message}\n`);
    }
  }
}

module.exports = {
  isPackaged,
  dataRoot,
  CONFIG_DIR,
  DATA_DIR,
  MEMORY_DIR,
  MCPS_DIR,
  LOG_DIR,
  MODELS_DIR,
  RESOURCES_DIR,
  CONFIG_FILES,
  DATA_FILES,
  LOG_FILES,
  ensureDirs,
};
