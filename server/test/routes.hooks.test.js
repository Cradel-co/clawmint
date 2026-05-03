'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const HookRepository = require('../storage/HookRepository');
const HookRegistry   = require('../core/HookRegistry');
const HookLoader     = require('../core/HookLoader');
const JsExecutor     = require('../hooks/executors/jsExecutor');
const createHooksRouter = require('../routes/hooks');

function mockRes() {
  return {
    _status: 200, _body: null,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; return this; },
    send(b) { this._body = b; return this; },
  };
}

function findRoute(router, method, pathStr) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathStr && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`Route ${method} ${pathStr} no encontrada`);
}

let db;
let tmpDir;
let repo;
let registry;
let loader;
let router;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-hooks-'));
  return new Database(path.join(tmpDir, 'test.db'));
}

beforeAll(async () => {
  db = await makeDB();
  repo = new HookRepository(db);
  repo.init();
  registry = new HookRegistry({ enabled: true, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  const js = new JsExecutor();
  js.registerHandler('audit_log', async () => null);
  registry.registerExecutor('js', js);
  loader = new HookLoader({ registry, repo, logger: { info: () => {}, warn: () => {} } });
  router = createHooksRouter({ hooksRepo: repo, hookRegistry: registry, hookLoader: loader });
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM hooks').run(); registry.clear(); });

describe('routes/hooks', () => {
  test('GET /status retorna enabled + count + executors', () => {
    const handler = findRoute(router, 'get', '/status');
    const res = mockRes();
    handler({ query: {} }, res);
    expect(res._body.enabled).toBe(true);
    expect(res._body.count).toBe(0);
    expect(res._body.executors).toEqual(expect.arrayContaining(['js']));
  });

  test('POST / crea hook + lo registra en registry', () => {
    const post = findRoute(router, 'post', '/');
    const res = mockRes();
    post({ body: { event: 'pre_tool_use', handler_type: 'js', handler_ref: 'audit_log' } }, res);
    expect(res._status).toBe(201);
    expect(res._body.event).toBe('pre_tool_use');
    // Verificar que está registrado en el registry
    expect(registry.listForEvent('pre_tool_use')).toHaveLength(1);
  });

  test('POST / con body inválido → 400', () => {
    const post = findRoute(router, 'post', '/');
    const res = mockRes();
    post({ body: { event: 'bogus', handler_type: 'js', handler_ref: 'x' } }, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/event/);
  });

  test('GET / con filtro por event', () => {
    repo.create({ event: 'pre_tool_use',  handler_type: 'js', handler_ref: 'a' });
    repo.create({ event: 'post_tool_use', handler_type: 'js', handler_ref: 'b' });
    const get = findRoute(router, 'get', '/');
    const res = mockRes();
    get({ query: { event: 'pre_tool_use' } }, res);
    expect(res._body).toHaveLength(1);
  });

  test('PATCH /:id actualiza + re-registra', () => {
    const post = findRoute(router, 'post', '/');
    const r = mockRes();
    post({ body: { event: 'pre_tool_use', handler_type: 'js', handler_ref: 'audit_log', priority: 50 } }, r);
    const id = r._body.id;

    const patch = findRoute(router, 'patch', '/:id');
    const res = mockRes();
    patch({ params: { id: String(id) }, body: { priority: 100 } }, res);
    expect(res._body.priority).toBe(100);
  });

  test('PATCH /:id inexistente → 404', () => {
    const patch = findRoute(router, 'patch', '/:id');
    const res = mockRes();
    patch({ params: { id: '99999' }, body: { priority: 10 } }, res);
    expect(res._status).toBe(404);
  });

  test('DELETE /:id elimina + unregister', () => {
    const post = findRoute(router, 'post', '/');
    const rCreate = mockRes();
    post({ body: { event: 'pre_tool_use', handler_type: 'js', handler_ref: 'audit_log' } }, rCreate);
    const id = rCreate._body.id;

    const del = findRoute(router, 'delete', '/:id');
    const res = mockRes();
    del({ params: { id: String(id) } }, res);
    expect(res._body).toEqual({ ok: true });
    expect(registry.listForEvent('pre_tool_use')).toHaveLength(0);
  });

  test('POST /reload devuelve count', async () => {
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'audit_log' });
    const handler = findRoute(router, 'post', '/reload');
    const res = mockRes();
    await handler({}, res);
    expect(res._body.ok).toBe(true);
    expect(res._body.count).toBe(1);
  });

  test('factory valida deps', () => {
    expect(() => createHooksRouter({})).toThrow(/hooksRepo.*hookRegistry/);
  });
});
