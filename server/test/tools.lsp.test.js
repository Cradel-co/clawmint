'use strict';

const lspTools = require('../mcp/tools/lsp');

const [
  LSP_GO_TO_DEFINITION,
  LSP_FIND_REFERENCES,
  LSP_HOVER,
  LSP_DOCUMENT_SYMBOLS,
  LSP_WORKSPACE_SYMBOLS,
  LSP_DIAGNOSTICS,
] = lspTools;

function fakeMgr(resultByMethod) {
  return {
    request: jest.fn(async ({ method, paramsBuilder }) => {
      const params = paramsBuilder ? paramsBuilder() : {};
      const key = method in resultByMethod ? method : '_default';
      const value = resultByMethod[key];
      if (typeof value === 'function') return value(params);
      return value;
    }),
  };
}

describe('mcp/tools/lsp (Fase 10)', () => {
  afterEach(() => { delete process.env.LSP_ENABLED; });

  test('export de las 6 tools con los nombres esperados', () => {
    expect(lspTools.map(t => t.name).sort()).toEqual([
      'lsp_diagnostics', 'lsp_document_symbols', 'lsp_find_references',
      'lsp_go_to_definition', 'lsp_hover', 'lsp_workspace_symbols',
    ]);
  });

  test('todas retornan disabled con LSP_ENABLED=false', async () => {
    delete process.env.LSP_ENABLED;
    const ctx = { lspServerManager: fakeMgr({}) };
    for (const t of lspTools) {
      const r = await t.execute({ file: '/x.ts', line: 0, character: 0, query: 'q' }, ctx);
      expect(r).toContain('LSP no está habilitado');
    }
  });

  test('con LSP_ENABLED=true y sin manager → error', async () => {
    process.env.LSP_ENABLED = 'true';
    const r = await LSP_HOVER.execute({ file: '/x.ts', line: 0, character: 0 }, {});
    expect(r).toContain('LSPServerManager no disponible');
  });

  test('lsp_go_to_definition formatea locations', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = fakeMgr({
      'textDocument/definition': {
        uri: 'file:///foo.ts',
        range: { start: { line: 9, character: 3 }, end: { line: 9, character: 10 } },
      },
    });
    const r = await LSP_GO_TO_DEFINITION.execute({ file: '/foo.ts', line: 0, character: 0 }, { lspServerManager: mgr });
    expect(r).toContain('file:///foo.ts');
    expect(r).toContain('10:4'); // 1-indexed
  });

  test('lsp_find_references pasa includeDeclaration=true', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = fakeMgr({
      'textDocument/references': [
        { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 } } },
        { uri: 'file:///b.ts', range: { start: { line: 1, character: 2 } } },
      ],
    });
    const r = await LSP_FIND_REFERENCES.execute({ file: '/a.ts', line: 0, character: 0 }, { lspServerManager: mgr });
    expect(r).toContain('file:///a.ts');
    expect(r).toContain('file:///b.ts');
    const call = mgr.request.mock.calls[0][0];
    const params = call.paramsBuilder();
    expect(params.context.includeDeclaration).toBe(true);
  });

  test('lsp_hover formatea contents variantes', async () => {
    process.env.LSP_ENABLED = 'true';
    const cases = [
      { in: { contents: 'string simple' }, out: 'string simple' },
      { in: { contents: { value: 'markdown' } }, out: 'markdown' },
      { in: { contents: ['a', 'b'] }, out: 'a\nb' },
      { in: null, out: '(sin hover)' },
    ];
    for (const c of cases) {
      const mgr = fakeMgr({ 'textDocument/hover': c.in });
      const r = await LSP_HOVER.execute({ file: '/x.ts', line: 0, character: 0 }, { lspServerManager: mgr });
      expect(r).toBe(c.out);
    }
  });

  test('lsp_document_symbols formatea lista', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = fakeMgr({
      'textDocument/documentSymbol': [
        { name: 'foo', location: { uri: 'file:///x.ts', range: { start: { line: 0, character: 0 } } } },
        { name: 'bar', location: { uri: 'file:///x.ts', range: { start: { line: 4, character: 0 } } } },
      ],
    });
    const r = await LSP_DOCUMENT_SYMBOLS.execute({ file: '/x.ts' }, { lspServerManager: mgr });
    expect(r).toContain('foo');
    expect(r).toContain('bar');
    expect(r).toContain(':5'); // line 4 → 1-indexed 5
  });

  test('lsp_workspace_symbols requiere query', async () => {
    process.env.LSP_ENABLED = 'true';
    const r = await LSP_WORKSPACE_SYMBOLS.execute({}, { lspServerManager: fakeMgr({}) });
    expect(r).toContain('query requerido');
  });

  test('lsp_diagnostics lista items con severity', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = fakeMgr({
      'textDocument/diagnostic': {
        items: [
          { severity: 1, message: 'Type error', range: { start: { line: 2, character: 4 } } },
          { severity: 2, message: 'Unused var', range: { start: { line: 10, character: 0 } } },
        ],
      },
    });
    const r = await LSP_DIAGNOSTICS.execute({ file: '/x.ts' }, { lspServerManager: mgr });
    expect(r).toContain('error');
    expect(r).toContain('Type error');
    expect(r).toContain('warning');
    expect(r).toContain('Unused var');
  });

  test('lsp_diagnostics sin items retorna mensaje vacío', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = fakeMgr({ 'textDocument/diagnostic': { items: [] } });
    const r = await LSP_DIAGNOSTICS.execute({ file: '/x.ts' }, { lspServerManager: mgr });
    expect(r).toBe('(sin diagnósticos)');
  });

  test('lsp_go_to_definition con file faltante retorna error', async () => {
    process.env.LSP_ENABLED = 'true';
    const r = await LSP_GO_TO_DEFINITION.execute({ line: 0, character: 0 }, { lspServerManager: fakeMgr({}) });
    expect(r).toContain('file requerido');
  });

  test('manager.request throw → tool captura y retorna string de error', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = { request: jest.fn().mockRejectedValue(new Error('binary not found')) };
    const r = await LSP_HOVER.execute({ file: '/x.ts', line: 0, character: 0 }, { lspServerManager: mgr });
    expect(r).toContain('Error LSP');
    expect(r).toContain('binary not found');
  });

  test('manager.request retorna unsupported → tool devuelve error legible', async () => {
    process.env.LSP_ENABLED = 'true';
    const mgr = { request: jest.fn().mockResolvedValue({ unsupported: true }) };
    const r = await LSP_HOVER.execute({ file: '/x.xyz', line: 0, character: 0 }, { lspServerManager: mgr });
    expect(r).toContain('no hay language server');
    expect(r).toContain('.xyz');
  });
});
