'use strict';

const ToolCatalog = require('../core/ToolCatalog');
const catalogTools = require('../mcp/tools/catalog');

function byName(n) { return catalogTools.find(t => t.name === n); }

function mkTool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

const tools40 = Array.from({ length: 40 }, (_, i) =>
  mkTool(`tool_${i}`, `descripcion de tool ${i}`, { type: 'object', properties: { x: { type: 'string' } } })
);
tools40.push(mkTool('read_file', 'lee archivo', { type: 'object' }));
tools40.push(mkTool('bash', 'ejecuta bash', { type: 'object' }));

describe('ToolCatalog — modo off (default)', () => {
  beforeEach(() => { delete process.env.LAZY_TOOLS_ENABLED; });

  test('getPromptTools devuelve schema completo para TODAS las tools', () => {
    const cat = new ToolCatalog({ tools: tools40 });
    const metas = cat.getPromptTools();
    expect(metas).toHaveLength(tools40.length);
    for (const m of metas) {
      expect(m.inputSchema).toBeDefined();
    }
  });

  test('isLoaded retorna true para cualquier tool (lazy off)', () => {
    const cat = new ToolCatalog({ tools: tools40 });
    expect(cat.isLoaded('tool_5')).toBe(true);
  });
});

describe('ToolCatalog — modo on (lazy activo)', () => {
  test('solo alwaysVisible incluyen inputSchema; el resto solo metadata', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on', alwaysVisible: ['read_file', 'bash'] });
    const metas = cat.getPromptTools();
    const readFile = metas.find(m => m.name === 'read_file');
    const tool5 = metas.find(m => m.name === 'tool_5');
    expect(readFile.inputSchema).toBeDefined();
    expect(tool5.inputSchema).toBeUndefined();
  });

  test('isLoaded false para tools no-visibles antes de load', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on', alwaysVisible: ['read_file'] });
    expect(cat.isLoaded('tool_5', 'sess1')).toBe(false);
    expect(cat.isLoaded('read_file', 'sess1')).toBe(true);
  });

  test('load() agrega tools al cache de sesión → isLoaded true', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on', alwaysVisible: [] });
    cat.load(['tool_5', 'tool_10'], 'sess1');
    expect(cat.isLoaded('tool_5', 'sess1')).toBe(true);
    expect(cat.isLoaded('tool_10', 'sess1')).toBe(true);
    expect(cat.isLoaded('tool_5', 'sess2')).toBe(false); // aislado por sesión
  });

  test('load() con name inexistente devuelve error', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    const r = cat.load(['nonexistent'], 'sess1');
    expect(r[0].error).toBe('not_found');
  });

  test('agentDef.alwaysVisibleTools extiende la visibilidad', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on', alwaysVisible: ['read_file'] });
    const agentDef = { alwaysVisibleTools: ['tool_3', 'tool_4'] };
    const metas = cat.getPromptTools(agentDef);
    const tool3 = metas.find(m => m.name === 'tool_3');
    expect(tool3.inputSchema).toBeDefined();
  });

  test('search() por substring en name o description', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    const hits = cat.search('tool_1', 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.name.includes('tool_1') || h.description.includes('tool_1'))).toBe(true);
  });

  test('search() respeta limit', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    expect(cat.search('tool', 3).length).toBe(3);
  });

  test('search() sin hits → array vacío', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    expect(cat.search('xyzzy-no-match', 10)).toEqual([]);
  });

  test('resetSession limpia el cache de una sesión', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    cat.load(['tool_5'], 'sessA');
    expect(cat.isLoaded('tool_5', 'sessA')).toBe(true);
    cat.resetSession('sessA');
    expect(cat.isLoaded('tool_5', 'sessA')).toBe(false);
  });
});

describe('ToolCatalog — env LAZY_TOOLS_ENABLED', () => {
  test('LAZY_TOOLS_ENABLED=true activa modo on', () => {
    const orig = process.env.LAZY_TOOLS_ENABLED;
    process.env.LAZY_TOOLS_ENABLED = 'true';
    const cat = new ToolCatalog({ tools: tools40 });
    expect(cat.mode).toBe('on');
    process.env.LAZY_TOOLS_ENABLED = orig;
  });

  test('default es "off"', () => {
    delete process.env.LAZY_TOOLS_ENABLED;
    const cat = new ToolCatalog({ tools: tools40 });
    expect(cat.mode).toBe('off');
  });
});

describe('mcp/tools/catalog — tool_search y tool_load', () => {
  test('tool_search sin toolCatalog en ctx → error', () => {
    expect(byName('tool_search').execute({ query: 'x' }, {})).toMatch(/toolCatalog no disponible/);
  });

  test('tool_search sin query → error', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    expect(byName('tool_search').execute({}, { toolCatalog: cat })).toMatch(/query requerido/);
  });

  test('tool_search devuelve resultados formateados', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    const out = byName('tool_search').execute({ query: 'tool_1', limit: 3 }, { toolCatalog: cat });
    expect(out).toMatch(/- tool_1/);
  });

  test('tool_load sin ctx.toolCatalog → error', () => {
    expect(byName('tool_load').execute({ names: ['x'] }, {})).toMatch(/toolCatalog no disponible/);
  });

  test('tool_load carga schemas y retorna resumen', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    const out = byName('tool_load').execute({ names: ['tool_5', 'tool_10'] }, { toolCatalog: cat, chatId: 'c1' });
    expect(out).toMatch(/Cargadas 2\/2/);
    expect(cat.isLoaded('tool_5', 'c1')).toBe(true);
  });

  test('tool_load con name inexistente reporta not_found', () => {
    const cat = new ToolCatalog({ tools: tools40, mode: 'on' });
    const out = byName('tool_load').execute({ names: ['fake_tool'] }, { toolCatalog: cat, chatId: 'c1' });
    expect(out).toMatch(/not_found/);
    expect(out).toMatch(/Cargadas 0\/1/);
  });
});
