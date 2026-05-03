'use strict';

const SSHWorkspace = require('../core/workspace/SSHWorkspace');

describe('SSHWorkspace (Fase 12.2)', () => {
  test('fallback si ssh2 no está disponible', async () => {
    const ws = new SSHWorkspace({
      host: 'nonexistent.local',
      username: 'x',
      password: 'y',
      logger: { warn: () => {} },
    });
    // Mock _loadSsh2 para forzar ausencia
    ws._loadSsh2 = () => null;
    const handle = await ws.acquire({ agentKey: 't' });
    expect(handle.id).toBe('fallback');
    expect(handle.meta.reason).toMatch(/ssh2 no instalado/);
  });

  test('fallback si no hay host', async () => {
    const ws = new SSHWorkspace({
      host: '',
      username: '',
      logger: { warn: () => {} },
    });
    ws._loadSsh2 = () => ({ Client: class {} }); // ssh2 "presente"
    const handle = await ws.acquire({ agentKey: 't' });
    expect(handle.id).toBe('fallback');
    expect(handle.meta.reason).toMatch(/HOST\/USER/);
  });

  test('fallback si connect falla', async () => {
    const FakeClient = class {
      constructor() { this._listeners = {}; }
      on(ev, fn) { this._listeners[ev] = fn; }
      connect() {
        setImmediate(() => this._listeners.error && this._listeners.error(new Error('auth failed')));
      }
      end() {}
    };
    const ws = new SSHWorkspace({
      host: 'h.local', username: 'u', password: 'p',
      logger: { warn: () => {} },
    });
    ws._loadSsh2 = () => ({ Client: FakeClient });
    const handle = await ws.acquire({ agentKey: 't' });
    expect(handle.id).toBe('fallback');
    expect(handle.meta.reason).toMatch(/conexi.n SSH/);
  });

  test('acquire → release con FakeClient exitoso', async () => {
    const FakeClient = class {
      constructor() { this._listeners = {}; }
      on(ev, fn) { this._listeners[ev] = fn; }
      connect() { setImmediate(() => this._listeners.ready && this._listeners.ready()); }
      exec(cmd, cb) {
        // Simular stream exitoso
        const stream = {
          _on: {}, stderr: { on(ev, fn) {} },
          on(ev, fn) { this._on[ev] = fn; setImmediate(() => { if (ev === 'close') fn(0); }); },
        };
        cb(null, stream);
      }
      end() { this.ended = true; }
    };
    const ws = new SSHWorkspace({
      host: 'h.local', username: 'u', password: 'p',
      logger: { warn: () => {} },
    });
    ws._loadSsh2 = () => ({ Client: FakeClient });
    const handle = await ws.acquire({ agentKey: 't' });
    expect(handle.id).not.toBe('fallback');
    expect(handle.meta.provider).toBe('ssh');
    expect(handle.cwd.startsWith('/tmp/clawmint/')).toBe(true);
    expect(ws.list()).toHaveLength(1);
    await handle.release();
    expect(ws.list()).toHaveLength(0);
  });

  test('failOpen=false throwea', async () => {
    const ws = new SSHWorkspace({
      host: '', username: '', failOpen: false,
      logger: { warn: () => {} },
    });
    ws._loadSsh2 = () => ({ Client: class {} });
    await expect(ws.acquire({ agentKey: 't' })).rejects.toThrow(/HOST\/USER/);
  });
});
