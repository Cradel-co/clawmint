'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const McpAuthService = require('../services/McpAuthService');
const createRouter = require('../routes/mcp-auth');

function inMemoryRepo() {
  const rows = new Map();
  return {
    upsert(row) { rows.set(`${row.mcp_name}:${row.user_id}`, { ...row, id: rows.size + 1 }); return rows.get(`${row.mcp_name}:${row.user_id}`); },
    findByMcpUser(mcp, user) { return rows.get(`${mcp}:${user}`) || null; },
    listByUser(user) { return Array.from(rows.values()).filter(r => r.user_id === user); },
    removeByMcpUser(mcp, user) { return rows.delete(`${mcp}:${user}`); },
  };
}

function fakeCrypto() {
  return {
    encrypt: (s) => `enc:${s}`,
    decrypt: (s) => s.replace(/^enc:/, ''),
  };
}

function mockRes() {
  const res = {
    _status: 200, _body: null, _headers: {}, _sentHtml: null,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; return this; },
    set(h) { Object.assign(this._headers, h); return this; },
    send(h) { this._sentHtml = h; return this; },
  };
  return res;
}

function findRoute(router, method, pathStr) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathStr && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`${method} ${pathStr} no encontrada`);
}

describe('McpAuthService callback handlers (Fase 11 parked → cerrado)', () => {
  let svc;

  beforeEach(() => {
    svc = new McpAuthService({ repo: inMemoryRepo(), crypto: fakeCrypto() });
  });

  test('registerCallbackHandler valida shape', () => {
    expect(() => svc.registerCallbackHandler('x', {})).toThrow(/exchange/);
    expect(() => svc.registerCallbackHandler('', { exchange: () => {} })).toThrow(/provider/);
  });

  test('registro + lookup case-insensitive', () => {
    const h = { exchange: async () => ({ token: 'x' }) };
    svc.registerCallbackHandler('Google', h);
    expect(svc.getCallbackHandler('google')).toBe(h);
    expect(svc.getCallbackHandler('GOOGLE')).toBe(h);
    expect(svc.listCallbackHandlers()).toContain('google');
  });

  test('createAuthState genera token opaco y expiración', () => {
    const a = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1', ttlMs: 5000 });
    const b = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThan(20);
    expect(a.expires_at).toBeGreaterThan(Date.now());
  });

  test('consumeAuthState es one-shot', () => {
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    expect(svc.consumeAuthState(state).mcp_name).toBe('gmail');
    expect(svc.consumeAuthState(state)).toBeNull();
  });

  test('consumeAuthState null si expirado', () => {
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1', ttlMs: -1 });
    expect(svc.consumeAuthState(state)).toBeNull();
  });

  test('handleCallback valida state, llama exchange, persiste token', async () => {
    const bus = new EventEmitter();
    const svcBus = new McpAuthService({ repo: inMemoryRepo(), crypto: fakeCrypto(), eventBus: bus });
    const events = [];
    bus.on('mcp:auth_completed', (p) => events.push(p));
    svcBus.registerCallbackHandler('google', {
      exchange: async ({ code, state, userId }) => {
        expect(code).toBe('CODE123');
        expect(state).toBeDefined();
        expect(userId).toBe('u1');
        return { token: 'real-token', token_type: 'bearer', mcp_name: 'gmail' };
      },
    });
    const { state } = svcBus.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    const result = await svcBus.handleCallback({ provider: 'google', code: 'CODE123', state });
    expect(result.ok).toBe(true);
    expect(result.mcp_name).toBe('gmail');
    expect(svcBus.hasToken('gmail', 'u1')).toBe(true);
    expect(events).toHaveLength(1);
  });

  test('handleCallback rechaza state desconocido', async () => {
    svc.registerCallbackHandler('x', { exchange: async () => ({ token: 't' }) });
    await expect(svc.handleCallback({ provider: 'x', code: 'c', state: 'fake' })).rejects.toThrow(/state inv/);
  });

  test('handleCallback rechaza sin handler', async () => {
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    await expect(svc.handleCallback({ provider: 'unknown', code: 'c', state })).rejects.toThrow(/handler/);
  });
});

describe('routes/mcp-auth (Fase 11 parked → cerrado)', () => {
  let svc, router;

  beforeEach(() => {
    svc = new McpAuthService({ repo: inMemoryRepo(), crypto: fakeCrypto() });
    svc.registerCallbackHandler('google', {
      exchange: async ({ code }) => code === 'good' ? { token: 't', mcp_name: 'gmail' } : (() => { throw new Error('bad code'); })(),
      buildAuthUrl: ({ userId, state, redirectUri }) =>
        `https://google.com/auth?client_id=X&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&uid=${userId}`,
    });
    router = createRouter({ mcpAuthService: svc, logger: { warn: () => {} } });
  });

  test('GET /providers lista handlers registrados', async () => {
    const handler = findRoute(router, 'GET', '/providers');
    const res = mockRes();
    await handler({}, res);
    expect(res._body).toContain('google');
  });

  test('POST /start/:provider sin auth → 401', async () => {
    const h = findRoute(router, 'POST', '/start/:provider');
    const req = { params: { provider: 'google' }, body: {}, user: null };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(401);
  });

  test('POST /start/:provider con provider desconocido → 404', async () => {
    const h = findRoute(router, 'POST', '/start/:provider');
    const req = { params: { provider: 'nope' }, body: {}, user: { id: 'u1' } };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(404);
  });

  test('POST /start/:provider retorna state + auth_url', async () => {
    const h = findRoute(router, 'POST', '/start/:provider');
    const req = {
      params: { provider: 'google' }, body: { mcp_name: 'gmail' }, user: { id: 'u1' },
      protocol: 'http', get: () => 'localhost:3001',
    };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(200);
    expect(res._body.state).toBeDefined();
    expect(res._body.auth_url).toContain('https://google.com/auth');
    expect(res._body.auth_url).toContain(encodeURIComponent('http://localhost:3001/api/mcp-auth/callback/google'));
  });

  test('GET /callback/:provider válido → 200 HTML', async () => {
    const { state } = svc.createAuthState({ mcp_name: 'gmail', user_id: 'u1' });
    const h = findRoute(router, 'GET', '/callback/:provider');
    const req = { params: { provider: 'google' }, query: { code: 'good', state } };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(200);
    expect(res._sentHtml).toContain('Autenticación completada');
    expect(res._sentHtml).toContain('gmail');
  });

  test('GET /callback/:provider sin code → 400', async () => {
    const h = findRoute(router, 'GET', '/callback/:provider');
    const req = { params: { provider: 'google' }, query: { state: 'x' } };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(400);
  });

  test('GET /callback/:provider con error query → 400', async () => {
    const h = findRoute(router, 'GET', '/callback/:provider');
    const req = { params: { provider: 'google' }, query: { error: 'access_denied' } };
    const res = mockRes();
    await h(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('access_denied');
  });

  test('factory throwea sin mcpAuthService', () => {
    expect(() => createRouter({})).toThrow(/mcpAuthService/);
  });
});
