'use strict';

const voiceProviders = require('./voice-providers');
const ttsConfig      = require('./tts-config');

async function synthesize(text) {
  if (!ttsConfig.isEnabled()) return null;
  if (!text || !text.trim()) return null;

  const cfg      = ttsConfig.getConfig();
  const provider = voiceProviders.get(cfg.default);
  const provCfg  = cfg.providers[cfg.default] || {};

  return provider.synthesize({
    text: text.slice(0, 500),
    voice:  provCfg.voice || provider.defaultVoice,
    model:  provCfg.model || provider.defaultModel,
    apiKey: ttsConfig.getApiKey(cfg.default),
  });
}

function enable()    { ttsConfig.enable(); }
function disable() {
  ttsConfig.disable();
  const cfg = ttsConfig.getConfig();
  const provider = voiceProviders.get(cfg.default);
  if (typeof provider.unload === 'function') provider.unload();
}
function isEnabled() { return ttsConfig.isEnabled(); }
function getConfig() { return ttsConfig.getConfig(); }

function setModel(modelId) {
  const cfg = ttsConfig.getConfig();
  ttsConfig.setProvider(cfg.default, { model: modelId });
  const provider = voiceProviders.get(cfg.default);
  if (typeof provider.unload === 'function') provider.unload();
}

async function preload() {
  const cfg = ttsConfig.getConfig();
  const provider = voiceProviders.get(cfg.default);
  if (typeof provider.preload === 'function') {
    await provider.preload(cfg.providers[cfg.default]?.model);
  }
}

function unload() {
  const cfg = ttsConfig.getConfig();
  const provider = voiceProviders.get(cfg.default);
  if (typeof provider.unload === 'function') provider.unload();
}

module.exports = { synthesize, preload, unload, enable, disable, isEnabled, getConfig, setModel };
