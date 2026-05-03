'use strict';

const LSPServerManager = require('../services/LSPServerManager');

function fakeClient() {
  return {
    start: jest.fn().mockResolvedValue(),
    request: jest.fn().mockResolvedValue({ ok: true }),
    didOpen: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(),
  };
}

describe('LSPServerManager (Fase 10)', () => {
  test('resolveLanguage por extensión', () => {
    const m = new LSPServerManager({});
    expect(m.resolveLanguage('/foo/bar.ts')).toBe('ts');
    expect(m.resolveLanguage('/foo/bar.tsx')).toBe('ts');
    expect(m.resolveLanguage('/foo/bar.py')).toBe('py');
    expect(m.resolveLanguage('/foo/bar.rs')).toBe('rust');
    expect(m.resolveLanguage('/foo/bar.xyz')).toBeNull();
    expect(m.resolveLanguage(null)).toBeNull();
  });

  test('getClientForFile retorna null si extensión desconocida', async () => {
    const m = new LSPServerManager({ clientFactory: () => fakeClient() });
    const r = await m.getClientForFile({ filePath: '/foo/unknown.xyz', workspaceRoot: '/tmp' });
    expect(r).toBeNull();
  });

  test('getClientForFile crea y reutiliza cliente por (workspace, lang)', async () => {
    const factory = jest.fn(() => fakeClient());
    const m = new LSPServerManager({ clientFactory: factory });
    const c1 = await m.getClientForFile({ filePath: '/foo/a.ts', workspaceRoot: '/ws1' });
    const c2 = await m.getClientForFile({ filePath: '/foo/b.ts', workspaceRoot: '/ws1' });
    expect(c1).toBe(c2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('getClientForFile crea cliente nuevo por workspace distinto', async () => {
    const factory = jest.fn(() => fakeClient());
    const m = new LSPServerManager({ clientFactory: factory });
    await m.getClientForFile({ filePath: '/foo/a.ts', workspaceRoot: '/ws1' });
    await m.getClientForFile({ filePath: '/foo/a.ts', workspaceRoot: '/ws2' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('getClientForFile limpia del pool si start falla', async () => {
    const bad = fakeClient();
    bad.start = jest.fn().mockRejectedValue(new Error('server missing'));
    const factory = jest.fn(() => bad);
    const m = new LSPServerManager({ clientFactory: factory });
    await expect(m.getClientForFile({ filePath: '/x.ts', workspaceRoot: '/ws' })).rejects.toThrow(/server missing/);
    // Retry debería crear uno nuevo
    const good = fakeClient();
    factory.mockReturnValueOnce(good);
    await m.getClientForFile({ filePath: '/x.ts', workspaceRoot: '/ws' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('request() retorna {unsupported:true} si no hay server para la extensión', async () => {
    const m = new LSPServerManager({ clientFactory: () => fakeClient() });
    const r = await m.request({
      filePath: '/foo.xyz',
      workspaceRoot: '/ws',
      method: 'textDocument/hover',
    });
    expect(r.unsupported).toBe(true);
  });

  test('request() llama didOpen y client.request', async () => {
    const fc = fakeClient();
    fc.request = jest.fn().mockResolvedValue({ contents: 'docs' });
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
    const file = path.join(dir, 'x.ts');
    fs.writeFileSync(file, 'const x = 1;');

    const m = new LSPServerManager({ clientFactory: () => fc });
    const r = await m.request({
      filePath: file, workspaceRoot: dir, method: 'textDocument/hover',
      paramsBuilder: () => ({ foo: 'bar' }),
    });
    expect(r.contents).toBe('docs');
    expect(fc.didOpen).toHaveBeenCalled();
    expect(fc.request).toHaveBeenCalledWith('textDocument/hover', { foo: 'bar' });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('list() retorna workspaces + lenguajes activos', async () => {
    const m = new LSPServerManager({ clientFactory: () => fakeClient() });
    await m.getClientForFile({ filePath: '/a.ts', workspaceRoot: '/ws1' });
    await m.getClientForFile({ filePath: '/a.py', workspaceRoot: '/ws1' });
    const list = m.list();
    expect(list).toHaveLength(1);
    expect(list[0].workspaceRoot).toBe('/ws1');
    expect(list[0].languages.sort()).toEqual(['py', 'ts']);
  });

  test('shutdown() apaga todos los clientes', async () => {
    const c1 = fakeClient();
    const c2 = fakeClient();
    const clients = [c1, c2];
    const m = new LSPServerManager({ clientFactory: () => clients.shift() });
    await m.getClientForFile({ filePath: '/a.ts', workspaceRoot: '/ws1' });
    await m.getClientForFile({ filePath: '/b.ts', workspaceRoot: '/ws2' });
    await m.shutdown();
    expect(c1.shutdown).toHaveBeenCalled();
    expect(c2.shutdown).toHaveBeenCalled();
    expect(m.list()).toHaveLength(0);
  });
});
