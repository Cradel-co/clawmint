'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const SharedSessionsRepository = require('../storage/SharedSessionsRepository');
const SharedSessionsBroker = require('../core/SharedSessionsBroker');

async function makeDb() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  return { db: new Database(path.join(tmpDir, 'test.db')), tmpDir };
}

describe('SharedSessionsRepository (Fase 12.4)', () => {
  let db, repo, tmpDir;

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir = m.tmpDir;
    repo = new SharedSessionsRepository(db);
    repo.init();
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM shared_sessions').run(); });

  test('create genera token único opaco', () => {
    const a = repo.create({ session_id: 's1', owner_id: 'u1' });
    const b = repo.create({ session_id: 's1', owner_id: 'u1' });
    expect(a.token).toBeDefined();
    expect(a.token.length).toBeGreaterThan(20);
    expect(a.token).not.toBe(b.token);
  });

  test('getByToken retorna record válido', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1', ttlHours: 1 });
    const found = repo.getByToken(token);
    expect(found.session_id).toBe('s1');
    expect(found.owner_id).toBe('u1');
    expect(found.permissions).toEqual({ read: true, write: false });
    expect(found.expires_at).toBeGreaterThan(Date.now());
  });

  test('getByToken retorna null si expirado', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1', ttlHours: 1 });
    // Forzar expiración
    db.prepare('UPDATE shared_sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    expect(repo.getByToken(token)).toBeNull();
  });

  test('getByToken retorna null si token inexistente', () => {
    expect(repo.getByToken('nope')).toBeNull();
  });

  test('ttlHours=null crea share sin expiración', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1', ttlHours: null });
    const found = repo.getByToken(token);
    expect(found.expires_at).toBeNull();
  });

  test('permissions custom se persisten', () => {
    const perms = { read: true, write: true, allowedUserIds: ['u2'] };
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1', permissions: perms });
    const found = repo.getByToken(token);
    expect(found.permissions).toEqual(perms);
  });

  test('listByOwner retorna shares del usuario', () => {
    repo.create({ session_id: 's1', owner_id: 'u1' });
    repo.create({ session_id: 's2', owner_id: 'u1' });
    repo.create({ session_id: 's3', owner_id: 'u2' });
    expect(repo.listByOwner('u1')).toHaveLength(2);
    expect(repo.listByOwner('u2')).toHaveLength(1);
  });

  test('listBySession filtra expirados', () => {
    const { token: t1 } = repo.create({ session_id: 's1', owner_id: 'u1', ttlHours: 1 });
    repo.create({ session_id: 's1', owner_id: 'u2' });
    db.prepare('UPDATE shared_sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, t1);
    const active = repo.listBySession('s1');
    expect(active).toHaveLength(1);
    expect(active[0].owner_id).toBe('u2');
  });

  test('remove borra share', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    expect(repo.remove(token)).toBe(true);
    expect(repo.getByToken(token)).toBeNull();
    expect(repo.remove(token)).toBe(false); // idempotente
  });

  test('removeExpired purga solo los expirados', () => {
    const { token: t1 } = repo.create({ session_id: 's1', owner_id: 'u1', ttlHours: 1 });
    repo.create({ session_id: 's2', owner_id: 'u1', ttlHours: 1 });
    db.prepare('UPDATE shared_sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, t1);
    expect(repo.removeExpired()).toBe(1);
    expect(repo.listByOwner('u1')).toHaveLength(1);
  });

  test('create sin session_id/owner_id throwea', () => {
    expect(() => repo.create({ owner_id: 'u1' })).toThrow(/session_id/);
    expect(() => repo.create({ session_id: 's1' })).toThrow(/owner_id/);
  });
});

describe('SharedSessionsBroker (Fase 12.4)', () => {
  let db, repo, bus, broker, tmpDir2;

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir2 = m.tmpDir;
    repo = new SharedSessionsRepository(db);
    repo.init();
  });

  beforeEach(() => {
    bus = new EventEmitter();
    broker = new SharedSessionsBroker({ sharedSessionsRepo: repo, eventBus: bus, logger: { info: () => {}, warn: () => {} } });
  });

  afterEach(() => { db.prepare('DELETE FROM shared_sessions').run(); });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
  });

  function mockWs() {
    return {
      readyState: 1,
      _handlers: {},
      sent: [],
      on(ev, fn) { this._handlers[ev] = fn; },
      send(m) { this.sent.push(m); },
    };
  }

  test('subscribe con token válido agrega ws y envía share_ready', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const ws = mockWs();
    const ok = broker.subscribe(ws, token);
    expect(ok).toBe(true);
    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.type).toBe('share_ready');
    expect(parsed.session_id).toBe('s1');
    expect(broker.subscriberCount('s1')).toBe(1);
  });

  test('subscribe con token inválido rechaza', () => {
    const ws = mockWs();
    const ok = broker.subscribe(ws, 'nope');
    expect(ok).toBe(false);
    expect(JSON.parse(ws.sent[0]).type).toBe('share_error');
  });

  test('broadcast envía a todos los ws suscritos', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const a = mockWs(); const b = mockWs();
    broker.subscribe(a, token);
    broker.subscribe(b, token);
    const n = broker.broadcast('s1', { type: 'test', data: 1 });
    expect(n).toBe(2);
    // Cada ws recibió share_ready + broadcast
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(2);
  });

  test('broadcast via eventBus replica chat:message por sessionId', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const ws = mockWs();
    broker.subscribe(ws, token);
    bus.emit('chat:message', { sessionId: 's1', text: 'hola' });
    // 2 mensajes: share_ready + chat:message
    expect(ws.sent).toHaveLength(2);
    const parsed = JSON.parse(ws.sent[1]);
    expect(parsed.type).toBe('chat:message');
    expect(parsed.payload.text).toBe('hola');
  });

  test('eventos sin sessionId se ignoran', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const ws = mockWs();
    broker.subscribe(ws, token);
    bus.emit('chat:message', { text: 'sin session' });
    expect(ws.sent).toHaveLength(1); // solo share_ready
  });

  test('close del ws limpia suscripción', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const ws = mockWs();
    broker.subscribe(ws, token);
    expect(broker.subscriberCount('s1')).toBe(1);
    ws._handlers.close && ws._handlers.close();
    expect(broker.subscriberCount('s1')).toBe(0);
  });

  test('broadcast a session sin suscriptores retorna 0', () => {
    expect(broker.broadcast('nope', { type: 'x' })).toBe(0);
  });

  test('ws en readyState !== 1 se omite', () => {
    const { token } = repo.create({ session_id: 's1', owner_id: 'u1' });
    const ws = mockWs();
    broker.subscribe(ws, token);
    ws.readyState = 3; // CLOSED
    const n = broker.broadcast('s1', { type: 't' });
    expect(n).toBe(0);
  });
});
