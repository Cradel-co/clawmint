'use strict';

/**
 * LSPClient — cliente minimal de Language Server Protocol (JSON-RPC 2.0 sobre stdio).
 *
 * No depende de `vscode-jsonrpc` — implementa el framing `Content-Length: N\r\n\r\n<body>`
 * manualmente. Son ~100 líneas y evita ~2MB de deps.
 *
 * Ciclo de vida:
 *   const c = new LSPClient({ command, args, cwd, logger });
 *   await c.start();                             // spawn + initialize handshake
 *   const r = await c.request('textDocument/hover', {...});
 *   await c.shutdown();                          // shutdown + exit + kill
 *
 * Fase 10.
 */

const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_TIMEOUT_MS = Number(process.env.LSP_REQUEST_TIMEOUT_MS) || 30_000;

class LSPClient {
  /**
   * @param {object} opts
   * @param {string}   opts.command
   * @param {string[]} [opts.args]
   * @param {string}   [opts.cwd]
   * @param {object}   [opts.logger]
   * @param {number}   [opts.timeoutMs]
   * @param {object}   [opts.spawnImpl]   — override para tests
   */
  constructor({ command, args = [], cwd, logger = console, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl } = {}) {
    if (!command) throw new Error('LSPClient: command requerido');
    this._command = command;
    this._args = args;
    this._cwd = cwd || process.cwd();
    this._logger = logger;
    this._timeoutMs = timeoutMs;
    this._spawn = spawnImpl || spawn;
    this._child = null;
    this._nextId = 1;
    /** @type {Map<number, { resolve, reject, timer }>} */
    this._pending = new Map();
    this._buffer = Buffer.alloc(0);
    this._started = false;
    this._opened = new Set(); // file URIs did_open-eados
  }

  async start() {
    if (this._started) return;
    await this._spawnChild();
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this._cwd).href,
      capabilities: {
        textDocument: {
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          publishDiagnostics: {},
        },
        workspace: { symbol: { dynamicRegistration: false } },
      },
      workspaceFolders: [{ uri: pathToFileURL(this._cwd).href, name: path.basename(this._cwd) }],
    });
    this.notify('initialized', {});
    this._started = true;
  }

  _spawnChild() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this._command, this._args, {
          cwd: this._cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }
      this._child = child;

      child.on('error', (err) => {
        this._logger.warn && this._logger.warn(`[LSPClient] child error: ${err.message}`);
        this._rejectAll(err);
        reject(err);
      });
      child.on('exit', (code) => {
        this._logger.info && this._logger.info(`[LSPClient] child exited (${code})`);
        this._rejectAll(new Error(`LSP server exited with code ${code}`));
        this._started = false;
      });
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.on('data', (chunk) => {
        this._logger.debug && this._logger.debug(`[LSPClient stderr] ${chunk.toString().trim()}`);
      });

      // El child ya está spawned; resolver inmediatamente. El initialize request
      // sigue por request().
      resolve();
    });
  }

  /** Request JSON-RPC con id; espera respuesta. */
  request(method, params) {
    if (!this._child) return Promise.reject(new Error('LSPClient no inició'));
    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request "${method}" timeout (${this._timeoutMs}ms)`));
      }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this._write(payload); }
      catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Notification JSON-RPC sin id; no espera respuesta. */
  notify(method, params) {
    if (!this._child) return;
    try { this._write({ jsonrpc: '2.0', method, params }); } catch {}
  }

  async shutdown() {
    if (!this._child) return;
    try { await this.request('shutdown', null); } catch {}
    try { this.notify('exit', null); } catch {}
    try { this._child.kill(); } catch {}
    this._child = null;
    this._started = false;
    this._rejectAll(new Error('LSP client shutdown'));
  }

  /** Conveniencia: did_open con contenido de un archivo (idempotente por URI). */
  didOpen(uri, languageId, text) {
    if (this._opened.has(uri)) return;
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this._opened.add(uri);
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  _write(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this._child.stdin.write(Buffer.concat([header, body]));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this._buffer.slice(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Header corrupto — descartar buffer
        this._buffer = Buffer.alloc(0);
        return;
      }
      const len = parseInt(match[1], 10);
      const total = headerEnd + 4 + len;
      if (this._buffer.length < total) return;
      const body = this._buffer.slice(headerEnd + 4, total).toString('utf8');
      this._buffer = this._buffer.slice(total);
      try { this._handleMessage(JSON.parse(body)); }
      catch (err) {
        this._logger.warn && this._logger.warn(`[LSPClient] parse error: ${err.message}`);
      }
    }
  }

  _handleMessage(msg) {
    // Response: tiene id + (result o error)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    // Notification del server (p.ej. publishDiagnostics) — no la usamos acá, solo log.
    this._logger.debug && this._logger.debug(`[LSPClient notif] ${msg.method}`);
  }

  _rejectAll(err) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this._pending.delete(id);
    }
  }
}

module.exports = LSPClient;
