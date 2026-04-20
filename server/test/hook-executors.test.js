'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const JsExecutor    = require('../hooks/executors/jsExecutor');
const ShellExecutor = require('../hooks/executors/shellExecutor');
const HttpExecutor  = require('../hooks/executors/httpExecutor');

// ── JsExecutor ─────────────────────────────────────────────────────────

describe('JsExecutor', () => {
  test('ejecuta función directa en handlerRef', async () => {
    const ex = new JsExecutor();
    const r = await ex.execute({ handlerRef: async () => ({ block: 'test' }) }, {});
    expect(r).toEqual({ block: 'test' });
  });

  test('ejecuta función registrada por nombre', async () => {
    const ex = new JsExecutor();
    ex.registerHandler('my_rule', async () => ({ replace: { args: { x: 1 } } }));
    const r = await ex.execute({ handlerRef: 'my_rule' }, {});
    expect(r).toEqual({ replace: { args: { x: 1 } } });
  });

  test('throw si handlerRef no resuelve', async () => {
    const ex = new JsExecutor();
    await expect(ex.execute({ handlerRef: 'unknown' }, {})).rejects.toThrow(/no resuelto/);
  });

  test('passes payload al handler', async () => {
    const ex = new JsExecutor();
    let observed = null;
    const r = await ex.execute({ handlerRef: (p) => { observed = p; return null; } }, { x: 1 });
    expect(observed).toEqual({ x: 1 });
    expect(r).toBeNull();
  });

  test('registerHandler valida que sea función', () => {
    const ex = new JsExecutor();
    expect(() => ex.registerHandler('x', 'not a fn')).toThrow(/función/);
  });
});

// ── ShellExecutor ──────────────────────────────────────────────────────

describe('ShellExecutor', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-shell-'));
  });
  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const IS_WIN = process.platform === 'win32';

  test('validación: handlerRef requerido', async () => {
    const ex = new ShellExecutor();
    await expect(ex.execute({ handlerRef: '' }, {})).rejects.toThrow(/requerido/);
  });

  test('validación: path absoluto', async () => {
    const ex = new ShellExecutor();
    await expect(ex.execute({ handlerRef: 'relative/path' }, {})).rejects.toThrow(/absoluto/);
  });

  test('allowedRoot enforcement', async () => {
    const ex = new ShellExecutor({ allowedRoot: path.join(tmpDir, 'allowed') });
    fs.mkdirSync(path.join(tmpDir, 'evil'), { recursive: true });
    const outside = path.join(tmpDir, 'evil', 'script.sh');
    fs.writeFileSync(outside, '#!/bin/sh\necho "{}"');
    fs.chmodSync(outside, 0o755);
    await expect(ex.execute({ handlerRef: outside }, {})).rejects.toThrow(/fuera del root/);
  });

  (IS_WIN ? test.skip : test)('script que devuelve { block } parseado correctamente', async () => {
    const scriptPath = path.join(tmpDir, 'block.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\nread payload\necho \'{"block":"denied by script"}\'');
    fs.chmodSync(scriptPath, 0o755);
    const ex = new ShellExecutor();
    const r = await ex.execute({ handlerRef: scriptPath, timeoutMs: 5000 }, { x: 1 });
    expect(r).toEqual({ block: 'denied by script' });
  });

  (IS_WIN ? test.skip : test)('script sin stdout retorna null (no intervention)', async () => {
    const scriptPath = path.join(tmpDir, 'silent.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\nread payload\nexit 0');
    fs.chmodSync(scriptPath, 0o755);
    const ex = new ShellExecutor();
    const r = await ex.execute({ handlerRef: scriptPath, timeoutMs: 5000 }, {});
    expect(r).toBeNull();
  });

  (IS_WIN ? test.skip : test)('script con exit != 0 → error', async () => {
    const scriptPath = path.join(tmpDir, 'fail.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\nread payload\necho "stderr msg" >&2\nexit 2');
    fs.chmodSync(scriptPath, 0o755);
    const ex = new ShellExecutor();
    await expect(ex.execute({ handlerRef: scriptPath, timeoutMs: 5000 }, {})).rejects.toThrow(/exit 2/);
  });

  test('_validateResult filtra campos', () => {
    const { _validateResult } = ShellExecutor._internal;
    expect(_validateResult(null)).toBeNull();
    expect(_validateResult({ block: 'x', other: 'ignored' })).toEqual({ block: 'x' });
    expect(_validateResult({ replace: { args: { a: 1 } } })).toEqual({ replace: { args: { a: 1 } } });
    expect(_validateResult({ replace: 'invalid' })).toEqual({});
  });
});

// ── HttpExecutor ───────────────────────────────────────────────────────

describe('HttpExecutor', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test('validación: handlerRef requerido', async () => {
    const ex = new HttpExecutor();
    await expect(ex.execute({ handlerRef: '' }, {})).rejects.toThrow(/requerido/);
  });

  test('SSRF guard bloquea localhost', async () => {
    const ex = new HttpExecutor();
    await expect(ex.execute({ handlerRef: 'http://localhost/hook' }, {})).rejects.toThrow(/URL inválida/);
  });

  test('SSRF guard bloquea 10.x', async () => {
    const ex = new HttpExecutor();
    await expect(ex.execute({ handlerRef: 'http://10.0.0.1/' }, {})).rejects.toThrow(/URL inválida/);
  });

  test('response 200 con JSON válido parseado', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200,
      text: async () => '{"block":"by http"}',
    }));
    const ex = new HttpExecutor();
    const r = await ex.execute({ handlerRef: 'https://hooks.example.com/pre', timeoutMs: 1000 }, {});
    expect(r).toEqual({ block: 'by http' });
  });

  test('response !ok → error', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: false, status: 500, statusText: 'Server Error',
    }));
    const ex = new HttpExecutor();
    await expect(ex.execute({ handlerRef: 'https://example.com/hook' }, {})).rejects.toThrow(/HTTP 500/);
  });

  test('body vacío retorna null (sin intervención)', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200,
      text: async () => '',
    }));
    const ex = new HttpExecutor();
    const r = await ex.execute({ handlerRef: 'https://example.com/hook' }, {});
    expect(r).toBeNull();
  });

  test('body no-JSON → error', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true, status: 200,
      text: async () => 'not json',
    }));
    const ex = new HttpExecutor();
    await expect(ex.execute({ handlerRef: 'https://example.com/hook' }, {})).rejects.toThrow(/JSON/);
  });

  test('headers por default se incluyen', async () => {
    let observed = null;
    global.fetch = jest.fn((u, init) => {
      observed = init;
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
    });
    const ex = new HttpExecutor({ defaultHeaders: { 'Authorization': 'Bearer token-x' } });
    await ex.execute({ handlerRef: 'https://example.com/hook' }, {});
    expect(observed.headers['Authorization']).toBe('Bearer token-x');
    expect(observed.headers['Content-Type']).toBe('application/json');
  });

  test('body POST incluye event + payload + ctx', async () => {
    let observed = null;
    global.fetch = jest.fn((u, init) => {
      observed = init;
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
    });
    const ex = new HttpExecutor();
    await ex.execute(
      { event: 'pre_tool_use', handlerRef: 'https://example.com/hook' },
      { name: 'bash', args: { command: 'ls' } },
      { ctx: { userId: 'u1' } }
    );
    const parsed = JSON.parse(observed.body);
    expect(parsed.event).toBe('pre_tool_use');
    expect(parsed.payload.name).toBe('bash');
    expect(parsed.ctx.userId).toBe('u1');
  });
});
