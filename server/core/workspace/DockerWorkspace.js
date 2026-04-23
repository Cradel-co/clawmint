'use strict';

/**
 * DockerWorkspace — aislamiento real vía container Docker.
 *
 * Cada `acquire` arranca un container long-running con un bind-mount de un
 * directorio temporal. El subagente ejecuta tools dentro del container vía
 * `docker exec`. Al `release()`, se hace `docker rm -f`.
 *
 * Consideraciones:
 *   - NO ejecutamos comandos dentro del container acá; esta clase solo provee
 *     un cwd (el host bind-mount path). La integración con bash/shellSandbox
 *     queda como siguiente paso (ejecutar via `docker exec -w /workspace $id`).
 *   - Fail-open: si Docker no está instalado o la imagen no existe, devolvemos
 *     un fallback con cwd del host + warning. Así activar el flag no rompe prod.
 *   - `image` por defecto: `clawmint/sandbox:latest` (usuario debe buildearla
 *     aparte; sino el Docker falla en acquire y se cae a fallback).
 *
 * Fase 12.2.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const WorkspaceProvider = require('./WorkspaceProvider');

class DockerWorkspace extends WorkspaceProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.image]           — imagen docker (default `clawmint/sandbox:latest`)
   * @param {string} [opts.workDir]         — dir raíz de bind mounts (default `<os.tmpdir>/clawmint-ws`)
   * @param {string} [opts.containerPrefix] — prefijo de nombres (default `clawmint-ws-`)
   * @param {string[]} [opts.dockerCmd]     — command vector (default `['docker']`)
   * @param {object} [opts.logger]
   * @param {boolean} [opts.failOpen=true]
   */
  constructor({
    image = process.env.DOCKER_WORKSPACE_IMAGE || 'clawmint/sandbox:latest',
    workDir,
    containerPrefix = 'clawmint-ws-',
    dockerCmd = ['docker'],
    logger = console,
    failOpen = true,
  } = {}) {
    super();
    this._image = image;
    this._workDir = workDir || path.join(os.tmpdir(), 'clawmint-ws');
    this._containerPrefix = containerPrefix;
    this._dockerCmd = dockerCmd;
    this._logger = logger;
    this._failOpen = failOpen;
    /** @type {Map<string, { containerId: string, hostPath: string, createdAt: number, lastAccessAt: number }>} */
    this._active = new Map();
  }

  async acquire(ctx = {}) {
    if (!this._dockerAvailable()) {
      return this._fallback('docker no disponible');
    }

    const agentSlug = _slug(ctx.agentKey || ctx.agentId || 'sub');
    const id = `${agentSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const hostPath = path.join(this._workDir, id);
    const containerName = `${this._containerPrefix}${id}`;

    try {
      fs.mkdirSync(hostPath, { recursive: true });
    } catch (err) {
      return this._fallback(`mkdir ${hostPath} falló: ${err.message}`);
    }

    // `docker run -d --rm --name X -v host:/workspace -w /workspace image tail -f /dev/null`
    // El container queda corriendo idle; los tools luego hacen `docker exec`.
    const res = this._runSync([
      'run', '-d', '--rm',
      '--name', containerName,
      '-v', `${hostPath}:/workspace`,
      '-w', '/workspace',
      this._image,
      'tail', '-f', '/dev/null',
    ]);

    if (res.status !== 0) {
      try { fs.rmSync(hostPath, { recursive: true, force: true }); } catch {}
      return this._fallback(`docker run falló: ${(res.stderr || '').slice(0, 200).trim()}`);
    }

    const containerId = (res.stdout || '').trim();
    const now = Date.now();
    this._active.set(id, { containerId, hostPath, containerName, createdAt: now, lastAccessAt: now });

    const self = this;
    const release = async () => {
      const entry = self._active.get(id);
      if (!entry) return;
      try {
        await self._removeContainer(entry.containerName || entry.containerId);
      } catch (err) {
        self._logger.warn && self._logger.warn(`[DockerWorkspace] release ${id} falló: ${err.message}`);
      }
      try { fs.rmSync(entry.hostPath, { recursive: true, force: true }); } catch {}
      self._active.delete(id);
    };

    return {
      id,
      cwd: hostPath,
      release,
      meta: { provider: 'docker', image: this._image, containerId, containerName },
    };
  }

  /** GC: libera containers sin actividad > idleMs. */
  async gc(idleMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const toPurge = [];
    for (const [id, entry] of this._active) {
      if (now - entry.lastAccessAt > idleMs) toPurge.push({ id, entry });
    }
    for (const { id, entry } of toPurge) {
      try { await this._removeContainer(entry.containerName || entry.containerId); }
      catch (err) { this._logger.warn && this._logger.warn(`[GC] ${id} falló: ${err.message}`); }
      try { fs.rmSync(entry.hostPath, { recursive: true, force: true }); } catch {}
      this._active.delete(id);
    }
    return toPurge.length;
  }

  list() {
    return Array.from(this._active.entries()).map(([id, e]) => ({
      id, containerId: e.containerId, containerName: e.containerName, hostPath: e.hostPath,
      createdAt: e.createdAt, lastAccessAt: e.lastAccessAt,
    }));
  }

  touch(id) {
    const e = this._active.get(id);
    if (e) e.lastAccessAt = Date.now();
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  _dockerAvailable() {
    try {
      const res = this._runSync(['--version']);
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /** Wrapper testeable sobre spawnSync. */
  _runSync(args) {
    return spawnSync(this._dockerCmd[0], [...this._dockerCmd.slice(1), ...args], { encoding: 'utf8' });
  }

  _fallback(reason) {
    if (this._failOpen) {
      this._logger.warn && this._logger.warn(`[DockerWorkspace] fallback: ${reason}`);
      return {
        id: 'fallback', cwd: process.cwd(), release: async () => {},
        meta: { provider: 'docker', status: 'fallback', reason },
      };
    }
    throw new Error(`DockerWorkspace: ${reason}`);
  }

  _removeContainer(nameOrId) {
    return new Promise((resolve) => {
      const child = spawn(this._dockerCmd[0], [...this._dockerCmd.slice(1), 'rm', '-f', nameOrId]);
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
  }
}

function _slug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
}

module.exports = DockerWorkspace;
