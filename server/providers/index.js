'use strict';

const providers = {
  'claude-code': require('./claude-code'),
  'anthropic':   require('./anthropic'),
  'gemini':      require('./gemini'),
  'openai':      require('./openai'),
  'grok':        require('./grok'),
};

module.exports = {
  list() {
    return Object.values(providers).map(p => ({
      name:         p.name,
      label:        p.label,
      models:       p.models,
      defaultModel: p.defaultModel,
    }));
  },
  get(name) {
    return providers[name] || providers['anthropic'];
  },
};
