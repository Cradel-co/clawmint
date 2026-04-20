'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const HookRepository = require('../storage/HookRepository');

let db;
let tmpDir;
let repo;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-repo-'));
  return new Database(path.join(tmpDir, 'test.db'));
}

beforeAll(async () => {
  db = await makeDB();
  repo = new HookRepository(db);
  repo.init();
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM hooks').run(); });

describe('HookRepository — validaciones', () => {
  test('event inválido throwea', () => {
    expect(() => repo.create({ event: 'fake', handler_type: 'js', handler_ref: 'x' })).toThrow(/event inválido/);
  });

  test('scope_type inválido', () => {
    expect(() => repo.create({ event: 'pre_tool_use', scope_type: 'bogus', handler_type: 'js', handler_ref: 'x', scope_id: 'x' })).toThrow(/scope_type/);
  });

  test('handler_type inválido', () => {
    expect(() => repo.create({ event: 'pre_tool_use', handler_type: 'rust', handler_ref: 'x' })).toThrow(/handler_type/);
  });

  test('handler_ref requerido', () => {
    expect(() => repo.create({ event: 'pre_tool_use', handler_type: 'js' })).toThrow(/handler_ref/);
  });

  test('scope_id requerido si scope_type non-global', () => {
    expect(() => repo.create({ event: 'pre_tool_use', scope_type: 'chat', handler_type: 'js', handler_ref: 'x' })).toThrow(/scope_id/);
  });
});

describe('HookRepository — CRUD', () => {
  test('create + getById', () => {
    const h = repo.create({
      event: 'pre_tool_use', handler_type: 'js', handler_ref: 'audit_log',
      priority: 80, timeout_ms: 5000, reason: 'audit',
    });
    expect(h.id).toBeTruthy();
    expect(h.event).toBe('pre_tool_use');
    expect(h.enabled).toBe(true);
    expect(h.priority).toBe(80);
  });

  test('list con filtros', () => {
    repo.create({ event: 'pre_tool_use',  handler_type: 'js', handler_ref: 'a' });
    repo.create({ event: 'post_tool_use', handler_type: 'js', handler_ref: 'b' });
    repo.create({ event: 'pre_tool_use',  handler_type: 'http', handler_ref: 'https://example.com/x' });

    expect(repo.list({ event: 'pre_tool_use' })).toHaveLength(2);
    expect(repo.list({ handler_type: 'http' })).toHaveLength(1);
    expect(repo.list()).toHaveLength(3);
  });

  test('list ordenado por priority DESC', () => {
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'low',  priority: 10 });
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'high', priority: 100 });
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'mid',  priority: 50 });
    const list = repo.list({ event: 'pre_tool_use' });
    expect(list.map(h => h.handler_ref)).toEqual(['high', 'mid', 'low']);
  });

  test('update modifica campos', () => {
    const h = repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'x', priority: 50 });
    const updated = repo.update(h.id, { priority: 99, enabled: false });
    expect(updated.priority).toBe(99);
    expect(updated.enabled).toBe(false);
  });

  test('update con event inválido throwea', () => {
    const h = repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'x' });
    expect(() => repo.update(h.id, { event: 'foo' })).toThrow(/event inválido/);
  });

  test('remove', () => {
    const h = repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'x' });
    expect(repo.remove(h.id)).toBe(true);
    expect(repo.getById(h.id)).toBeNull();
    expect(repo.remove(h.id)).toBe(false);
  });

  test('count', () => {
    expect(repo.count()).toBe(0);
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'a' });
    repo.create({ event: 'post_tool_use', handler_type: 'js', handler_ref: 'b' });
    expect(repo.count()).toBe(2);
  });

  test('filter por enabled', () => {
    const a = repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'a' });
    repo.create({ event: 'pre_tool_use', handler_type: 'js', handler_ref: 'b', enabled: false });
    expect(repo.list({ enabled: true })).toHaveLength(1);
    expect(repo.list({ enabled: false })).toHaveLength(1);
    repo.update(a.id, { enabled: false });
    expect(repo.list({ enabled: false })).toHaveLength(2);
  });
});
