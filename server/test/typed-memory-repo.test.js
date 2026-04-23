'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TypedMemoryRepository = require('../storage/TypedMemoryRepository');

let db;
let tmpDir;
let repo;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-mem-'));
  return new Database(path.join(tmpDir, 'test.db'));
}

beforeAll(async () => {
  db = await makeDB();
  repo = new TypedMemoryRepository(db);
  repo.init();
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM typed_memory').run(); });

describe('TypedMemoryRepository — validaciones', () => {
  test('scope_type inválido → throw', () => {
    expect(() => repo.create({ scope_type: 'galaxy', kind: 'user', name: 'n', body_path: '/tmp/x.md' })).toThrow(/scope_type/);
  });

  test('kind inválido → throw', () => {
    expect(() => repo.create({ scope_type: 'global', kind: 'bogus', name: 'n', body_path: '/tmp/x.md' })).toThrow(/kind/);
  });

  test('name requerido', () => {
    expect(() => repo.create({ scope_type: 'global', kind: 'user', body_path: '/tmp/x.md' })).toThrow(/name/);
  });

  test('body_path requerido', () => {
    expect(() => repo.create({ scope_type: 'global', kind: 'user', name: 'n' })).toThrow(/body_path/);
  });

  test('scope_id requerido si scope no-global', () => {
    expect(() => repo.create({ scope_type: 'user', kind: 'user', name: 'n', body_path: '/tmp/x.md' })).toThrow(/scope_id/);
  });
});

describe('TypedMemoryRepository — CRUD', () => {
  test('create + getById', () => {
    const row = repo.create({
      scope_type: 'user', scope_id: 'u1', kind: 'user',
      name: 'role', description: 'data engineer', body_path: '/tmp/role.md',
    });
    expect(row.id).toBeTruthy();
    expect(row.kind).toBe('user');
    expect(repo.getById(row.id).name).toBe('role');
  });

  test('findByName', () => {
    repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body_path: '/x.md' });
    const r = repo.findByName({ scope_type: 'user', scope_id: 'u1', name: 'role' });
    expect(r).toBeTruthy();
  });

  test('upsert actualiza existente', () => {
    repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body_path: '/x.md', description: 'v1' });
    const updated = repo.upsert({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body_path: '/y.md', description: 'v2' });
    expect(updated.description).toBe('v2');
    expect(updated.body_path).toBe('/y.md');
    expect(repo.list({ scope_type: 'user', scope_id: 'u1' })).toHaveLength(1);
  });

  test('UNIQUE constraint por (scope_type, scope_id, name)', () => {
    // Nota: SQLite permite NULLs duplicados en UNIQUE. Por eso se prueba con scope_id NO nulo.
    repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'reference', name: 'url', body_path: '/x.md' });
    expect(() =>
      repo.create({ scope_type: 'user', scope_id: 'u1', kind: 'reference', name: 'url', body_path: '/y.md' })
    ).toThrow();
  });

  test('list por scope_type/kind', () => {
    repo.create({ scope_type: 'user',  scope_id: 'u1', kind: 'user',    name: 'role',   body_path: '/1.md' });
    repo.create({ scope_type: 'user',  scope_id: 'u1', kind: 'feedback', name: 'style', body_path: '/2.md' });
    repo.create({ scope_type: 'chat',  scope_id: 'c1', kind: 'project', name: 'scope', body_path: '/3.md' });
    expect(repo.list({ scope_type: 'user', scope_id: 'u1' })).toHaveLength(2);
    expect(repo.list({ kind: 'feedback' })).toHaveLength(1);
  });

  test('update cambia campos', () => {
    const r = repo.create({ scope_type: 'global', kind: 'reference', name: 'url', body_path: '/x.md' });
    const updated = repo.update(r.id, { description: 'nueva', kind: 'project' });
    expect(updated.description).toBe('nueva');
    expect(updated.kind).toBe('project');
  });

  test('remove', () => {
    const r = repo.create({ scope_type: 'global', kind: 'reference', name: 'url', body_path: '/x.md' });
    expect(repo.remove(r.id)).toBe(true);
    expect(repo.getById(r.id)).toBeNull();
  });
});
