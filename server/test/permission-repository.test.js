'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const PermissionRepository = require('../storage/PermissionRepository');

let db;
let tmpDir;
let repo;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

beforeAll(async () => {
  db = await makeDB();
  repo = new PermissionRepository(db);
  repo.init();
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  // limpiar entre tests
  db.prepare('DELETE FROM permissions').run();
});

describe('PermissionRepository — validaciones', () => {
  test('scope_type inválido → throw', () => {
    expect(() => repo.create({ scope_type: 'galaxy', scope_id: 'x', tool_pattern: 'bash', action: 'deny' }))
      .toThrow(/scope_type inválido/);
  });

  test('action inválido → throw', () => {
    expect(() => repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'launch' }))
      .toThrow(/action inválido/);
  });

  test('tool_pattern requerido', () => {
    expect(() => repo.create({ scope_type: 'global', action: 'auto' })).toThrow(/tool_pattern/);
  });

  test('scope_id requerido para scope non-global', () => {
    expect(() => repo.create({ scope_type: 'user', tool_pattern: 'bash', action: 'ask' }))
      .toThrow(/scope_id requerido/);
  });
});

describe('PermissionRepository — CRUD', () => {
  test('create + getById', () => {
    const rule = repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny', reason: 'prueba' });
    expect(rule.id).toBeTruthy();
    expect(rule.action).toBe('deny');
    expect(rule.reason).toBe('prueba');
    const got = repo.getById(rule.id);
    expect(got.tool_pattern).toBe('bash');
  });

  test('list por scope', () => {
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash',  action: 'deny' });
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'write_file', action: 'ask' });
    repo.create({ scope_type: 'user', scope_id: 'u1', tool_pattern: 'webfetch',   action: 'deny' });
    expect(repo.list({ scope_type: 'chat' })).toHaveLength(2);
    expect(repo.list({ scope_type: 'user' })).toHaveLength(1);
    expect(repo.list()).toHaveLength(3);
  });

  test('remove', () => {
    const r = repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    expect(repo.remove(r.id)).toBe(true);
    expect(repo.getById(r.id)).toBeNull();
    expect(repo.remove(r.id)).toBe(false);
  });

  test('count', () => {
    expect(repo.count()).toBe(0);
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    repo.create({ scope_type: 'global', tool_pattern: 'write_file', action: 'ask' });
    expect(repo.count()).toBe(2);
  });
});

describe('PermissionRepository — resolve (scope priority)', () => {
  test('scope chat gana sobre global', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'auto' });
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny' });
    const r = repo.resolve('bash', { chatId: 'c1' });
    expect(r.action).toBe('deny');
  });

  test('scope user gana sobre role', () => {
    repo.create({ scope_type: 'role', scope_id: 'user', tool_pattern: 'bash', action: 'ask' });
    repo.create({ scope_type: 'user', scope_id: 'u1', tool_pattern: 'bash', action: 'deny' });
    const r = repo.resolve('bash', { userId: 'u1', role: 'user' });
    expect(r.action).toBe('deny');
  });

  test('sin match → null', () => {
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny' });
    expect(repo.resolve('webfetch', { chatId: 'c1' })).toBeNull();
    expect(repo.resolve('bash', { chatId: 'c2' })).toBeNull();
  });

  test('global matchea sin scope_id en ctx', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'ask' });
    const r = repo.resolve('bash', {});
    expect(r.action).toBe('ask');
  });
});

describe('PermissionRepository — wildcards y especificidad', () => {
  test('wildcard * matchea cualquier tool', () => {
    repo.create({ scope_type: 'global', tool_pattern: '*', action: 'ask' });
    expect(repo.resolve('bash', {}).action).toBe('ask');
    expect(repo.resolve('webfetch', {}).action).toBe('ask');
  });

  test('prefix_* matchea por prefijo', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'pty_*', action: 'deny' });
    expect(repo.resolve('pty_create', {}).action).toBe('deny');
    expect(repo.resolve('pty_exec', {}).action).toBe('deny');
    expect(repo.resolve('bash', {})).toBeNull();
  });

  test('patrón más específico gana (exact > prefix > star)', () => {
    repo.create({ scope_type: 'global', tool_pattern: '*',        action: 'ask' });
    repo.create({ scope_type: 'global', tool_pattern: 'pty_*',    action: 'deny' });
    repo.create({ scope_type: 'global', tool_pattern: 'pty_exec', action: 'auto' });
    expect(repo.resolve('pty_exec', {}).action).toBe('auto');
    expect(repo.resolve('pty_create', {}).action).toBe('deny');
    expect(repo.resolve('bash', {}).action).toBe('ask');
  });

  test('tie-break por created_at DESC cuando misma especificidad', () => {
    // Crear dos reglas con mismo pattern exacto en el mismo scope
    const r1 = repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'ask' });
    // Forzar created_at distinto
    db.prepare('UPDATE permissions SET created_at = ? WHERE id = ?').run(1000, r1.id);
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    const r = repo.resolve('bash', {});
    expect(r.action).toBe('deny');  // la más reciente
  });
});
