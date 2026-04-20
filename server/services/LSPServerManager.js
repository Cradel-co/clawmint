'use strict';

/**
 * LSPServerManager — pool de LSPClients por (workspaceRoot, lenguaje).
 *
 * Cada lenguaje tiene un server-spec configurado (command + args + extensions).
 * Al pedir cliente por un archivo, resuelve el lenguaje por extensión y reutiliza
 * el cliente ya abierto si existe.
 *
 * Configuración default:
 *   typescript-language-server, pylsp, rust-analyzer, gopls (si están instalados).
 * Override via env LSP_SERVERS_JSON con shape:
 *   { "ts": { "command": "...", "args": [...], "extensions": [".ts"] } }
 *
 * Fase 10.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const LSPClient = require('./LSPClient');

const DEFAULT_SERVERS = {
  ts:   { command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'], languageId: 'typescript' },
  py:   { command: 'pylsp',         args: [], extensions: ['.py'],  languageId: 'python' },
  rust: { command: 'rust-analyzer', args: [], extensions: ['.rs'],  languageId: 'rust' },
  go:   { command: 'gopls',         args: [], extensions: ['.go'],  languageId: 'go' },
};

function _loadServers() {
  const raw = process.env.LSP_SERVERS_JSON;
  if (!raw) return DEFAULT_SERVERS;
  try { return JSON.parse(raw); } catch { return DEFAULT_SERVERS; }
}

class LSPServerManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.servers]       — override de DEFAULT_SERVERS
   * @param {object} [opts.logger]
   * @param {Function} [opts.clientFactory] — para tests (default: new LSPClient)
   */
  constructor({ servers, logger = console, clientFactory, detectImpl } = {}) {
    this._servers = servers || _loadServers();
    this._logger = logger;
    this._clientFactory = clientFactory || ((opts) => new LSPClient(opts));
    this._detectImpl = detectImpl || _defaultDetect;
    /** @type {Map<string, Map<string, LSPClient>>} workspaceRoot → (langKey → client) */
    this._pool = new Map();
    /** @type {Map<string, boolean>} langKey → available (lazy, null si no chequeado aún) */
    this._availability = new Map();
  }

  /**
   * Detecta qué language servers están disponibles en el host. Lo hace probando
   * cada `command` con `--version` o similar. Resultado cacheado — volver a
   * llamar con `force=true` para re-chequear.
   *
   * Se llama al bootstrap y cachea. Las tools lsp_* consultan `isAvailable(lang)`
   * antes de invocar para fallar fast con mensaje claro en vez de timeout.
   */
  async detectAvailableServers({ force = false } = {}) {
    const results = {};
    for (const [key, spec] of Object.entries(this._servers)) {
      if (!force && this._availability.has(key)) {
        results[key] = this._availability.get(key);
        continue;
      }
      const ok = this._detectImpl(spec.command);
      this._availability.set(key, ok);
      results[key] = ok;
      if (!ok) {
        this._logger.info && this._logger.info(`[LSP] "${key}" (${spec.command}) no disponible en host — las tools lsp_* para ${spec.extensions?.join(',')} fallarán con mensaje claro`);
      }
    }
    return results;
  }

  /** True si el language server para este lenguaje/extensión está disponible. */
  isAvailable(langKey) {
    return this._availability.get(langKey) === true;
  }

  /** Resuelve lang + retorna disponibilidad. Null si no hay server para la extensión. */
  isAvailableForFile(filePath) {
    const lang = this.resolveLanguage(filePath);
    if (!lang) return { language: null, available: false };
    return { language: lang, available: this.isAvailable(lang) };
  }

  /** Lista todos los servers con disponibilidad. */
  listServers() {
    return Object.entries(this._servers).map(([key, spec]) => ({
      language: key,
      command: spec.command,
      extensions: spec.extensions,
      available: this._availability.get(key) === true,
    }));
  }

  /** Resuelve el langKey por extensión del filePath. Null si no hay server conocido. */
  resolveLanguage(filePath) {
    if (!filePath) return null;
    const ext = path.extname(filePath).toLowerCase();
    for (const [key, spec] of Object.entries(this._servers)) {
      if (spec.extensions && spec.extensions.includes(ext)) return key;
    }
    return null;
  }

  /**
   * Obtiene (o crea+inicia) un LSPClient para un archivo en un workspace.
   * Retorna `null` si el lenguaje no tiene server configurado.
   * Throws si el start falla.
   */
  async getClientForFile({ filePath, workspaceRoot }) {
    const langKey = this.resolveLanguage(filePath);
    if (!langKey) return null;
    const root = workspaceRoot || process.cwd();
    let byLang = this._pool.get(root);
    if (!byLang) { byLang = new Map(); this._pool.set(root, byLang); }
    let client = byLang.get(langKey);
    if (client) return client;

    const spec = this._servers[langKey];
    client = this._clientFactory({
      command: spec.command,
      args: spec.args || [],
      cwd: root,
      logger: this._logger,
    });
    byLang.set(langKey, client);
    try {
      await client.start();
    } catch (err) {
      byLang.delete(langKey);
      throw err;
    }
    return client;
  }

  /** Convenience wrapper: arranca cliente (si hace falta), hace did_open y request. */
  async request({ filePath, workspaceRoot, method, paramsBuilder }) {
    const client = await this.getClientForFile({ filePath, workspaceRoot });
    if (!client) return { unsupported: true, language: null };
    const fs = require('fs');
    if (filePath && fs.existsSync(filePath)) {
      const { pathToFileURL } = require('url');
      const uri = pathToFileURL(filePath).href;
      let text = '';
      try { text = fs.readFileSync(filePath, 'utf8'); } catch {}
      const langKey = this.resolveLanguage(filePath);
      const langId = this._servers[langKey]?.languageId || langKey;
      client.didOpen(uri, langId, text);
    }
    const params = paramsBuilder ? paramsBuilder() : {};
    return client.request(method, params);
  }

  /** Lista workspaces + lenguajes activos. */
  list() {
    const out = [];
    for (const [root, byLang] of this._pool) {
      out.push({ workspaceRoot: root, languages: Array.from(byLang.keys()) });
    }
    return out;
  }

  /** Apaga todo. */
  async shutdown() {
    const tasks = [];
    for (const byLang of this._pool.values()) {
      for (const client of byLang.values()) {
        tasks.push(client.shutdown().catch(() => {}));
      }
    }
    await Promise.all(tasks);
    this._pool.clear();
  }
}

function _defaultDetect(command) {
  try {
    // Probar con --version (la mayoría de LSPs responden); timeout 3s.
    const res = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

module.exports = LSPServerManager;
module.exports.DEFAULT_SERVERS = DEFAULT_SERVERS;
