'use strict';

const LSPServerManager = require('../services/LSPServerManager');
const lspTools = require('../mcp/tools/lsp');

const [LSP_GO_TO_DEFINITION, , LSP_HOVER, LSP_DOCUMENT_SYMBOLS, , LSP_DIAGNOSTICS] = lspTools;

describe('LSPServerManager fail-open dinámico (parked 10 → cerrado)', () => {
  test('detectAvailableServers cachea resultado por langKey', async () => {
    const calls = [];
    const detect = (cmd) => { calls.push(cmd); return cmd === 'typescript-language-server'; };
    const m = new LSPServerManager({ detectImpl: detect });
    const r1 = await m.detectAvailableServers();
    expect(r1.ts).toBe(true);
    expect(r1.py).toBe(false);
    const sizeAfterFirst = calls.length;

    // Segunda llamada sin force → no re-ejecuta detect
    await m.detectAvailableServers();
    expect(calls.length).toBe(sizeAfterFirst);

    // Con force=true → re-ejecuta
    await m.detectAvailableServers({ force: true });
    expect(calls.length).toBeGreaterThan(sizeAfterFirst);
  });

  test('isAvailable retorna bool sólo si se detectó', async () => {
    const m = new LSPServerManager({ detectImpl: (c) => c === 'typescript-language-server' });
    expect(m.isAvailable('ts')).toBe(false); // antes de detect
    await m.detectAvailableServers();
    expect(m.isAvailable('ts')).toBe(true);
    expect(m.isAvailable('py')).toBe(false);
  });

  test('isAvailableForFile resuelve lang + disponibilidad', async () => {
    const m = new LSPServerManager({ detectImpl: (c) => c === 'typescript-language-server' });
    await m.detectAvailableServers();
    expect(m.isAvailableForFile('/x.ts')).toEqual({ language: 'ts', available: true });
    expect(m.isAvailableForFile('/x.py')).toEqual({ language: 'py', available: false });
    expect(m.isAvailableForFile('/x.xyz')).toEqual({ language: null, available: false });
  });

  test('listServers reporta available post-detect', async () => {
    const m = new LSPServerManager({ detectImpl: (c) => c === 'typescript-language-server' });
    await m.detectAvailableServers();
    const list = m.listServers();
    const ts = list.find(x => x.language === 'ts');
    const py = list.find(x => x.language === 'py');
    expect(ts.available).toBe(true);
    expect(py.available).toBe(false);
  });

  test('tool lsp_hover devuelve mensaje claro si lang no disponible', async () => {
    process.env.LSP_ENABLED = 'true';
    const m = new LSPServerManager({ detectImpl: () => false });
    await m.detectAvailableServers();
    const r = await LSP_HOVER.execute({ file: '/x.ts', line: 0, character: 0 }, { lspServerManager: m });
    expect(r).toContain('no está instalado');
    expect(r).toContain('ts');
    delete process.env.LSP_ENABLED;
  });

  test('tool lsp_go_to_definition con lang disponible no corta por fail-open', async () => {
    process.env.LSP_ENABLED = 'true';
    const m = new LSPServerManager({ detectImpl: () => true });
    await m.detectAvailableServers();
    // Stub request para no spawnear LSP real
    m.request = async () => ({ uri: 'file:///x.ts', range: { start: { line: 0, character: 0 } } });
    const r = await LSP_GO_TO_DEFINITION.execute({ file: '/x.ts', line: 0, character: 0 }, { lspServerManager: m });
    expect(r).toContain('file:///x.ts');
    delete process.env.LSP_ENABLED;
  });

  test('tool lsp_document_symbols respeta fail-open', async () => {
    process.env.LSP_ENABLED = 'true';
    const m = new LSPServerManager({ detectImpl: () => false });
    await m.detectAvailableServers();
    const r = await LSP_DOCUMENT_SYMBOLS.execute({ file: '/x.py' }, { lspServerManager: m });
    expect(r).toContain('no está instalado');
    delete process.env.LSP_ENABLED;
  });

  test('tool lsp_diagnostics respeta fail-open', async () => {
    process.env.LSP_ENABLED = 'true';
    const m = new LSPServerManager({ detectImpl: () => false });
    await m.detectAvailableServers();
    const r = await LSP_DIAGNOSTICS.execute({ file: '/x.rs' }, { lspServerManager: m });
    expect(r).toContain('no está instalado');
    delete process.env.LSP_ENABLED;
  });
});
