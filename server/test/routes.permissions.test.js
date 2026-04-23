'use strict';

/**
 * Tests de routes/permissions.js + middleware/requireAdmin.
 *
 * No usa supertest (no está en el proyecto). Invoca los handlers directamente con
 * req/res mocks, como el resto de tests del proyecto.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const PermissionRepository = require('../storage/PermissionRepository');
const PermissionService    = require('../core/PermissionService');
const createRequireAdmin   = require('../middleware/requireAdmin');
const createPermsRouter    = require('../routes/permissions');

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; return this; },
    send(b) { this._body = b; return this; },
  };
}

function findRoute(router, method, pathStr) {
  const m = method.toLowerCase();
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathStr && layer.route.methods[m]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`Route ${method} ${pathStr} no encontrada`);
}

let db;
let tmpDir;
let repo;
let svc;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-perm-test-'));
  return new Database(path.join(tmpDir, 'test.db'));
}

beforeAll(async () => {
  db = await makeDB();
  repo = new PermissionRepository(db);
  repo.init();
  svc = new PermissionService({ repo, enabled: true });
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM permissions').run(); });

// ── Middleware requireAdmin ─────────────────────────────────────────────────

describe('requireAdmin middleware', () => {
  const usersRepo = {
    getById: (id) => ({
      'u-admin': { id: 'u-admin', role: 'admin' },
      'u-user':  { id: 'u-user',  role: 'user' },
    }[id] || null),
  };
  const mw = createRequireAdmin({ usersRepo });

  test('user no autenticado → 401', () => {
    const res = mockRes();
    let called = false;
    mw({ user: null }, res, () => { called = true; });
    expect(res._status).toBe(401);
    expect(called).toBe(false);
  });

  test('user no-admin → 403', () => {
    const res = mockRes();
    let called = false;
    mw({ user: { id: 'u-user' } }, res, () => { called = true; });
    expect(res._status).toBe(403);
    expect(called).toBe(false);
  });

  test('admin → next()', () => {
    const res = mockRes();
    let called = false;
    mw({ user: { id: 'u-admin' } }, res, () => { called = true; });
    expect(called).toBe(true);
  });

  test('internal request bypassea verificación', () => {
    const res = mockRes();
    let called = false;
    mw({ user: { id: '__internal__', internal: true } }, res, () => { called = true; });
    expect(called).toBe(true);
  });

  test('requireAdmin factory sin usersRepo → throw', () => {
    expect(() => createRequireAdmin({})).toThrow(/usersRepo/);
  });
});

// ── Router /api/permissions ─────────────────────────────────────────────────

describe('routes/permissions', () => {
  test('GET /status retorna enabled + count', () => {
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'get', '/status');
    const res = mockRes();
    handler({ query: {} }, res);
    expect(res._body).toEqual({ enabled: true, count: 0 });
  });

  test('POST / crea regla y retorna 201', () => {
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'post', '/');
    const res = mockRes();
    handler({ body: { scope_type: 'global', tool_pattern: 'bash', action: 'deny' } }, res);
    expect(res._status).toBe(201);
    expect(res._body.id).toBeTruthy();
    expect(res._body.action).toBe('deny');
  });

  test('POST / con body inválido retorna 400', () => {
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'post', '/');
    const res = mockRes();
    handler({ body: { scope_type: 'bogus', tool_pattern: 'x', action: 'deny' } }, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/scope_type/);
  });

  test('GET / lista reglas', () => {
    svc.create({ scope_type: 'global', tool_pattern: 'bash', action: 'ask' });
    svc.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'webfetch', action: 'deny' });
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'get', '/');
    const res = mockRes();
    handler({ query: {} }, res);
    expect(res._body).toHaveLength(2);
  });

  test('GET / con filtro scope_type', () => {
    svc.create({ scope_type: 'global', tool_pattern: 'bash', action: 'ask' });
    svc.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'webfetch', action: 'deny' });
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'get', '/');
    const res = mockRes();
    handler({ query: { scope_type: 'global' } }, res);
    expect(res._body).toHaveLength(1);
    expect(res._body[0].scope_type).toBe('global');
  });

  test('DELETE /:id elimina', () => {
    const r = svc.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'delete', '/:id');
    const res = mockRes();
    handler({ params: { id: String(r.id) } }, res);
    expect(res._body).toEqual({ ok: true });
    expect(svc.getById(r.id)).toBeNull();
  });

  test('DELETE /:id con id inexistente → 404', () => {
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'delete', '/:id');
    const res = mockRes();
    handler({ params: { id: '99999' } }, res);
    expect(res._status).toBe(404);
  });

  test('DELETE /:id con id inválido → 400', () => {
    const router = createPermsRouter({ permissionService: svc });
    const handler = findRoute(router, 'delete', '/:id');
    const res = mockRes();
    handler({ params: { id: 'abc' } }, res);
    expect(res._status).toBe(400);
  });

  test('Router factory sin permissionService → throw', () => {
    expect(() => createPermsRouter({})).toThrow(/permissionService/);
  });
});
