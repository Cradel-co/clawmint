'use strict';

const http    = require('http');
const express = require('express');
const { createMcpRouter, executeTool, getToolDefs } = require('../mcp');
const { destroy: destroyShell, destroyAll }          = require('../mcp/ShellSession');

afterAll(() => destroyAll());

const ADMIN_CTX = {
  userId: 'admin-test',
  usersRepo: {
    findByIdentity: () => ({ id: 'admin-test', role: 'admin' }),
    getById: () => ({ id: 'admin-test', role: 'admin' }),
  },
};

// ── getToolDefs ───────────────────────────────────────────────────────────────

describe('getToolDefs()', () => {
  test('retorna un array no vacío', () => {
    const defs = getToolDefs();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  test('cada tool tiene name, description y params o inputSchema', () => {
    for (const t of getToolDefs()) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      const hasParams = typeof t.params === 'object' || typeof t.inputSchema === 'object';
      expect(hasParams).toBe(true);
    }
  });
});

// ── executeTool ───────────────────────────────────────────────────────────────

describe('executeTool() en-proceso', () => {
  test('ejecuta bash directamente y retorna string', async () => {
    const id = 'mcp-exec-' + Date.now();
    const r  = await executeTool('bash', { command: 'echo mcp_ok' }, { shellId: id, ...ADMIN_CTX });
    expect(r).toContain('mcp_ok');
    destroyShell(id);
  });

  test('herramienta desconocida retorna error string (sin lanzar)', async () => {
    const r = await executeTool('no-existe', {});
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Error|desconocida/);
  });
});

// ── createMcpRouter() — HTTP ──────────────────────────────────────────────────

/** Crea un servidor Express efímero para tests HTTP. Retorna { server, port, close }. */
async function createTestServer() {
  const app    = express();
  const router = createMcpRouter({
    usersRepo: {
      findByIdentity: () => ({ id: 'admin-test', role: 'admin' }),
      getById: () => ({ id: 'admin-test', role: 'admin' }),
    },
  });
  app.use('/mcp', router);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

/** Hace una petición POST JSON al servidor de test. */
function post(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request({
      hostname: '127.0.0.1',
      port,
      path:   '/mcp',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** GET a /mcp */
function getInfo(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/mcp`, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(buf); }
      });
    }).on('error', reject);
  });
}

describe('MCP HTTP router', () => {
  let port, close;

  beforeAll(async () => {
    ({ port, close } = await createTestServer());
  });

  afterAll(async () => {
    await close();
  });

  test('GET /mcp retorna info del server', async () => {
    const info = await getInfo(port);
    expect(info.server.name).toBe('clawmint');
    expect(Array.isArray(info.tools)).toBe(true);
    expect(info.transport).toContain('JSON-RPC');
  });

  test('POST / initialize retorna serverInfo y capabilities', async () => {
    const { body } = await post(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('clawmint');
    expect(body.result.capabilities).toBeTruthy();
  });

  test('POST / ping retorna resultado vacío', async () => {
    const { body } = await post(port, { jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(body.result).toEqual({});
  });

  test('POST / tools/list retorna array de tools', async () => {
    const { body } = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
    const names = body.result.tools.map(t => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
  });

  test('POST / tools/list — cada tool tiene inputSchema', async () => {
    const { body } = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.inputSchema.properties).toBe('object');
    }
  });

  test('POST / tools/call ejecuta un tool y retorna content[].text', async () => {
    const id = 'http-call-' + Date.now();
    const { body } = await post(
      port,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo http_ok' } } },
      { 'x-shell-id': id, 'x-user-id': 'admin-test' },
    );
    expect(body.result.content[0].type).toBe('text');
    expect(body.result.content[0].text).toContain('http_ok');
    destroyShell(id);
  });

  test('POST / tools/call sin name retorna error -32602', async () => {
    const { body } = await post(port, {
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: {},
    });
    expect(body.error.code).toBe(-32602);
  });

  test('POST / método desconocido retorna error -32601', async () => {
    const { body } = await post(port, { jsonrpc: '2.0', id: 7, method: 'metodo/inexistente' });
    expect(body.error.code).toBe(-32601);
  });

  test('POST / jsonrpc != "2.0" retorna status 400', async () => {
    const { status } = await post(port, { jsonrpc: '1.0', id: 8, method: 'ping' });
    expect(status).toBe(400);
  });

  test('POST / notifications/initialized retorna 202 sin body', async () => {
    const { status, body } = await post(port, {
      jsonrpc: '2.0', id: null, method: 'notifications/initialized',
    });
    expect(status).toBe(202);
    expect(body).toBe('');
  });
});
