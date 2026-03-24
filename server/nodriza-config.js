'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'nodriza-config.json');

const DEFAULT_CONFIG = {
  enabled: false,
  url: 'ws://localhost:3000/signaling',
  serverId: '',
  apiKey: '',
};

function getConfig() {
  let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = { ...cfg, ...file };
    }
  } catch {}

  // Env vars tienen prioridad
  if (process.env.NODRIZA_ENABLED !== undefined) cfg.enabled = process.env.NODRIZA_ENABLED === 'true';
  if (process.env.NODRIZA_URL)       cfg.url       = process.env.NODRIZA_URL;
  if (process.env.NODRIZA_SERVER_ID) cfg.serverId  = process.env.NODRIZA_SERVER_ID;
  if (process.env.NODRIZA_API_KEY)   cfg.apiKey    = process.env.NODRIZA_API_KEY;

  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function setConfig(partial) {
  const cfg = { ...getFileConfig(), ...partial };
  saveConfig(cfg);
}

/** Lee solo el archivo JSON sin env override */
function getFileConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function isEnabled() {
  const cfg = getConfig();
  return cfg.enabled && !!cfg.serverId && !!cfg.apiKey;
}

// Inicializar archivo si no existe
if (!fs.existsSync(CONFIG_FILE)) {
  saveConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
}

module.exports = { getConfig, setConfig, isEnabled };
