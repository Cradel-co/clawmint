'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const GitWorktreeWorkspace = require('../core/workspace/GitWorktreeWorkspace');

// Preflight: si no hay git disponible, skipear suite
const hasGit = spawnSync('git', ['--version']).status === 0;
const d = hasGit ? describe : describe.skip;

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwt-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

d('GitWorktreeWorkspace — construcción', () => {
  test('throw si no se pasa repoRoot', () => {
    expect(() => new GitWorktreeWorkspace({})).toThrow(/repoRoot/);
  });
});

d('GitWorktreeWorkspace — fail-open en non-git dir', () => {
  test('acquire en dir sin .git → retorna fallback con status=fallback', async () => {
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, failOpen: true,
      logger: { info: () => {}, warn: () => {} },
    });
    const h = await w.acquire({});
    expect(h.id).toBe('fallback');
    expect(h.cwd).toBe(tmpDir);
    expect(h.meta.status).toBe('fallback');
  });

  test('failOpen=false → throw', async () => {
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, failOpen: false,
      logger: { info: () => {}, warn: () => {} },
    });
    await expect(w.acquire({})).rejects.toThrow(/no es un repo git/);
  });
});

d('GitWorktreeWorkspace — acquire + release en repo real', () => {
  test('crea worktree y lo registra', async () => {
    initGitRepo(tmpDir);
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, logger: { info: () => {}, warn: () => {} },
    });
    const handle = await w.acquire({ agentKey: 'test-sub' });
    expect(handle.id).toMatch(/^test-sub-/);
    expect(fs.existsSync(handle.cwd)).toBe(true);
    expect(handle.meta.branch).toMatch(/^sub\//);
    expect(w.list()).toHaveLength(1);
    await handle.release();
    expect(w.list()).toHaveLength(0);
  });

  test('release es idempotente', async () => {
    initGitRepo(tmpDir);
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, logger: { info: () => {}, warn: () => {} },
    });
    const h = await w.acquire({});
    await h.release();
    await expect(h.release()).resolves.toBeUndefined();
  });

  test('touch() actualiza lastAccessAt', async () => {
    initGitRepo(tmpDir);
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, logger: { info: () => {}, warn: () => {} },
    });
    const h = await w.acquire({});
    const before = w.list()[0].lastAccessAt;
    await new Promise(r => setTimeout(r, 10));
    w.touch(h.id);
    const after = w.list()[0].lastAccessAt;
    expect(after).toBeGreaterThan(before);
    await h.release();
  });

  test('gc purga worktrees idle', async () => {
    initGitRepo(tmpDir);
    const w = new GitWorktreeWorkspace({
      repoRoot: tmpDir, logger: { info: () => {}, warn: () => {} },
    });
    const h = await w.acquire({});
    // Backdate manualmente
    const entry = w._active.get(h.id);
    entry.lastAccessAt = Date.now() - (48 * 60 * 60 * 1000);
    const purged = await w.gc(24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(w.list()).toHaveLength(0);
    await h.release(); // idempotente
  });
});
