'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const UserPreferencesRepository = require('../storage/UserPreferencesRepository');
const createRouter = require('../routes/user-preferences');

let db, repo, tmpDir;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-'));
  return new Database(path.join(tmpDir, 'test.db'));
}

function mockRes() {
  return {
    _status: 200, _body: null,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; return this; },
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

beforeAll(async () => {
  db = await makeDB();
  repo = new UserPreferencesRepository(db);
  repo.init();
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM user_preferences').run(); });

describe('UserPreferencesRepository', () => {
  test('set + get round-trip con JSON', () => {
    repo.set('u1', 'keybindings', { 'ctrl+s': 'save', 'ctrl+p': 'palette' });
    expect(repo.get('u1', 'keybindings')).toEqual({ 'ctrl+s': 'save', 'ctrl+p': 'palette' });
  });

  test('set sobrescribe (upsert)', () => {
    repo.set('u1', 'theme', 'dark');
    repo.set('u1', 'theme', 'light');
    expect(repo.get('u1', 'theme')).toBe('light');
  });

  test('get inexistente → null', () => {
    expect(repo.get('u1', 'none')).toBeNull();
  });

  test('listByUser ordenado por key', () => {
    repo.set('u1', 'keybindings', {});
    repo.set('u1', 'theme', 'dark');
    const list = repo.listByUser('u1');
    expect(list.map(e => e.key)).toEqual(['keybindings', 'theme']);
  });

  test('aislamiento por user', () => {
    repo.set('u1', 'theme', 'dark');
    repo.set('u2', 'theme', 'light');
    expect(repo.get('u1', 'theme')).toBe('dark');
    expect(repo.get('u2', 'theme')).toBe('light');
  });

  test('remove', () => {
    repo.set('u1', 'theme', 'dark');
    expect(repo.remove('u1', 'theme')).toBe(true);
    expect(repo.get('u1', 'theme')).toBeNull();
    expect(repo.remove('u1', 'theme')).toBe(false);
  });

  test('validaciones — user_id, key requeridos', () => {
    expect(() => repo.set('', 'k', 'v')).toThrow(/user_id/);
    expect(() => repo.set('u1', '', 'v')).toThrow(/key/);
  });
});

describe('routes/user-preferences', () => {
  let router;
  beforeEach(() => { router = createRouter({ userPreferencesRepo: repo }); });

  test('factory valida dep', () => {
    expect(() => createRouter({})).toThrow(/userPreferencesRepo/);
  });

  test('GET / sin user → 401', () => {
    const res = mockRes();
    findRoute(router, 'get', '/')({ user: null }, res);
    expect(res._status).toBe(401);
  });

  test('GET / lista preferences del user', () => {
    repo.set('u1', 'a', 1);
    repo.set('u1', 'b', 2);
    const res = mockRes();
    findRoute(router, 'get', '/')({ user: { id: 'u1' } }, res);
    expect(res._body).toHaveLength(2);
  });

  test('GET /:key → value', () => {
    repo.set('u1', 'keybindings', { x: 1 });
    const res = mockRes();
    findRoute(router, 'get', '/:key')({ user: { id: 'u1' }, params: { key: 'keybindings' } }, res);
    expect(res._body.value).toEqual({ x: 1 });
  });

  test('GET /:key inexistente → 404', () => {
    const res = mockRes();
    findRoute(router, 'get', '/:key')({ user: { id: 'u1' }, params: { key: 'nope' } }, res);
    expect(res._status).toBe(404);
  });

  test('PUT /:key persiste', () => {
    const res = mockRes();
    findRoute(router, 'put', '/:key')({ user: { id: 'u1' }, params: { key: 'theme' }, body: { value: 'dark' } }, res);
    expect(res._body.value).toBe('dark');
    expect(repo.get('u1', 'theme')).toBe('dark');
  });

  test('PUT /:key sin body.value → 400', () => {
    const res = mockRes();
    findRoute(router, 'put', '/:key')({ user: { id: 'u1' }, params: { key: 'k' }, body: {} }, res);
    expect(res._status).toBe(400);
  });

  test('DELETE /:key', () => {
    repo.set('u1', 'theme', 'dark');
    const res = mockRes();
    findRoute(router, 'delete', '/:key')({ user: { id: 'u1' }, params: { key: 'theme' } }, res);
    expect(res._body.ok).toBe(true);
  });

  test('DELETE /:key inexistente → 404', () => {
    const res = mockRes();
    findRoute(router, 'delete', '/:key')({ user: { id: 'u1' }, params: { key: 'nope' } }, res);
    expect(res._status).toBe(404);
  });
});
