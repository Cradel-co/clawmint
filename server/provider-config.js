'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILES } = require('./paths');

const CONFIG_FILE = CONFIG_FILES.providerConfig;

// Tracking para no spamear warnings: un warning por provider por proceso
const _warnedPlaintext = new Set();

const DEFAULT_CONFIG = {
  default: 'claude-code',
  providers: {
    anthropic: { apiKey: '', model: 'claude-opus-4-6' },
    gemini:    { apiKey: '', model: 'gemini-2.0-flash' },
    openai:    { apiKey: '', model: 'gpt-4o' },
    grok:      { apiKey: '', model: 'grok-3-fast' },
    deepseek:  { apiKey: '', model: 'deepseek-chat' },
    ollama:    { apiKey: '', model: 'llama3.2' },
  },
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// Inicializar si no existe
if (!fs.existsSync(CONFIG_FILE)) {
  saveConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
}

/**
 * Obtiene la API key para un provider.
 * Las env vars tienen prioridad sobre lo guardado en archivo.
 *
 * SEGURIDAD: `provider-config.json` puede contener API keys en plaintext.
 * Recomendado:
 *   - Agregar `provider-config.json` a `.gitignore`
 *   - Usar SIEMPRE env vars en producción (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *   - No commitear keys reales al repo
 */
function getApiKey(name) {
  const envMap = {
    anthropic: 'ANTHROPIC_API_KEY',
    gemini:    'GOOGLE_API_KEY',
    openai:    'OPENAI_API_KEY',
    grok:      'XAI_API_KEY',
    deepseek:  'DEEPSEEK_API_KEY',
    ollama:    'OLLAMA_API_KEY',
  };
  const envKey = envMap[name];
  if (envKey && process.env[envKey]) return process.env[envKey];

  const cfg = getConfig();
  const fileKey = cfg.providers?.[name]?.apiKey || '';
  // Warning una sola vez por provider si la key está en el archivo en vez de env
  if (fileKey && !_warnedPlaintext.has(name) && name !== 'ollama') {
    process.stderr.write(`[provider-config] ⚠️  ${name} API key en provider-config.json (plaintext). Migrar a env var ${envKey} recomendado.\n`);
    _warnedPlaintext.add(name);
  }
  return fileKey;
}

function setProvider(name, { apiKey, model } = {}) {
  const cfg = getConfig();
  if (!cfg.providers[name]) cfg.providers[name] = {};
  if (apiKey !== undefined) cfg.providers[name].apiKey = apiKey;
  if (model  !== undefined) cfg.providers[name].model  = model;
  saveConfig(cfg);
}

function setDefault(name) {
  const cfg = getConfig();
  cfg.default = name;
  saveConfig(cfg);
}

module.exports = { getConfig, getApiKey, setProvider, setDefault };
