'use strict';

const providers = {
  'claude-code': require('./claude-code'),
  'gemini-cli':  require('./gemini-cli'),
  'anthropic':   require('./anthropic'),
  'gemini':      require('./gemini'),
  'openai':      require('./openai'),
  'grok':        require('./grok'),
  'deepseek':    require('./deepseek'),
  'ollama':      require('./ollama'),
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
  async listAsync() {
    const ollama = providers['ollama'];
    if (ollama && typeof ollama.fetchModels === 'function') {
      await ollama.fetchModels();
    }
    return this.list();
  },
  get(name) {
    return providers[name] || providers['anthropic'];
  },
};
