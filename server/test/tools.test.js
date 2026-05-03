'use strict';

const tools = require('../tools');
const { destroy: destroyShell, destroyAll } = require('../mcp/ShellSession');

afterAll(() => destroyAll());

const ADMIN_CTX = {
  userId: 'admin-test',
  usersRepo: {
    findByIdentity: () => ({ id: 'admin-test', role: 'admin' }),
    getById: () => ({ id: 'admin-test', role: 'admin' }),
  },
};

describe('tools.js — adaptador', () => {
  test('TOOLS es un array no vacío', () => {
    expect(Array.isArray(tools.TOOLS)).toBe(true);
    expect(tools.TOOLS.length).toBeGreaterThan(0);
  });

  test('TOOLS contiene los tools esperados', () => {
    const names = tools.TOOLS.map(t => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });

  // ── toAnthropicFormat ──────────────────────────────────────────────────────

  test('toAnthropicFormat() retorna array', () => {
    expect(Array.isArray(tools.toAnthropicFormat())).toBe(true);
  });

  test('toAnthropicFormat() — cada tool tiene input_schema con type=object', () => {
    for (const t of tools.toAnthropicFormat()) {
      expect(t.input_schema.type).toBe('object');
      expect(typeof t.input_schema.properties).toBe('object');
      expect(Array.isArray(t.input_schema.required)).toBe(true);
    }
  });

  test('toAnthropicFormat() — bash tiene "command" como campo requerido', () => {
    const bash = tools.toAnthropicFormat().find(t => t.name === 'bash');
    expect(bash).toBeTruthy();
    expect(bash.input_schema.required).toContain('command');
  });

  // ── toGeminiFormat ─────────────────────────────────────────────────────────

  test('toGeminiFormat() retorna array', () => {
    expect(Array.isArray(tools.toGeminiFormat())).toBe(true);
  });

  test('toGeminiFormat() — cada tool tiene parameters con type=OBJECT', () => {
    for (const t of tools.toGeminiFormat()) {
      expect(t.parameters.type).toBe('OBJECT');
      expect(typeof t.parameters.properties).toBe('object');
    }
  });

  // ── toOpenAIFormat ─────────────────────────────────────────────────────────

  test('toOpenAIFormat() retorna array', () => {
    expect(Array.isArray(tools.toOpenAIFormat())).toBe(true);
  });

  test('toOpenAIFormat() — cada tool tiene type=function y function.parameters', () => {
    for (const t of tools.toOpenAIFormat()) {
      expect(t.type).toBe('function');
      expect(t.function.name).toBeTruthy();
      expect(t.function.parameters.type).toBe('object');
    }
  });

  // ── executeTool ────────────────────────────────────────────────────────────

  test('executeTool() delega a mcp y retorna string', async () => {
    const id = 'adapter-' + Date.now();
    const r  = await tools.executeTool('bash', { command: 'echo adapter_ok' }, { shellId: id, ...ADMIN_CTX });
    expect(r).toContain('adapter_ok');
    destroyShell(id);
  });

  test('executeTool() con tool desconocido retorna string de error', async () => {
    const r = await tools.executeTool('no-existe', {});
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Error|desconocida/);
  });

  // ── Consistencia entre formatos ────────────────────────────────────────────

  test('los tres formatos tienen el mismo número de tools', () => {
    const n = tools.TOOLS.length;
    expect(tools.toAnthropicFormat()).toHaveLength(n);
    expect(tools.toGeminiFormat()).toHaveLength(n);
    expect(tools.toOpenAIFormat()).toHaveLength(n);
  });

  test('los tres formatos tienen los mismos nombres de tools', () => {
    const base      = tools.TOOLS.map(t => t.name).sort();
    const anthropic = tools.toAnthropicFormat().map(t => t.name).sort();
    const gemini    = tools.toGeminiFormat().map(t => t.name).sort();
    const openai    = tools.toOpenAIFormat().map(t => t.function.name).sort();
    expect(anthropic).toEqual(base);
    expect(gemini).toEqual(base);
    expect(openai).toEqual(base);
  });
});
