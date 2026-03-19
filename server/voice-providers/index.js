'use strict';

function safeRequire(mod) {
  try { return require(mod); } catch { return null; }
}

const providers = {};
for (const [key, file] of [
  ['speecht5',    './speecht5'],
  ['openai-tts',  './openai-tts'],
  ['elevenlabs',  './elevenlabs'],
  ['google-tts',  './google-tts'],
  ['edge-tts',    './edge-tts'],
  ['piper-tts',   './piper-tts'],
]) {
  const mod = safeRequire(file);
  if (mod) providers[key] = mod;
}

module.exports = {
  list() {
    return Object.values(providers).map(p => ({
      name:         p.name,
      label:        p.label,
      type:         p.type,
      voices:       p.voices,
      defaultVoice: p.defaultVoice,
      models:       p.models,
      defaultModel: p.defaultModel,
    }));
  },
  get(name) {
    return providers[name] || providers['edge-tts'];
  },
};
