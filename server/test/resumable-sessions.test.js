'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ResumableSessionsRepository = require('../storage/ResumableSessionsRepository');

async function makeDb() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  return { db: new Database(path.join(tmpDir, 'test.db')), tmpDir };
}

describe('ResumableSessionsRepository (Fase 4 extra)', () => {
  let db, repo, tmpDir;

  beforeAll(async () => {
    const m = await makeDb();
    db = m.db; tmpDir = m.tmpDir;
    repo = new ResumableSessionsRepository(db);
    repo.init();
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM resumable_sessions').run(); });

  test('create requiere chat_id, resume_prompt, trigger_at', () => {
    expect(() => repo.create({ resume_prompt: 'x', trigger_at: 1 })).toThrow(/chat_id/);
    expect(() => repo.create({ chat_id: 'c', trigger_at: 1 })).toThrow(/resume_prompt/);
    expect(() => repo.create({ chat_id: 'c', resume_prompt: 'x' })).toThrow(/trigger_at/);
  });

  test('create persiste con status pending', () => {
    const r = repo.create({
      chat_id: 'c1', agent_key: 'a', provider: 'anthropic',
      resume_prompt: 'retomá', trigger_at: Date.now() + 1000,
      history: [{ role: 'user', content: 'hola' }],
    });
    expect(r.id).toBeGreaterThan(0);
    expect(r.status).toBe('pending');
    expect(r.history).toEqual([{ role: 'user', content: 'hola' }]);
  });

  test('listReady filtra por trigger_at <= now y status=pending', () => {
    const past = repo.create({ chat_id: 'c1', resume_prompt: 'p', trigger_at: Date.now() - 1000 });
    const future = repo.create({ chat_id: 'c2', resume_prompt: 'p', trigger_at: Date.now() + 10_000 });
    const ready = repo.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(past.id);
  });

  test('markFired cambia status', () => {
    const r = repo.create({ chat_id: 'c1', resume_prompt: 'p', trigger_at: Date.now() - 100 });
    expect(repo.markFired(r.id)).toBe(true);
    expect(repo.getById(r.id).status).toBe('fired');
    // Idempotente
    expect(repo.markFired(r.id)).toBe(false);
  });

  test('cancel cambia status a cancelled', () => {
    const r = repo.create({ chat_id: 'c1', resume_prompt: 'p', trigger_at: Date.now() + 10_000 });
    expect(repo.cancel(r.id)).toBe(true);
    expect(repo.getById(r.id).status).toBe('cancelled');
  });

  test('listByChatId', () => {
    repo.create({ chat_id: 'c1', resume_prompt: 'p1', trigger_at: Date.now() + 1000 });
    repo.create({ chat_id: 'c1', resume_prompt: 'p2', trigger_at: Date.now() + 2000 });
    repo.create({ chat_id: 'c2', resume_prompt: 'p3', trigger_at: Date.now() + 3000 });
    expect(repo.listByChatId('c1')).toHaveLength(2);
    expect(repo.listByChatId('c2')).toHaveLength(1);
  });

  test('remove borra definitivamente', () => {
    const r = repo.create({ chat_id: 'c1', resume_prompt: 'p', trigger_at: Date.now() + 1000 });
    expect(repo.remove(r.id)).toBe(true);
    expect(repo.getById(r.id)).toBeNull();
  });

  test('history + context se round-tripean', () => {
    const r = repo.create({
      chat_id: 'c1', resume_prompt: 'x', trigger_at: Date.now() + 1000,
      history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      context: { botKey: 'web', foo: 42 },
    });
    const got = repo.getById(r.id);
    expect(got.history).toHaveLength(2);
    expect(got.context.foo).toBe(42);
  });
});
