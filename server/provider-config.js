'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'provider-config.json');

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
  return cfg.providers?.[name]?.apiKey || '';
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
