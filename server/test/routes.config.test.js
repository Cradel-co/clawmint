'use strict';

const createConfigRouter = require('../routes/config');

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
    let r;
    try { r = h(req, res, next); } catch { /* */ }
    if (r && typeof r.then === 'function') { try { await r; } catch {} }
    if (res._ended) return;
    if (!nextCalled) return;
  }
}

function mockUsers() {
  return { getById: (id) => id === 'admin-id' ? { id, role: 'admin' } : (id === 'user-id' ? { id, role: 'user' } : null) };
}

function mockSettings(store = {}) {
  return {
    getGlobal: (k) => store[k] ?? null,
    setGlobal: (k, v) => { store[k] = v; },
    _store: store,
  };
}

describe('routes/config (E.6)', () => {
  test('factory throwea sin chatSettingsRepo', () => {
    expect(() => createConfigRouter({ usersRepo: {} })).toThrow(/chatSettingsRepo/);
  });

  test('GET /compaction rechaza user normal', async () => {
    const router = createConfigRouter({ chatSettingsRepo: mockSettings(), usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/compaction');
    const res = mockRes();
    await runChain(h, { user: { id: 'user-id' } }, res);
    expect(res._status).toBe(403);
  });

  test('GET /compaction admin retorna defaults', async () => {
    const router = createConfigRouter({ chatSettingsRepo: mockSettings(), usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/compaction');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.defaults).toBeDefined();
    expect(res._body.current.microcompact_every_turns).toBe(10);
    expect(res._body.overridden).toBe(false);
  });

  test('PUT /compaction persiste override y GET lo retorna', async () => {
    const settings = mockSettings();
    const router = createConfigRouter({ chatSettingsRepo: settings, usersRepo: mockUsers() });
    const putHandlers = findRoute(router, 'PUT', '/compaction');
    const resPut = mockRes();
    await runChain(putHandlers, {
      user: { id: 'admin-id' },
      body: { reactive_enabled: true, microcompact_every_turns: 20, unknown: 'ignored' },
    }, resPut);
    expect(resPut._status).toBe(200);
    expect(resPut._body.ok).toBe(true);
    expect(resPut._body.saved.reactive_enabled).toBe(true);
    expect(resPut._body.saved.unknown).toBeUndefined(); // key no allowed

    const getH = findRoute(router, 'GET', '/compaction');
    const resGet = mockRes();
    await runChain(getH, { user: { id: 'admin-id' } }, resGet);
    expect(resGet._body.overridden).toBe(true);
    expect(resGet._body.current.reactive_enabled).toBe(true);
    expect(resGet._body.current.microcompact_every_turns).toBe(20);
  });

  test('GET /model-tiers retorna defaults por provider', async () => {
    const router = createConfigRouter({ chatSettingsRepo: mockSettings(), usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/model-tiers');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.current.anthropic).toBeDefined();
    expect(res._body.current.anthropic.premium).toMatch(/opus|sonnet/);
  });

  test('PUT /model-tiers merge deep con defaults', async () => {
    const settings = mockSettings();
    const router = createConfigRouter({ chatSettingsRepo: settings, usersRepo: mockUsers() });
    const putH = findRoute(router, 'PUT', '/model-tiers');
    const r = mockRes();
    await runChain(putH, {
      user: { id: 'admin-id' },
      body: { anthropic: { premium: 'claude-opus-5' } },
    }, r);
    expect(r._status).toBe(200);

    const getH = findRoute(router, 'GET', '/model-tiers');
    const r2 = mockRes();
    await runChain(getH, { user: { id: 'admin-id' } }, r2);
    expect(r2._body.current.anthropic.premium).toBe('claude-opus-5');
    // Los otros providers mantienen defaults
    expect(r2._body.current.openai.premium).toMatch(/gpt/);
  });

  test('GET /features retorna snapshot booleanos', async () => {
    const router = createConfigRouter({ chatSettingsRepo: mockSettings(), usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/features');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(typeof res._body.permissions_enabled).toBe('boolean');
    expect(typeof res._body.hooks_enabled).toBe('boolean');
  });
});
