'use strict';

const createRouter = require('../routes/tools-admin');

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
    try { r = h(req, res, next); } catch {}
    if (r && typeof r.then === 'function') { try { await r; } catch {} }
    if (res._ended) return;
    if (!nextCalled) return;
  }
}
function mockUsers() {
  return { getById: (id) => id === 'admin-id' ? { id, role: 'admin' } : (id === 'user-id' ? { id, role: 'user' } : null) };
}

describe('routes/tools-admin (E.3)', () => {
  test('GET /all admin retorna lista con metadata', async () => {
    const settings = { _s: {}, getGlobal: (k) => settings._s[k] || null, setGlobal: (k, v) => { settings._s[k] = v; } };
    const router = createRouter({ chatSettingsRepo: settings, usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/all');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(Array.isArray(res._body.tools)).toBe(true);
    // Core tools deben tener al menos bash + read_file
    const names = res._body.tools.map(t => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
  });

  test('GET /all rechaza user', async () => {
    const router = createRouter({ chatSettingsRepo: { getGlobal: () => null, setGlobal: () => {} }, usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/all');
    const res = mockRes();
    await runChain(h, { user: { id: 'user-id' } }, res);
    expect(res._status).toBe(403);
  });

  test('POST /toggle agrega a user_disabled', async () => {
    const store = {};
    const settings = { getGlobal: (k) => store[k] || null, setGlobal: (k, v) => { store[k] = v; } };
    const router = createRouter({ chatSettingsRepo: settings, usersRepo: mockUsers() });
    const h = findRoute(router, 'POST', '/toggle');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' }, body: { name: 'bash', disabled: true } }, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(res._body.user_disabled).toContain('bash');
  });

  test('POST /toggle con disabled:false quita', async () => {
    const store = { 'config:tools-disabled': ['bash', 'git'] };
    const settings = { getGlobal: (k) => store[k] || null, setGlobal: (k, v) => { store[k] = v; } };
    const router = createRouter({ chatSettingsRepo: settings, usersRepo: mockUsers() });
    const h = findRoute(router, 'POST', '/toggle');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' }, body: { name: 'bash', disabled: false } }, res);
    expect(res._body.user_disabled).not.toContain('bash');
    expect(res._body.user_disabled).toContain('git');
  });
});
