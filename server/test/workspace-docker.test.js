'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const DockerWorkspace = require('../core/workspace/DockerWorkspace');

// Mock sintético: usamos un binario falso que simula docker vía shim script.
// Como no queremos depender de docker real en CI, creamos un command que:
// - `--version` → exit 0 si TEST_DOCKER_AVAILABLE=true
// - `run ...`   → imprime un container id simulado (sha256:...) y exit 0
// - `rm -f ...` → exit 0

describe('DockerWorkspace (Fase 12.2)', () => {
  test('fallback cuando docker no está disponible', async () => {
    const ws = new DockerWorkspace({
      dockerCmd: ['nonexistent-docker-binary-xyz'],
      logger: { warn: () => {} },
    });
    const handle = await ws.acquire({ agentKey: 'test' });
    expect(handle.id).toBe('fallback');
    expect(handle.meta.status).toBe('fallback');
    await handle.release(); // no-op seguro
  });

  test('fallback si imagen no existe (docker run falla)', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const ws = new DockerWorkspace({ dockerCmd: ['docker'], workDir, logger: { warn: () => {} } });
    ws._dockerAvailable = () => true;
    ws._runSync = (args) => {
      if (args[0] === 'run') return { status: 1, stderr: 'image not found' };
      return { status: 0, stdout: '' };
    };
    const handle = await ws.acquire({ agentKey: 'test' });
    expect(handle.id).toBe('fallback');
    expect(handle.meta.status).toBe('fallback');
    expect(handle.meta.reason).toMatch(/docker run fall/);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  test('acquire → release con mock exitoso', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const ws = new DockerWorkspace({ dockerCmd: ['docker'], workDir, logger: { warn: () => {} } });
    ws._dockerAvailable = () => true;
    ws._removeContainer = async () => {};
    ws._runSync = (args) => {
      if (args[0] === 'run') return { status: 0, stdout: 'abc123containerid\n' };
      return { status: 0, stdout: '' };
    };
    const handle = await ws.acquire({ agentKey: 'test' });
    expect(handle.id).not.toBe('fallback');
    expect(handle.cwd.startsWith(workDir)).toBe(true);
    expect(handle.meta.containerId).toContain('abc123');
    expect(fs.existsSync(handle.cwd)).toBe(true);
    expect(ws.list()).toHaveLength(1);
    await handle.release();
    expect(ws.list()).toHaveLength(0);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  test('gc purga workspaces idle', async () => {
    const ws = new DockerWorkspace({
      dockerCmd: ['nonexistent-xyz'], // forzar fallback en acquire
      logger: { warn: () => {} },
    });
    // Simular entries directamente
    ws._active.set('a', { containerId: 'x', containerName: 'c-a', hostPath: '/tmp/a', createdAt: 0, lastAccessAt: 0 });
    ws._active.set('b', { containerId: 'y', containerName: 'c-b', hostPath: '/tmp/b', createdAt: Date.now(), lastAccessAt: Date.now() });
    const purged = await ws.gc(1000);
    expect(purged).toBe(1);
    expect(ws._active.has('a')).toBe(false);
    expect(ws._active.has('b')).toBe(true);
  });

  test('touch actualiza lastAccessAt', () => {
    const ws = new DockerWorkspace({ dockerCmd: ['x'] });
    const past = Date.now() - 10000;
    ws._active.set('a', { containerId: 'x', containerName: 'c', hostPath: '/tmp/a', createdAt: past, lastAccessAt: past });
    ws.touch('a');
    expect(ws._active.get('a').lastAccessAt).toBeGreaterThan(past);
  });

  test('failOpen=false throwea si docker falla', async () => {
    const ws = new DockerWorkspace({
      dockerCmd: ['nonexistent-xyz'],
      failOpen: false,
      logger: { warn: () => {} },
    });
    await expect(ws.acquire({ agentKey: 't' })).rejects.toThrow(/docker no disponible/);
  });
});
