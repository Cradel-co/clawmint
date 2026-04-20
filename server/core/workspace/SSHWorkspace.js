'use strict';

/**
 * SSHWorkspace — ejecuta tools en un host remoto vía SSH.
 *
 * Útil cuando Clawmint corre on-premise en un NAS pero el subagente debe
 * ejecutar comandos en otro host (p.ej. Raspberry Pi remoto).
 *
 * Cada `acquire` abre una conexión SSH reusable. El `cwd` retornado es
 * **lógico** (no un path filesystem del server): los tools que usen
 * `workspace.exec` pueden correr comandos remotos. Para tools que escriben
 * archivos (read_file, etc.), se requiere bind via sshfs o equivalente fuera
 * del scope de esta clase.
 *
 * Lazy import de `ssh2` — si el package no está instalado, fail-open.
 *
 * Fase 12.2.
 */

const path = require('path');
const crypto = require('crypto');

const WorkspaceProvider = require('./WorkspaceProvider');

class SSHWorkspace extends WorkspaceProvider {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=22]
   * @param {string} opts.username
   * @param {string} [opts.privateKeyPath]  — path a key pem
   * @param {string} [opts.password]         — alternativa a key
   * @param {string} [opts.remoteRoot='/tmp/clawmint']  — base remota
   * @param {object} [opts.logger]
   * @param {boolean} [opts.failOpen=true]
   */
  constructor({
    host = process.env.SSH_WORKSPACE_HOST,
    port = Number(process.env.SSH_WORKSPACE_PORT) || 22,
    username = process.env.SSH_WORKSPACE_USER,
    privateKeyPath = process.env.SSH_WORKSPACE_KEY_PATH,
    password,
    remoteRoot = process.env.SSH_WORKSPACE_REMOTE_ROOT || '/tmp/clawmint',
    logger = console,
    failOpen = true,
  } = {}) {
    super();
    this._host = host;
    this._port = port;
    this._username = username;
    this._privateKeyPath = privateKeyPath;
    this._password = password;
    this._remoteRoot = remoteRoot;
    this._logger = logger;
    this._failOpen = failOpen;
    /** @type {Map<string, { conn: any, remotePath: string, createdAt: number, lastAccessAt: number }>} */
    this._active = new Map();
  }

  async acquire(ctx = {}) {
    const ssh2 = this._loadSsh2();
    if (!ssh2) return this._fallback('ssh2 no instalado');
    if (!this._host || !this._username) return this._fallback('SSH_WORKSPACE_HOST/USER no configurados');

    const agentSlug = _slug(ctx.agentKey || ctx.agentId || 'sub');
    const id = `${agentSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const remotePath = path.posix.join(this._remoteRoot, id);

    let conn;
    try {
      conn = await this._openConnection(ssh2);
    } catch (err) {
      return this._fallback(`conexión SSH falló: ${err.message}`);
    }

    // Crear dir remoto
    try {
      await this._execRemote(conn, `mkdir -p ${_shQuote(remotePath)}`);
    } catch (err) {
      try { conn.end(); } catch {}
      return this._fallback(`mkdir remoto falló: ${err.message}`);
    }

    const now = Date.now();
    this._active.set(id, { conn, remotePath, createdAt: now, lastAccessAt: now });

    const self = this;
    const release = async () => {
      const entry = self._active.get(id);
      if (!entry) return;
      try {
        await self._execRemote(entry.conn, `rm -rf ${_shQuote(entry.remotePath)}`);
      } catch (err) {
        self._logger.warn && self._logger.warn(`[SSHWorkspace] cleanup ${id} falló: ${err.message}`);
      }
      try { entry.conn.end(); } catch {}
      self._active.delete(id);
    };

    return {
      id,
      cwd: remotePath,
      release,
      meta: { provider: 'ssh', host: this._host, remotePath, _conn: conn }, // _conn expuesto para tools custom
    };
  }

  list() {
    return Array.from(this._active.entries()).map(([id, e]) => ({
      id, remotePath: e.remotePath, createdAt: e.createdAt, lastAccessAt: e.lastAccessAt,
    }));
  }

  touch(id) {
    const e = this._active.get(id);
    if (e) e.lastAccessAt = Date.now();
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  _loadSsh2() {
    try {
      return require('ssh2');
    } catch {
      return null;
    }
  }

  _fallback(reason) {
    if (this._failOpen) {
      this._logger.warn && this._logger.warn(`[SSHWorkspace] fallback: ${reason}`);
      return {
        id: 'fallback', cwd: process.cwd(), release: async () => {},
        meta: { provider: 'ssh', status: 'fallback', reason },
      };
    }
    throw new Error(`SSHWorkspace: ${reason}`);
  }

  _openConnection(ssh2) {
    return new Promise((resolve, reject) => {
      const conn = new ssh2.Client();
      conn.on('ready', () => resolve(conn));
      conn.on('error', reject);
      const cfg = {
        host: this._host,
        port: this._port,
        username: this._username,
        readyTimeout: 10_000,
      };
      if (this._privateKeyPath) {
        try { cfg.privateKey = require('fs').readFileSync(this._privateKeyPath); }
        catch (err) { return reject(new Error(`lectura privateKey falló: ${err.message}`)); }
      } else if (this._password) {
        cfg.password = this._password;
      } else {
        return reject(new Error('ni privateKey ni password configurados'));
      }
      try { conn.connect(cfg); } catch (err) { reject(err); }
    });
  }

  _execRemote(conn, cmd) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '', stderr = '';
        stream.on('close', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`exit ${code}: ${stderr || stdout}`));
        });
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
      });
    });
  }
}

function _slug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
}

function _shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = SSHWorkspace;
