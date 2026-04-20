'use strict';

const createWorkspacesRouter = require('../routes/workspaces');

function mockRes() {
  const res = {
    _status: 200, _body: null, _ended: false,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; this._ended = true; return this; },
  };
  return res;
}

function findRoute(router, method, pathStr) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathStr && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack.map(s => s.handle);
    }
  }
  throw new Error(`${method} ${pathStr} no encontrada`);
}

/**
 * Ejecuta el stack de handlers Express secuencialmente. Cada handler:
 *   - llama `next()` (resolve sin resbalar nada) → pasar al siguiente
 *   - llama `res.json()` → termina con respuesta (detenemos cadena)
 *   - throwea → descartamos
 * Si el handler es async (returns Promise), esperamos.
 */
async function runChain(handlers, req, res) {
  for (const h of handlers) {
    if (res._ended) return;
    let nextCalled = false;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const next = (err) => { if (err) { /* ignore */ } nextCalled = true; done(); };
      try {
        const r = h(req, res, next);
        if (r && typeof r.then === 'function') {
          r.then(done).catch(() => done());
        } else if (res._ended) {
          done();
        } else if (nextCalled) {
          // next() ya llamó done()
        } else {
          // Handler sync que no llamó next ni res.json → asumir "done"
          setImmediate(done);
        }
      } catch { done(); }
    });
    if (res._ended) return;
  }
}

function mockUsersRepo(role) {
  return {
    getById: (id) => id === 'admin-id' ? { id, role: 'admin' } : (id === 'user-id' ? { id, role: 'user' } : null),
  };
}

describe('routes/workspaces (B.5)', () => {
  test('factory throwea sin workspaceRegistry', () => {
    expect(() => createWorkspacesRouter({ usersRepo: {} })).toThrow(/workspaceRegistry/);
  });

  test('factory throwea sin usersRepo', () => {
    expect(() => createWorkspacesRouter({ workspaceRegistry: {} })).toThrow(/usersRepo/);
  });

  test('GET / rechaza user normal con 403', async () => {
    const router = createWorkspacesRouter({
      workspaceRegistry: { 'null': { list: () => [] } },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'user-id' } }, res);
    expect(res._status).toBe(403);
  });

  test('GET / admin retorna snapshot de providers', async () => {
    const router = createWorkspacesRouter({
      workspaceRegistry: {
        'null': { list: () => [] },
        'git-worktree': { list: () => [{ id: 'w1', path: '/tmp/a', branch: 'sub/a' }] },
        'docker': null,
      },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body['null'].enabled).toBe(true);
    expect(res._body['null'].workspaces).toEqual([]);
    expect(res._body['git-worktree'].workspaces).toHaveLength(1);
    expect(res._body['docker'].enabled).toBe(false);
  });

  test('GET / captura errores de un provider sin romper snapshot', async () => {
    const router = createWorkspacesRouter({
      workspaceRegistry: {
        'ok': { list: () => [{ id: 'x' }] },
        'broken': { list: () => { throw new Error('broken!'); } },
      },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body['ok'].workspaces).toHaveLength(1);
    expect(res._body['broken'].error).toMatch(/broken/);
  });

  test('DELETE /:id 404 si no existe en ningún provider', async () => {
    const router = createWorkspacesRouter({
      workspaceRegistry: { 'null': { list: () => [] } },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'DELETE', '/:id');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'admin-id' }, params: { id: 'unknown' } }, res);
    expect(res._status).toBe(404);
  });

  test('DELETE /:id 501 si provider no expone releaseById', async () => {
    const router = createWorkspacesRouter({
      workspaceRegistry: {
        'git-worktree': { list: () => [{ id: 'w1', path: '/tmp/a' }] },
      },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'DELETE', '/:id');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'admin-id' }, params: { id: 'w1' } }, res);
    expect(res._status).toBe(501);
    expect(res._body.provider).toBe('git-worktree');
  });

  test('DELETE /:id OK si provider expone releaseById', async () => {
    const released = [];
    const router = createWorkspacesRouter({
      workspaceRegistry: {
        'docker': {
          list: () => [{ id: 'd1' }],
          releaseById: async (id) => { released.push(id); },
        },
      },
      usersRepo: mockUsersRepo(),
    });
    const handlers = findRoute(router, 'DELETE', '/:id');
    const res = mockRes();
    await runChain(handlers, { user: { id: 'admin-id' }, params: { id: 'd1' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(released).toEqual(['d1']);
  });
});
