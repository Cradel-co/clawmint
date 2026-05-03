'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TypedMemoryRepository = require('../storage/TypedMemoryRepository');
const createRouter = require('../routes/typed-memory');

async function makeDb() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
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

describe('routes/typed-memory (C.3)', () => {
  let db, repo, router, tmpDir;

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir = m.tmpDir;
    repo = new TypedMemoryRepository(db);
    repo.init();
    router = createRouter({ typedMemoryRepo: repo, logger: { error: () => {} } });
  });

  afterAll(() => { try { db.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
  afterEach(() => { db.prepare('DELETE FROM typed_memory').run(); });

  test('POST / crea memoria tipada', async () => {
    const h = findRoute(router, 'POST', '/');
    const res = mockRes();
    await runChain(h, {
      user: { id: 'u1' },
      body: { scope_type: 'user', scope_id: 'u1', kind: 'feedback', name: 'test-pref', body_path: 'memory/user/u1/test-pref.md' },
    }, res);
    expect(res._status).toBe(201);
    expect(res._body.kind).toBe('feedback');
  });

  test('POST / sin campos obligatorios → 400', async () => {
    const h = findRoute(router, 'POST', '/');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, body: { scope_type: 'user' } }, res);
    expect(res._status).toBe(400);
  });

  test('GET / con filtros', async () => {
    repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'a', body_path: 'a.md' });
    repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'feedback', name: 'b', body_path: 'b.md' });
    repo.create({ scope_type: 'global', kind: 'project', name: 'c', body_path: 'c.md' });

    const h = findRoute(router, 'GET', '/');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, query: { scope_type: 'user' } }, res);
    expect(res._status).toBe(200);
    expect(res._body).toHaveLength(2);
  });

  test('PATCH /:id actualiza descripción', async () => {
    const row = repo.create({ scope_type: 'global', kind: 'reference', name: 'r1', body_path: 'r1.md' });
    const h = findRoute(router, 'PATCH', '/:id');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, params: { id: String(row.id) }, body: { description: 'updated' } }, res);
    expect(res._status).toBe(200);
    expect(res._body.description).toBe('updated');
  });

  test('DELETE /:id remove', async () => {
    const row = repo.create({ scope_type: 'global', kind: 'reference', name: 'r1', body_path: 'r1.md' });
    const h = findRoute(router, 'DELETE', '/:id');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, params: { id: String(row.id) } }, res);
    expect(res._status).toBe(200);
    expect(repo.getById(row.id)).toBeNull();
  });

  test('GET /:id 404 si no existe', async () => {
    const h = findRoute(router, 'GET', '/:id');
    const res = mockRes();
    await runChain(h, { user: { id: 'u1' }, params: { id: '99999' } }, res);
    expect(res._status).toBe(404);
  });
});
