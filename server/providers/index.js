'use strict';

const { createOpencodeProvider } = require('./opencode');

const providers = {
  'claude-code': require('./claude-code'),
  'gemini-cli':  require('./gemini-cli'),
  'anthropic':   require('./anthropic'),
  'gemini':      require('./gemini'),
  'openai':      require('./openai'),
  'grok':        require('./grok'),
  'deepseek':    require('./deepseek'),
  'ollama':      require('./ollama'),
  'zen':         createOpencodeProvider('zen'),
  'go':          createOpencodeProvider('go'),
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
    for (const p of Object.values(providers)) {
      if (typeof p.fetchModels === 'function') {
        try { await p.fetchModels(); } catch {}
      }
    }
    return this.list();
  },
  get(name) {
    return providers[name] || providers['anthropic'];
  },
};
