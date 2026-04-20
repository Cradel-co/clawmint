'use strict';

const createLspRouter = require('../routes/lsp');
const createOrchRouter = require('../routes/orchestration');

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

describe('routes/lsp (E.4)', () => {
  test('GET /status admin retorna snapshot', async () => {
    const mgr = {
      listServers: () => [{ language: 'ts', command: 'typescript-language-server', available: true }],
      list: () => [],
    };
    const router = createLspRouter({ lspServerManager: mgr, usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/status');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.servers).toHaveLength(1);
    expect(res._body.active).toEqual([]);
  });

  test('GET /status rechaza user normal', async () => {
    const router = createLspRouter({ lspServerManager: {}, usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/status');
    const res = mockRes();
    await runChain(h, { user: { id: 'user-id' } }, res);
    expect(res._status).toBe(403);
  });

  test('POST /detect ejecuta force detect', async () => {
    const mgr = {
      listServers: () => [],
      list: () => [],
      detectAvailableServers: async ({ force }) => ({ ts: force === true }),
    };
    const router = createLspRouter({ lspServerManager: mgr, usersRepo: mockUsers() });
    const h = findRoute(router, 'POST', '/detect');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.results.ts).toBe(true);
  });
});

describe('routes/orchestration (E.5)', () => {
  test('GET /workflows admin lista workflows', async () => {
    const orch = {
      listWorkflows: () => [{ id: 'wf_1', coordinator: 'claude', status: 'active', tasks: [] }],
    };
    const router = createOrchRouter({ orchestrator: orch, usersRepo: mockUsers() });
    const h = findRoute(router, 'GET', '/workflows');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(1);
    expect(res._body[0].id).toBe('wf_1');
  });

  test('POST /workflows/:id/cancel invoca cancelWorkflow', async () => {
    let cancelled = null;
    const orch = { cancelWorkflow: (id) => { cancelled = id; return true; } };
    const router = createOrchRouter({ orchestrator: orch, usersRepo: mockUsers() });
    const h = findRoute(router, 'POST', '/workflows/:id/cancel');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' }, params: { id: 'wf_x' } }, res);
    expect(res._status).toBe(200);
    expect(cancelled).toBe('wf_x');
  });

  test('POST /workflows/:id/cancel 404 si no existe', async () => {
    const orch = { cancelWorkflow: () => false };
    const router = createOrchRouter({ orchestrator: orch, usersRepo: mockUsers() });
    const h = findRoute(router, 'POST', '/workflows/:id/cancel');
    const res = mockRes();
    await runChain(h, { user: { id: 'admin-id' }, params: { id: 'nope' } }, res);
    expect(res._status).toBe(404);
  });
});
