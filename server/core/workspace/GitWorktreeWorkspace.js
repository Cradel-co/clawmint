'use strict';

/**
 * GitWorktreeWorkspace — aislamiento via `git worktree`.
 *
 * Cada llamada a `acquire` crea un worktree nuevo en
 * `<root>/.worktrees/<agentId>-<timestamp>` en una branch `sub/<agentId>-<timestamp>`.
 *
 * `release()`:
 *   1. `git worktree remove --force <path>` — limpia el worktree
 *   2. opcionalmente `git branch -D sub/<name>` si el subagente no mergeó
 *
 * GC: tracking in-memory + hook `scheduler.js` para purgar worktrees > 24h de inactividad.
 *
 * Alias opaco: el subagente recibe `cwd = <path>` pero el system prompt puede
 * referir a un alias `$WORKSPACE` — resolución se hace afuera (LoopRunner).
 *
 * Fail-open: si git no está instalado o el repo base no es git, retorna `cwd` actual
 * con warning.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const WorkspaceProvider = require('./WorkspaceProvider');

class GitWorktreeWorkspace extends WorkspaceProvider {
  /**
   * @param {object} opts
   * @param {string} opts.repoRoot           — raíz del repo git (debe tener `.git`)
   * @param {string} [opts.worktreesDir]     — default: `<repoRoot>/.worktrees`
   * @param {string} [opts.baseBranch]       — default: branch actual del repo
   * @param {object} [opts.logger]
   * @param {boolean} [opts.failOpen=true]   — si git falla, retornar NullWorkspace-like
   */
  constructor({ repoRoot, worktreesDir, baseBranch, logger = console, failOpen = true } = {}) {
    super();
    if (!repoRoot) throw new Error('GitWorktreeWorkspace: repoRoot requerido');
    this._repoRoot = repoRoot;
    this._worktreesDir = worktreesDir || path.join(repoRoot, '.worktrees');
    this._baseBranch = baseBranch || null;
    this._logger = logger;
    this._failOpen = failOpen;
    /** @type {Map<string, { path: string, branch: string, createdAt: number, lastAccessAt: number }>} */
    this._active = new Map();
  }

  async acquire(ctx = {}) {
    if (!this._isGitRepo()) {
      if (this._failOpen) {
        this._logger.warn && this._logger.warn(`[GitWorktreeWorkspace] ${this._repoRoot} no es un repo git — fallback a cwd actual`);
        return { id: 'fallback', cwd: this._repoRoot, release: async () => {}, meta: { provider: 'git-worktree', status: 'fallback' } };
      }
      throw new Error(`${this._repoRoot} no es un repo git`);
    }

    const agentSlug = _slug(ctx.agentKey || ctx.agentId || 'sub');
    const id = `${agentSlug}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const worktreePath = path.join(this._worktreesDir, id);
    const branch = `sub/${id}`;
    const base = ctx.baseBranch || this._baseBranch || this._detectBaseBranch();

    fs.mkdirSync(this._worktreesDir, { recursive: true });

    const res = spawnSync('git', ['worktree', 'add', '-b', branch, worktreePath, base], {
      cwd: this._repoRoot, encoding: 'utf8',
    });
    if (res.status !== 0) {
      const msg = (res.stderr || '').slice(0, 300);
      if (this._failOpen) {
        this._logger.warn && this._logger.warn(`[GitWorktreeWorkspace] worktree add falló (${msg.trim()}) — fallback`);
        return { id: 'fallback', cwd: this._repoRoot, release: async () => {}, meta: { provider: 'git-worktree', status: 'fallback', error: msg } };
      }
      throw new Error(`git worktree add falló: ${msg}`);
    }

    const now = Date.now();
    this._active.set(id, { path: worktreePath, branch, createdAt: now, lastAccessAt: now });

    const self = this;
    const release = async () => {
      const entry = self._active.get(id);
      if (!entry) return; // ya liberado
      try {
        await self._removeWorktree(entry.path, entry.branch);
      } catch (err) {
        self._logger.warn && self._logger.warn(`[GitWorktreeWorkspace] release ${id} falló: ${err.message}`);
      }
      self._active.delete(id);
    };

    return {
      id, cwd: worktreePath, release,
      meta: { provider: 'git-worktree', branch, base },
    };
  }

  /** GC: libera worktrees con >idleMs sin acceso. Usado por scheduler. */
  async gc(idleMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const toPurge = [];
    for (const [id, entry] of this._active) {
      if (now - entry.lastAccessAt > idleMs) toPurge.push({ id, entry });
    }
    for (const { id, entry } of toPurge) {
      try { await this._removeWorktree(entry.path, entry.branch); }
      catch (err) { this._logger.warn && this._logger.warn(`[GC] ${id} falló: ${err.message}`); }
      this._active.delete(id);
    }
    return toPurge.length;
  }

  /** Lista worktrees activos tracked por esta instancia. */
  list() {
    return Array.from(this._active.entries()).map(([id, e]) => ({
      id, path: e.path, branch: e.branch, createdAt: e.createdAt, lastAccessAt: e.lastAccessAt,
    }));
  }

  touch(id) {
    const e = this._active.get(id);
    if (e) e.lastAccessAt = Date.now();
  }

  // ── Internos ────────────────────────────────────────────────────────

  _isGitRepo() {
    try { return fs.statSync(path.join(this._repoRoot, '.git')).isDirectory() || fs.statSync(path.join(this._repoRoot, '.git')).isFile(); }
    catch { return false; }
  }

  _detectBaseBranch() {
    const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this._repoRoot, encoding: 'utf8' });
    return (res.status === 0 ? res.stdout.trim() : 'main') || 'main';
  }

  _removeWorktree(worktreePath, branch) {
    return new Promise((resolve) => {
      const child = spawn('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this._repoRoot });
      child.on('close', () => {
        // Intentar borrar la branch también (best-effort)
        if (branch) {
          const bRes = spawnSync('git', ['branch', '-D', branch], { cwd: this._repoRoot });
          void bRes;
        }
        // Cleanup defensivo del dir si quedó
        try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
        resolve();
      });
      child.on('error', () => resolve());
    });
  }
}

function _slug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
}

module.exports = GitWorktreeWorkspace;
