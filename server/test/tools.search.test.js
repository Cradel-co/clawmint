'use strict';

/**
 * Tests de mcp/tools/search.js — glob + grep usando @vscode/ripgrep.
 *
 * Crea fixtures en os.tmpdir() y hace asserts sobre stdout formateado.
 * Los tests corren en cwd aislado; el user-sandbox se bypassea vía ctx con isAdmin=true.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const tools = require('../mcp/tools/search');

function byName(n) { return tools.find(t => t.name === n); }

let fixtureDir;
let adminCtx;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
  fs.writeFileSync(path.join(fixtureDir, 'alpha.js'), 'const x = 1;\nfunction foo() {}\n');
  fs.writeFileSync(path.join(fixtureDir, 'beta.js'), 'function bar() {\n  return foo();\n}\n');
  fs.writeFileSync(path.join(fixtureDir, 'readme.md'), '# Título\nfoo está definida acá\n');
  fs.mkdirSync(path.join(fixtureDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'sub', 'gamma.ts'), 'export const y = foo();\n');

  // Bypass del sandbox: admin con HOME en fixtureDir
  adminCtx = {
    // Simular admin — isAdmin() devuelve false sin usersRepo, pero assertPathAllowed
    // requiere usersRepo para no ser admin. Sin usersRepo, isAdmin() retorna false y
    // assertPathAllowed throwea "No se pudo identificar al usuario".
    // Workaround en tests: inyectar usersRepo fake que reporte admin.
    usersRepo: {
      findByIdentity: () => ({ id: 'admin-test' }),
      getById: () => ({ id: 'admin-test', role: 'admin' }),
    },
    userId: 'admin-test',
    chatId: 'test-chat',
    channel: 'test',
  };
  // Override getBaseDir via HOME env — admins usan process.env.HOME
  process.env.HOME = fixtureDir;
});

afterAll(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
});

describe('glob — lista archivos por patrón', () => {
  test('matches **/*.js', async () => {
    const out = await byName('glob').execute({ pattern: '**/*.js' }, adminCtx);
    expect(out).toMatch(/alpha\.js/);
    expect(out).toMatch(/beta\.js/);
    expect(out).not.toMatch(/gamma\.ts/);
  });

  test('matches brace expansion {js,ts}', async () => {
    const out = await byName('glob').execute({ pattern: '**/*.{js,ts}' }, adminCtx);
    expect(out).toMatch(/alpha\.js/);
    expect(out).toMatch(/gamma\.ts/);
  });

  test('patron sin resultados', async () => {
    const out = await byName('glob').execute({ pattern: '**/*.nonexistent' }, adminCtx);
    expect(out).toBe('(sin resultados)');
  });

  test('error sin pattern', async () => {
    const out = await byName('glob').execute({}, adminCtx);
    expect(out).toMatch(/pattern requerido/);
  });

  test('respeta limit', async () => {
    const out = await byName('glob').execute({ pattern: '**/*', limit: 2 }, adminCtx);
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});

describe('grep — busca contenido', () => {
  test('mode=content retorna file:line:match', async () => {
    const out = await byName('grep').execute({ pattern: 'function foo' }, adminCtx);
    expect(out).toMatch(/alpha\.js:\d+:function foo/);
  });

  test('mode=files retorna solo paths', async () => {
    const out = await byName('grep').execute({ pattern: 'foo', mode: 'files' }, adminCtx);
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(l => !l.includes(':'))).toBe(true);
  });

  test('mode=count retorna file:N', async () => {
    const out = await byName('grep').execute({ pattern: 'foo', mode: 'count' }, adminCtx);
    expect(out).toMatch(/:\d+/);
  });

  test('mode inválido retorna error', async () => {
    const out = await byName('grep').execute({ pattern: 'x', mode: 'invalid' }, adminCtx);
    expect(out).toMatch(/mode debe ser/);
  });

  test('error sin pattern', async () => {
    const out = await byName('grep').execute({}, adminCtx);
    expect(out).toMatch(/pattern requerido/);
  });

  test('filtro por glob', async () => {
    const out = await byName('grep').execute({ pattern: 'foo', glob: '*.md' }, adminCtx);
    expect(out).toMatch(/readme\.md/);
    expect(out).not.toMatch(/alpha\.js/);
  }, 30_000);

  test('contexto -A 1', async () => {
    const out = await byName('grep').execute({ pattern: 'function bar', '-A': 1 }, adminCtx);
    // Con -A 1, debería venir la línea + la siguiente
    expect(out).toMatch(/function bar/);
  }, 30_000);

  test('sin resultados devuelve mensaje explícito', async () => {
    const out = await byName('grep').execute({ pattern: 'zzzzznomatchzzzzz' }, adminCtx);
    expect(out).toMatch(/\(sin resultados\)/);
  }, 30_000);
});
