'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TaskRepository = require('../storage/TaskRepository');
const createTasksRouter = require('../routes/tasks');

async function makeDb() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  return { db: new Database(path.join(tmpDir, 'test.db')), tmpDir };
}

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

describe('routes/tasks (C.1)', () => {
  let db, repo, router, tmpDir;

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir = m.tmpDir;
    repo = new TaskRepository(db);
    repo.init();
    router = createTasksRouter({
      tasksRepo: repo,
      usersRepo: { getById: (id) => id === 'admin' ? { id, role: 'admin' } : { id, role: 'user' } },
      logger: { error: () => {} },
    });
  });

  afterAll(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
  afterEach(() => { db.prepare('DELETE FROM tasks').run(); });

  test('GET / sin auth → 401', async () => {
    const h = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(h, { user: null, query: {} }, res);
    expect(res._status).toBe(401);
  });

  test('GET / sin chat_id → 400', async () => {
    const h = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, query: {} }, res);
    expect(res._status).toBe(400);
  });

  test('POST / crea task', async () => {
    const h = findRoute(router, 'POST', '/');
    const req = { user: { id: 'u1' }, body: { chat_id: 'c1', title: 'Test', description: 'x' } };
    const res = mockRes();
    await runChain(h, req, res);
    expect(res._status).toBe(201);
    expect(res._body.title).toBe('Test');
  });

  test('POST / sin title → 400', async () => {
    const h = findRoute(router, 'POST', '/');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, body: { chat_id: 'c1' } }, res);
    expect(res._status).toBe(400);
  });

  test('GET / lista por chat_id', async () => {
    repo.create({ chat_id: 'c1', user_id: 'u1', title: 'T1' });
    repo.create({ chat_id: 'c2', user_id: 'u1', title: 'T2' });
    const h = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, query: { chat_id: 'c1' } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(1);
    expect(res._body[0].title).toBe('T1');
  });

  test('PATCH /:id actualiza status', async () => {
    const t = repo.create({ chat_id: 'c1', user_id: 'u1', title: 'T1' });
    const h = findRoute(router, 'PATCH', '/:id');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, params: { id: String(t.id) }, body: { chat_id: 'c1', status: 'completed' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.status).toBe('completed');
  });

  test('DELETE /:id remove', async () => {
    const t = repo.create({ chat_id: 'c1', user_id: 'u1', title: 'T1' });
    const h = findRoute(router, 'DELETE', '/:id');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, params: { id: String(t.id) }, query: { chat_id: 'c1' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.ok).toBe(true);
    expect(repo.getById(t.id, 'c1')).toBeNull();
  });
});
