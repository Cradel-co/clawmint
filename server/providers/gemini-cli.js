'use strict';

/**
 * Provider: Gemini CLI (gemini -p)
 * Wrapper sobre GeminiCliSession — análogo a claude-code.js.
 * Los MCP servers se sincronizan automáticamente a ~/.gemini/settings.json
 * desde mcps.js generateConfigFile() — incluye 'clawmint' (HTTP) + MCPs externos.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Lista por defecto si no podemos descubrir nada (CLI ausente y sin API key).
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];

let cachedModels = null;
let cacheExpiry  = 0;

/**
 * Localiza el directorio bundle del gemini CLI instalado globalmente.
 * Devuelve null si no está disponible.
 */
function resolveBundleDir() {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const cmdPath = execSync(`${which} gemini`, { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (!cmdPath) return null;
    const dir = path.join(path.dirname(cmdPath), 'node_modules', '@google', 'gemini-cli', 'bundle');
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Extrae los modelos "visibles" del bundle de gemini CLI parseando `modelDefinitions`.
 * Esto evita llamar a la API y funciona aunque el usuario use OAuth (sin GEMINI_API_KEY).
 */
function readModelsFromCliBundle() {
  const bundleDir = resolveBundleDir();
  if (!bundleDir) return null;

  // Buscar el chunk que contiene `modelDefinitions:` Y al menos un `isVisible: true`.
  // El bundle tiene varios chunks con `modelDefinitions:` (variantes light), elegimos el que
  // realmente lista modelos visibles concretos.
  let target = null;
  try {
    for (const file of fs.readdirSync(bundleDir)) {
      if (!file.startsWith('chunk-') || !file.endsWith('.js')) continue;
      const full = path.join(bundleDir, file);
      const content = fs.readFileSync(full, 'utf8');
      if (content.includes('modelDefinitions:') && /isVisible:\s*true/.test(content)) {
        target = content;
        break;
      }
    }
  } catch { return null; }
  if (!target) return null;

  // Extraer cada definición buscando el cuerpo balanceado entre llaves del modelo
  // ("id": { ... }) y luego chequeando `isVisible: true` adentro.
  const models = new Set();
  const idRe = /"((?:auto-)?gemini-[a-z0-9._-]+)":\s*\{/g;
  let mm;
  while ((mm = idRe.exec(target)) !== null) {
    const id = mm[1];
    // Recorrer desde la `{` para encontrar la `}` balanceada
    let depth = 1, i = idRe.lastIndex, len = target.length;
    while (i < len && depth > 0) {
      const c = target[i++];
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) continue;
    const body = target.slice(idRe.lastIndex, i - 1);
    if (/isVisible:\s*true/.test(body)) models.add(id);
  }
  const list = [...models].sort((a, b) => {
    // Ordenar: no-preview primero, luego por nombre desc para que las versiones nuevas queden arriba
    const ap = /preview/i.test(a) ? 1 : 0;
    const bp = /preview/i.test(b) ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return b.localeCompare(a);
  });
  return list.length > 0 ? list : null;
}

/**
 * Resolver de modelos:
 *   1. Cache (1h)
 *   2. Parsear el bundle de gemini CLI (sin red)
 *   3. Llamar a Generative Language API si hay GEMINI_API_KEY/GOOGLE_API_KEY
 *   4. DEFAULT_MODELS hardcoded
 */
async function fetchAvailableModels() {
  if (cachedModels && Date.now() < cacheExpiry) return cachedModels;

  // Path 1: parsear el bundle del CLI local (no requiere red ni API key)
  const fromBundle = readModelsFromCliBundle();
  if (fromBundle && fromBundle.length > 0) {
    cachedModels = fromBundle;
    cacheExpiry  = Date.now() + 3600_000;
    return cachedModels;
  }

  // Path 2: Google Generative Language API si hay key
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const list = (data.models || [])
          .filter(mm => Array.isArray(mm.supportedGenerationMethods) && mm.supportedGenerationMethods.includes('generateContent'))
          .map(mm => (mm.name || '').replace(/^models\//, ''))
          .filter(name => name.startsWith('gemini-') && !/embedding|aqa|tuning/i.test(name));
        if (list.length > 0) {
          cachedModels = list;
          cacheExpiry  = Date.now() + 3600_000;
          return cachedModels;
        }
      }
    } catch { /* fallthrough */ }
  }

  return DEFAULT_MODELS;
}

module.exports = {
  name: 'gemini-cli',
  label: 'Gemini CLI',
  defaultModel: 'gemini-2.5-flash-lite',
  models: DEFAULT_MODELS,

  /**
   * Refresca la lista de modelos en `this.models` consultando la API si hay key.
   * Compatible con el patrón de ollama.js.
   */
  async fetchModels() {
    const mdls = await fetchAvailableModels();
    this.models = mdls.length ? mdls : DEFAULT_MODELS;
    return this.models;
  },

  /**
   * @param {{ systemPrompt, history, model, geminiSession, onChunk }} opts
   * geminiSession: instancia de GeminiCliSession (requerida)
   * onChunk: callback(partialText) para streaming progresivo
   */
  async *chat({ systemPrompt, history, model, geminiSession, onChunk }) {
    if (!geminiSession) {
      yield { type: 'done', fullText: 'Error: geminiSession requerida para gemini-cli provider' };
      return;
    }

    const lastMsg = history[history.length - 1];
    let messageText = lastMsg?.content || '';

    // Primer mensaje: inyectar system prompt al inicio
    if (geminiSession.messageCount === 0 && systemPrompt) {
      messageText = `${systemPrompt}\n\n---\n\n${messageText}`;
    }

    if (model && !geminiSession.model) geminiSession.model = model;

    try {
      const { text } = await geminiSession.sendMessage(messageText, onChunk);
      yield {
        type: 'usage',
        promptTokens:     geminiSession.totalInputTokens,
        completionTokens: geminiSession.totalOutputTokens,
      };
      yield { type: 'done', fullText: text };
    } catch (err) {
      yield { type: 'done', fullText: `Error Gemini CLI: ${err.message}` };
    }
  },
};
