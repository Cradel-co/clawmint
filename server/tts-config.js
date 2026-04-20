'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILES } = require('./paths');

const CONFIG_FILE = CONFIG_FILES.ttsConfig;

const DEFAULT_CONFIG = {
  enabled: false,
  default: 'edge-tts',
  providers: {
    speecht5:      { voice: null, model: 'Xenova/speecht5_tts' },
    'openai-tts':  { apiKey: '', voice: 'nova', model: 'tts-1' },
    elevenlabs:    { apiKey: '', voice: 'rachel', model: 'eleven_multilingual_v2' },
    'google-tts':  { apiKey: '', voice: 'es-US-Standard-A', model: 'standard' },
    'edge-tts':    { voice: 'es-MX-DaliaNeural', model: 'default' },
    'piper-tts':   { voice: 'es_MX-claude-medium', model: 'medium' },
  },
};

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Merge con defaults para campos nuevos
      return {
        ...DEFAULT_CONFIG,
        ...saved,
        providers: { ...DEFAULT_CONFIG.providers, ...saved.providers },
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// Inicializar si no existe
if (!fs.existsSync(CONFIG_FILE)) {
  saveConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
}

const ENV_MAP = {
  'openai-tts':  'OPENAI_API_KEY',
  elevenlabs:    'ELEVENLABS_API_KEY',
  'google-tts':  'GOOGLE_TTS_API_KEY',
};

function getApiKey(name) {
  const envKey = ENV_MAP[name];
  if (envKey && process.env[envKey]) return process.env[envKey];
  const cfg = getConfig();
  return cfg.providers?.[name]?.apiKey || '';
}

function setProvider(name, opts = {}) {
  const cfg = getConfig();
  if (!cfg.providers[name]) cfg.providers[name] = {};
  if (opts.apiKey !== undefined) cfg.providers[name].apiKey = opts.apiKey;
  if (opts.voice !== undefined) cfg.providers[name].voice = opts.voice;
  if (opts.model !== undefined) cfg.providers[name].model = opts.model;
  saveConfig(cfg);
}

function setDefault(name) {
  const cfg = getConfig();
  cfg.default = name;
  saveConfig(cfg);
}

function enable() {
  const cfg = getConfig();
  cfg.enabled = true;
  saveConfig(cfg);
}

function disable() {
  const cfg = getConfig();
  cfg.enabled = false;
  saveConfig(cfg);
}

function isEnabled() {
  return getConfig().enabled;
}

module.exports = { getConfig, saveConfig, getApiKey, setProvider, setDefault, enable, disable, isEnabled };
