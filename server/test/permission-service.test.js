'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const PermissionRepository = require('../storage/PermissionRepository');
const PermissionService    = require('../core/PermissionService');

let db;
let tmpDir;
let repo;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psvc-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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

afterEach(() => { db.prepare('DELETE FROM permissions').run(); });

describe('PermissionService — flag enabled', () => {
  test('enabled=false → siempre "auto" incluso con reglas deny', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    const svc = new PermissionService({ repo, enabled: false });
    expect(svc.resolve('bash', { chatId: 'c1' })).toBe('auto');
  });

  test('enabled=true → respeta reglas', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'deny' });
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.resolve('bash', { chatId: 'c1' })).toBe('deny');
  });

  test('sin reglas que matcheen → default "auto" (retrocompat)', () => {
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.resolve('bash', { chatId: 'c1' })).toBe('auto');
  });

  test('enabled property expone el estado', () => {
    const svc = new PermissionService({ repo, enabled: false });
    expect(svc.enabled).toBe(false);
  });

  test('lee PERMISSIONS_ENABLED env si no se pasa enabled', () => {
    const orig = process.env.PERMISSIONS_ENABLED;
    process.env.PERMISSIONS_ENABLED = 'true';
    const svc = new PermissionService({ repo });
    expect(svc.enabled).toBe(true);
    if (orig === undefined) delete process.env.PERMISSIONS_ENABLED;
    else process.env.PERMISSIONS_ENABLED = orig;
  });
});

describe('PermissionService — resolución', () => {
  test('deny bloquea tool', () => {
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny' });
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.resolve('bash', { chatId: 'c1' })).toBe('deny');
  });

  test('ask retorna ask', () => {
    repo.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'write_file', action: 'ask' });
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.resolve('write_file', { chatId: 'c1' })).toBe('ask');
  });

  test('auto explícito retorna auto', () => {
    repo.create({ scope_type: 'global', tool_pattern: 'bash', action: 'auto' });
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.resolve('bash', {})).toBe('auto');
  });

  test('resuelve role via usersRepo si no viene en ctx', () => {
    const usersRepo = {
      getById: (id) => id === 'u1' ? { id: 'u1', role: 'admin' } : null,
      findByIdentity: () => null,
    };
    repo.create({ scope_type: 'role', scope_id: 'admin', tool_pattern: 'bash', action: 'auto' });
    repo.create({ scope_type: 'role', scope_id: 'user',  tool_pattern: 'bash', action: 'deny' });
    const svc = new PermissionService({ repo, usersRepo, enabled: true });
    expect(svc.resolve('bash', { userId: 'u1' })).toBe('auto');
  });
});

describe('PermissionService — API CRUD', () => {
  test('list/create/remove funcionan', () => {
    const svc = new PermissionService({ repo, enabled: true });
    expect(svc.count()).toBe(0);
    const r = svc.create({ scope_type: 'chat', scope_id: 'c1', tool_pattern: 'bash', action: 'deny' });
    expect(svc.count()).toBe(1);
    expect(svc.list()).toHaveLength(1);
    expect(svc.getById(r.id)).toBeTruthy();
    expect(svc.remove(r.id)).toBe(true);
    expect(svc.count()).toBe(0);
  });
});
