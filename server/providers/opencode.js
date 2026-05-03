'use strict';

/**
 * Provider: OpenCode (opencode run CLI)
 * Invoca `opencode run -q --format json [--model provider/model]` de manera headless.
 * opencode emite nd-JSON con eventos step_start / step_end.
 *
 * Instalación automática: `npm install -g opencode-ai` (vía endpoint /api/providers/opencode/install).
 * API keys: se configuran desde ProvidersPanel y se pasan como env vars al proceso.
 * El modelo se especifica en formato "provider/model" (ej: anthropic/claude-opus-4-7).
 */

const { spawn, execSync } = require('child_process');
const providerConfig      = require('../provider-config');

const MAX_PROMPT_CHARS = 8000;

// Mapeo de sub-proveedor → nombre de env var estándar que opencode reconoce
const KEY_ENV_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  google:    'GOOGLE_API_KEY',
  gemini:    'GOOGLE_API_KEY',
  groq:      'GROQ_API_KEY',
  xai:       'XAI_API_KEY',
};

function isInstalled() {
  try {
    const cmd = process.platform === 'win32' ? 'where opencode' : 'which opencode';
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Instala opencode-ai via npm install -g.
 * @param {Function} onLog — callback para logs de progreso
 * @returns {Promise<void>}
 */
function install(onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install', '-g', 'opencode-ai'], {
      shell: true,
      env: { ...process.env, npm_config_loglevel: 'notice' },
    });
    proc.stdout.on('data', d => onLog(d.toString()));
    proc.stderr.on('data', d => onLog(d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

/** Lee las API keys configuradas para opencode y las convierte en env vars. */
function getApiKeyEnv() {
  const cfg     = providerConfig.getConfig();
  const apiKeys = cfg.providers?.opencode?.apiKeys || {};
  const env     = {};
  for (const [provider, key] of Object.entries(apiKeys)) {
    const envVar = KEY_ENV_MAP[provider];
    if (envVar && key) env[envVar] = key;
  }
  return env;
}

function buildPrompt(history, text, systemPrompt) {
  const parts = [];

  if (systemPrompt) {
    const sp = Array.isArray(systemPrompt)
      ? systemPrompt.map(b => (typeof b === 'string' ? b : b.text || '')).filter(Boolean).join('\n\n')
      : systemPrompt;
    if (sp) { parts.push(sp); parts.push('---'); }
  }

  // Últimos 6 turnos como contexto (excluye el último mensaje de usuario, que va como `text`)
  const context = (history || []).slice(-7, -1);
  for (const msg of context) {
    const role    = msg.role === 'user' ? 'User' : 'Assistant';
    const content = Array.isArray(msg.content)
      ? msg.content.map(b => (typeof b === 'string' ? b : b.text || '')).join('')
      : (msg.content || '');
    if (content) parts.push(`${role}: ${content}`);
  }

  parts.push(text);
  const full = parts.join('\n');
  return full.length > MAX_PROMPT_CHARS ? full.slice(-MAX_PROMPT_CHARS) : full;
}

module.exports = {
  name: 'opencode',
  label: 'OpenCode',
  defaultModel: null,
  models: [
    'anthropic/claude-opus-4-7',
    'anthropic/claude-sonnet-4-6',
    'google/gemini-2.5-pro',
    'openai/gpt-4o',
    'openai/gpt-4.1',
    'groq/llama-3.3-70b-versatile',
  ],

  isInstalled,
  install,

  /**
   * @param {object}       opts
   * @param {string}       opts.text
   * @param {string|Array} [opts.systemPrompt]
   * @param {Array}        [opts.history]
   * @param {string}       [opts.model]           — ej: "anthropic/claude-opus-4-7"
   * @param {Function}     [opts.onChunk]
   * @param {string}       [opts.appendSystemPrompt]
   */
  async *chat({ text, systemPrompt, history, model, onChunk, appendSystemPrompt }) {
    if (!isInstalled()) {
      yield { type: 'done', fullText: '❌ opencode no está instalado. Instalalo desde Configuración → Providers → OpenCode.' };
      return;
    }

    const prompt = buildPrompt(history, text, systemPrompt);
    const apiKeyEnv = getApiKeyEnv();

    const args = ['run', '--quiet', '--format', 'json'];
    if (model) args.push('--model', model);
    if (appendSystemPrompt) args.push('--system', appendSystemPrompt);
    args.push(prompt);

    const proc = spawn('opencode', args, {
      shell: process.platform === 'win32',
      env: { ...process.env, ...apiKeyEnv, NO_COLOR: '1', TERM: 'dumb' },
    });

    const timer = setTimeout(() => proc.kill('SIGTERM'), 600_000);

    let buffer = '';
    let fullText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let stderrOut = '';

    proc.stderr?.on('data', d => { stderrOut += d.toString().slice(0, 1000); });

    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'step_end' && ev.part?.type === 'text' && ev.part.content) {
              fullText += ev.part.content;
              onChunk?.(ev.part.content);
            }
            if (ev.usage) {
              promptTokens     = ev.usage.input      ?? ev.usage.prompt     ?? promptTokens;
              completionTokens = ev.usage.output     ?? ev.usage.completion ?? completionTokens;
            }
          } catch (_) {}
        }
      }

      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer.trim());
          if (ev.type === 'step_end' && ev.part?.type === 'text' && ev.part.content) {
            fullText += ev.part.content;
          }
        } catch (_) {}
      }
    } catch (err) {
      clearTimeout(timer);
      yield { type: 'done', fullText: `[opencode] Error de proceso: ${err.message}` };
      return;
    }

    clearTimeout(timer);
    await new Promise(resolve => proc.on('close', resolve));

    if (promptTokens || completionTokens) {
      yield { type: 'usage', promptTokens, completionTokens };
    }

    yield { type: 'done', fullText: fullText || (stderrOut ? `[opencode error] ${stderrOut.slice(0, 500)}` : '') };
  },
};
