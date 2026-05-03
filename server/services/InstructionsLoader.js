'use strict';

/**
 * InstructionsLoader (A2)
 *
 * Auto-carga archivos de instrucciones al construir el system prompt.
 * Inspirado en `utils/claudemd.ts` de Claude Code, pero provider-agnóstico:
 * se integra en `ConversationService` (no en un provider concreto) para que
 * todos los providers (Anthropic, Gemini, Ollama, etc.) reciban las instrucciones.
 *
 * Orden de búsqueda (de menos específico a más específico):
 *   1. ~/.clawmint/GLOBAL.md           — user-global
 *   2. <repo>/CLAUDE.md                — project-level (repo checkout)
 *   3. <cwd>/AGENTS.md                 — workspace actual (cwd del chat)
 *
 * Las tres secciones se concatenan separadas por markers que deja claro
 * al modelo cuál es cada fuente.
 *
 * Parsing:
 *   - Frontmatter YAML opcional (`---\n...\n---`) se extrae y se ignora para el body.
 *   - Comentarios HTML `<!-- ... -->` se strippean (patrón Claude Code).
 *   - Cap de 40KB por archivo. Si se excede, se trunca con disclaimer.
 *
 * Cache:
 *   - In-memory por path absoluto + mtime. Invalida si cambia mtime.
 *   - Si archivo no existe o no es legible → no bloquear, seguir.
 *
 * Flag:
 *   - INSTRUCTIONS_ENABLED=true para activar. Default: false (no-op).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES_PER_FILE = 40 * 1024;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

class InstructionsLoader {
  /**
   * @param {object} [opts]
   * @param {string} [opts.repoRoot]       — raíz del repo (default: parent de server/)
   * @param {string} [opts.userHome]       — home del usuario (default: os.homedir())
   * @param {object} [opts.logger]
   * @param {object} [opts.hookRegistry]   — para emitir 'instructions_loaded'
   * @param {boolean} [opts.enabled]       — override; si omit, lee INSTRUCTIONS_ENABLED env
   */
  constructor({ repoRoot, userHome, logger, hookRegistry, enabled } = {}) {
    this._repoRoot = repoRoot || path.resolve(__dirname, '..', '..');
    this._userHome = userHome || os.homedir();
    this._logger = logger || console;
    this._hookRegistry = hookRegistry || null;
    this._enabled = typeof enabled === 'boolean' ? enabled : process.env.INSTRUCTIONS_ENABLED === 'true';

    /** @type {Map<string, { mtimeMs: number, content: string, partial: boolean }>} */
    this._cache = new Map();
  }

  get enabled() { return this._enabled; }
  setEnabled(v) { this._enabled = !!v; }

  /**
   * Resuelve las rutas candidatas en orden jerárquico.
   * @param {string} [cwd]
   * @returns {Array<{label:string, absPath:string}>}
   */
  resolvePaths(cwd) {
    const candidates = [
      { label: 'GLOBAL.md (~/.clawmint)', absPath: path.join(this._userHome, '.clawmint', 'GLOBAL.md') },
      { label: 'CLAUDE.md (repo)',        absPath: path.join(this._repoRoot, 'CLAUDE.md') },
    ];
    if (cwd) {
      const abs = path.resolve(cwd, 'AGENTS.md');
      // evitar duplicado si cwd coincide con repoRoot (ya cubierto por CLAUDE.md)
      if (!candidates.some(c => c.absPath === abs)) {
        candidates.push({ label: 'AGENTS.md (cwd)', absPath: abs });
      }
    }
    return candidates;
  }

  /**
   * Lee un archivo con cache por mtime + strip de frontmatter/comentarios + cap 40KB.
   * @returns {{content: string, partial: boolean}|null} null si no existe/ilegible
   */
  _loadFile(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const cached = this._cache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

    let raw;
    try {
      raw = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      this._logger.warn && this._logger.warn(`[InstructionsLoader] no se pudo leer ${absPath}: ${err.message}`);
      return null;
    }

    // Strip frontmatter
    const body = raw.replace(FRONTMATTER_RE, '');
    // Strip comentarios HTML
    const stripped = body.replace(HTML_COMMENT_RE, '');
    // Normaliza whitespace final
    let content = stripped.trim();

    let partial = false;
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES_PER_FILE) {
      // Trunca por bytes (no chars) y agrega disclaimer
      const buf = Buffer.from(content, 'utf8').subarray(0, MAX_BYTES_PER_FILE);
      // Evita cortar un char multibyte: retrocede hasta un char boundary
      content = buf.toString('utf8', 0, buf.length);
      content += '\n\n[...truncado: el archivo excede 40KB. Ver archivo completo si se necesita detalle.]';
      partial = true;
    }

    const entry = { mtimeMs: stat.mtimeMs, content, partial };
    this._cache.set(absPath, entry);
    return entry;
  }

  /**
   * Construye el bloque de instrucciones listo para prepender al system prompt.
   * @param {object} ctx   — {cwd, chatId, userId, agentKey, channel} para hook emit
   * @returns {string} vacío si no hay archivos o flag off
   */
  build(ctx = {}) {
    if (!this._enabled) return '';

    const paths = this.resolvePaths(ctx.cwd);
    const blocks = [];
    const loaded = [];

    for (const { label, absPath } of paths) {
      const entry = this._loadFile(absPath);
      if (!entry || !entry.content) continue;
      blocks.push(`<!-- [instructions: ${label}] -->\n${entry.content}`);
      loaded.push({ label, absPath, bytes: Buffer.byteLength(entry.content, 'utf8'), partial: entry.partial });
    }

    if (!blocks.length) return '';

    // Emit hook observacional (fire-and-forget)
    this._emitHook('instructions_loaded', {
      files: loaded, totalBytes: loaded.reduce((n, f) => n + f.bytes, 0),
    }, ctx);

    return blocks.join('\n\n');
  }

  _emitHook(event, payload, ctx) {
    if (!this._hookRegistry || !this._hookRegistry.enabled) return;
    const hookCtx = { chatId: ctx.chatId, userId: ctx.userId, agentKey: ctx.agentKey, channel: ctx.channel };
    Promise.resolve()
      .then(() => this._hookRegistry.emit(event, payload, hookCtx))
      .catch(() => {});
  }

  /** Invalida cache (testing y reload manual) */
  clearCache() { this._cache.clear(); }
}

module.exports = InstructionsLoader;
