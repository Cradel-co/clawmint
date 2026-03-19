'use strict';

const providers = {
  speecht5:      require('./speecht5'),
  'openai-tts':  require('./openai-tts'),
  elevenlabs:    require('./elevenlabs'),
  'google-tts':  require('./google-tts'),
  'edge-tts':    require('./edge-tts'),
  'piper-tts':   require('./piper-tts'),
};

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
