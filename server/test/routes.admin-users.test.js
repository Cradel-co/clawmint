'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const createAuthRouter = require('../routes/auth');

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
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const next = () => { nextCalled = true; done(); };
      try {
        const r = h(req, res, next);
        if (r && typeof r.then === 'function') {
          r.then(done).catch(() => done());
        } else if (res._ended) {
          done();
        } else if (nextCalled) {
          // ya resolvió
        } else {
          setImmediate(done);
        }
      } catch { done(); }
    });
    if (res._ended) return;
  }
}

function mockAuthService() {
  return {
    verifyAccessToken: (token) => {
      if (token === 'ADMIN') return { sub: 'admin-id' };
      if (token === 'USER')  return { sub: 'user-id' };
      return null;
    },
  };
}

function mockUsersRepo({ users }) {
  return {
    count: () => users.length,
    listAll: () => users.map(u => ({ ...u })),
    getById: (id) => users.find(u => u.id === id) || null,
    update: (id, patch) => {
      const u = users.find(x => x.id === id);
      if (u) Object.assign(u, patch);
      return u;
    },
    delete: (id) => {
      const i = users.findIndex(x => x.id === id);
      if (i < 0) return false;
      users.splice(i, 1);
      return true;
    },
  };
}

describe('auth.js admin endpoints (B.6)', () => {
  function makeRouter(users) {
    const usersRepo = mockUsersRepo({ users });
    const authService = mockAuthService();
    return createAuthRouter({ authService, usersRepo, logger: { error: () => {}, info: () => {}, warn: () => {} } });
  }

  function asAdmin(req = {}) { return { ...req, headers: { ...(req.headers || {}), authorization: 'Bearer ADMIN' } }; }
  function asUser(req = {}) { return { ...req, headers: { ...(req.headers || {}), authorization: 'Bearer USER' } }; }
  function noAuth(req = {}) { return { ...req, headers: { ...(req.headers || {}) } }; }

  test('GET /admin/users requiere auth', async () => {
    const router = makeRouter([{ id: 'admin-id', role: 'admin' }]);
    const handlers = findRoute(router, 'GET', '/admin/users');
    const res = mockRes();
    await runChain(handlers, noAuth({ headers: {} }), res);
    expect(res._status).toBe(401);
  });

  test('GET /admin/users rechaza user normal con 403', async () => {
    const router = makeRouter([
      { id: 'admin-id', role: 'admin' },
      { id: 'user-id',  role: 'user' },
    ]);
    const handlers = findRoute(router, 'GET', '/admin/users');
    const res = mockRes();
    await runChain(handlers, asUser({ headers: {} }), res);
    expect(res._status).toBe(403);
  });

  test('GET /admin/users retorna lista sin password_hash', async () => {
    const router = makeRouter([
      { id: 'admin-id', role: 'admin', name: 'Admin', password_hash: 'secret' },
      { id: 'user-id',  role: 'user',  name: 'User',  password_hash: 'secret2' },
    ]);
    const handlers = findRoute(router, 'GET', '/admin/users');
    const res = mockRes();
    await runChain(handlers, asAdmin({ headers: {} }), res);
    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(2);
    expect(res._body[0].password_hash).toBeUndefined();
    expect(res._body[1].password_hash).toBeUndefined();
  });

  test('PATCH /admin/users/:id cambia role', async () => {
    const router = makeRouter([
      { id: 'admin-id', role: 'admin' },
      { id: 'user-id',  role: 'user' },
    ]);
    const handlers = findRoute(router, 'PATCH', '/admin/users/:id');
    const req = asAdmin({ params: { id: 'user-id' }, body: { role: 'admin' } });
    const res = mockRes();
    await runChain(handlers, req, res);
    expect(res._status).toBe(200);
    expect(res._body.role).toBe('admin');
  });

  test('PATCH /admin/users/:id con role inválido → 400', async () => {
    const router = makeRouter([{ id: 'admin-id', role: 'admin' }]);
    const handlers = findRoute(router, 'PATCH', '/admin/users/:id');
    const res = mockRes();
    await runChain(handlers, asAdmin({ params: { id: 'admin-id' }, body: { role: 'superadmin' } }), res);
    expect(res._status).toBe(400);
  });

  test('PATCH bloquea self-demote del último admin', async () => {
    const router = makeRouter([{ id: 'admin-id', role: 'admin' }]);
    const handlers = findRoute(router, 'PATCH', '/admin/users/:id');
    const res = mockRes();
    await runChain(handlers, asAdmin({ params: { id: 'admin-id' }, body: { role: 'user' } }), res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/\u00fanico|último/i);
  });

  test('PATCH permite self-demote si hay otro admin', async () => {
    const router = makeRouter([
      { id: 'admin-id', role: 'admin' },
      { id: 'other-admin', role: 'admin' },
    ]);
    const handlers = findRoute(router, 'PATCH', '/admin/users/:id');
    const res = mockRes();
    await runChain(handlers, asAdmin({ params: { id: 'admin-id' }, body: { role: 'user' } }), res);
    expect(res._status).toBe(200);
  });

  test('DELETE /admin/users/:id bloquea self-delete', async () => {
    const router = makeRouter([{ id: 'admin-id', role: 'admin' }]);
    const handlers = findRoute(router, 'DELETE', '/admin/users/:id');
    const res = mockRes();
    await runChain(handlers, asAdmin({ params: { id: 'admin-id' } }), res);
    expect(res._status).toBe(400);
  });

  test('DELETE /admin/users/:id borra user', async () => {
    const users = [
      { id: 'admin-id', role: 'admin' },
      { id: 'victim',   role: 'user' },
    ];
    const router = makeRouter(users);
    const handlers = findRoute(router, 'DELETE', '/admin/users/:id');
    const res = mockRes();
    await runChain(handlers, asAdmin({ params: { id: 'victim' } }), res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(users).toHaveLength(1);
  });
});
