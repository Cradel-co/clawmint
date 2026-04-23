'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const SharedSessionsRepository = require('../storage/SharedSessionsRepository');
const createRouter = require('../routes/session-share');

async function makeDb() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshr-'));
  return { db: new Database(path.join(tmpDir, 'test.db')), tmpDir };
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

describe('routes/session-share (Fase 12.4)', () => {
  let db, repo, router, tmpDir;
  const sessionManagerMock = {
    get: (id) => id === 'valid-session' ? { id, userId: 'owner1' } : null,
  };

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir = m.tmpDir;
    repo = new SharedSessionsRepository(db);
    repo.init();
    router = createRouter({ sharedSessionsRepo: repo, sessionManager: sessionManagerMock, logger: { error: () => {} } });
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM shared_sessions').run(); });

  test('POST /sessions/:id/share sin auth → 401', async () => {
    const handler = findRoute(router, 'POST', '/sessions/:id/share');
    const req = { params: { id: 'valid-session' }, body: {}, user: null };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  test('POST /sessions/:id/share con owner → 201', async () => {
    const handler = findRoute(router, 'POST', '/sessions/:id/share');
    const req = { params: { id: 'valid-session' }, body: { ttlHours: 2 }, user: { id: 'owner1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._body.token).toBeDefined();
    expect(res._body.session_id).toBe('valid-session');
  });

  test('POST /sessions/:id/share con usuario NO-owner → 403', async () => {
    const handler = findRoute(router, 'POST', '/sessions/:id/share');
    const req = { params: { id: 'valid-session' }, body: {}, user: { id: 'other-user' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(403);
  });

  test('POST /sessions/:id/share con sesión inexistente → 404', async () => {
    const handler = findRoute(router, 'POST', '/sessions/:id/share');
    const req = { params: { id: 'unknown' }, body: {}, user: { id: 'owner1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  test('GET /session-share/:token resuelve record', async () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const handler = findRoute(router, 'GET', '/session-share/:token');
    const req = { params: { token }, user: { id: 'u2' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body.session_id).toBe('s1');
  });

  test('GET /session-share/:token con token inválido → 404', async () => {
    const handler = findRoute(router, 'GET', '/session-share/:token');
    const req = { params: { token: 'bad' }, user: { id: 'u1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  test('GET /session-share/:token respeta allowedUserIds', async () => {
    const { token } = repo.create({
      session_id: 's1', owner_id: 'u1',
      permissions: { read: true, write: false, allowedUserIds: ['u2', 'u3'] },
    });
    const handler = findRoute(router, 'GET', '/session-share/:token');

    // u4 no está en lista → 403
    const req1 = { params: { token }, user: { id: 'u4' } };
    const res1 = mockRes();
    await handler(req1, res1);
    expect(res1._status).toBe(403);

    // u2 sí
    const req2 = { params: { token }, user: { id: 'u2' } };
    const res2 = mockRes();
    await handler(req2, res2);
    expect(res2._status).toBe(200);

    // owner también
    const req3 = { params: { token }, user: { id: 'u1' } };
    const res3 = mockRes();
    await handler(req3, res3);
    expect(res3._status).toBe(200);
  });

  test('DELETE /session-share/:token solo owner', async () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const handler = findRoute(router, 'DELETE', '/session-share/:token');

    // No-owner
    const req1 = { params: { token }, user: { id: 'u2' } };
    const res1 = mockRes();
    await handler(req1, res1);
    expect(res1._status).toBe(403);
    expect(repo.getByToken(token)).not.toBeNull();

    // Owner
    const req2 = { params: { token }, user: { id: 'u1' } };
    const res2 = mockRes();
    await handler(req2, res2);
    expect(res2._status).toBe(200);
    expect(repo.getByToken(token)).toBeNull();
  });

  test('GET /session-share lista shares del usuario', async () => {
    repo.create({ session_id: 's1', owner_id: 'u1' });
    repo.create({ session_id: 's2', owner_id: 'u1' });
    repo.create({ session_id: 's3', owner_id: 'u2' });
    const handler = findRoute(router, 'GET', '/session-share');
    const req = { user: { id: 'u1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res._body).toHaveLength(2);
  });

  test('factory throwea sin sharedSessionsRepo', () => {
    expect(() => createRouter({})).toThrow(/sharedSessionsRepo/);
  });
});
