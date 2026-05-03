'use strict';

const McpAuthService = require('../services/McpAuthService');
const createRouter = require('../routes/mcp-auth');

function inMemRepo() {
  const rows = new Map();
  return {
    upsert(r) { rows.set(`${r.mcp_name}:${r.user_id}`, { ...r, id: rows.size + 1 }); return rows.get(`${r.mcp_name}:${r.user_id}`); },
    findByMcpUser: (m, u) => rows.get(`${m}:${u}`) || null,
    listByUser: (u) => [...rows.values()].filter(r => r.user_id === u),
    removeByMcpUser: (m, u) => rows.delete(`${m}:${u}`),
  };
}
const fakeCrypto = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.replace(/^enc:/, '') };

function mockRes() {
  return {
    _status: 200, _body: null, _ended: false,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; this._ended = true; return this; },
  };
}

function findRoute(router, method, pathStr) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathStr && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack.map(s => s.handle);
    }
  }
  throw new Error(`${method} ${pathStr} no encontrada`);
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    if (res._ended) return;
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    let result;
    try { result = h(req, res, next); } catch { /* ignore */ }
    if (result && typeof result.then === 'function') {
      try { await result; } catch { /* ignore */ }
    }
    if (res._ended) return;
    if (!nextCalled) return;
  }
}

describe('McpAuthService getAuthStatus + route /status (C.7)', () => {
  test('getAuthStatus unknown por default', () => {
    const svc = new McpAuthService({ repo: inMemRepo(), crypto: fakeCrypto });
    expect(svc.getAuthStatus('fake-state')).toEqual({ status: 'unknown' });
    expect(svc.getAuthStatus(null)).toEqual({ status: 'unknown' });
  });

  test('getAuthStatus pending tras createAuthState', () => {
    const svc = new McpAuthService({ repo: inMemRepo(), crypto: fakeCrypto });
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    const status = svc.getAuthStatus(state);
    expect(status.status).toBe('pending');
    expect(status.mcp_name).toBe('gmail');
  });

  test('getAuthStatus completed tras handleCallback OK', async () => {
    const svc = new McpAuthService({ repo: inMemRepo(), crypto: fakeCrypto });
    svc.registerCallbackHandler('google', {
      exchange: async () => ({ token: 't', mcp_name: 'gmail' }),
    });
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    await svc.handleCallback({ provider: 'google', code: 'c', state });
    const status = svc.getAuthStatus(state);
    expect(status.status).toBe('completed');
    expect(status.mcp_name).toBe('gmail');
  });

  test('getAuthStatus error tras handleCallback falla', async () => {
    const svc = new McpAuthService({ repo: inMemRepo(), crypto: fakeCrypto });
    svc.registerCallbackHandler('google', {
      exchange: async () => { throw new Error('token rejected'); },
    });
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    await expect(svc.handleCallback({ provider: 'google', code: 'c', state })).rejects.toThrow(/token rejected/);
    const status = svc.getAuthStatus(state);
    expect(status.status).toBe('error');
    expect(status.error).toMatch(/token rejected/);
  });

  test('route GET /status/:state consume del service', async () => {
    const svc = new McpAuthService({ repo: inMemRepo(), crypto: fakeCrypto });
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    const router = createRouter({ mcpAuthService: svc, logger: { warn: () => {} } });
    const h = findRoute(router, 'GET', '/status/:state');
    const res = mockRes();
    await runChain(h, { params: { state } }, res);
    expect(res._status).toBe(200);
    expect(res._body.status).toBe('pending');
  });
});
