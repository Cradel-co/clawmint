'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TypedMemoryRepository = require('../storage/TypedMemoryRepository');
const TypedMemoryService = require('../services/TypedMemoryService');

let db;
let tmpDir;
let repo;
let svc;

async function setup() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-mem-svc-'));
  db = new Database(path.join(tmpDir, 'test.db'));
  repo = new TypedMemoryRepository(db);
  repo.init();
  svc = new TypedMemoryService({
    repo,
    memoryRoot: path.join(tmpDir, 'mem'),
    logger: { info: () => {}, warn: () => {} },
  });
}

beforeAll(async () => setup());

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM typed_memory').run(); });

describe('TypedMemoryService — save/get/list/forget', () => {
  test('save persiste en disco + row', () => {
    const row = svc.save({
      scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role',
      description: 'dev senior', body: '# Rol\n\nSenior dev con 10 años.',
    });
    expect(row.id).toBeTruthy();
    expect(row.description).toBe('dev senior');
    const filePath = path.join(svc.memoryRoot, row.body_path);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toMatch(/Senior dev/);
  });

  test('get devuelve metadata + body', () => {
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body: 'body X' });
    const r = svc.get({ scope_type: 'user', scope_id: 'u1', name: 'role' });
    expect(r.body).toBe('body X');
    expect(r.kind).toBe('user');
  });

  test('get para name inexistente → null', () => {
    expect(svc.get({ scope_type: 'user', scope_id: 'u1', name: 'no' })).toBeNull();
  });

  test('save upserts: misma (scope, name) sobrescribe', () => {
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body: 'v1' });
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', body: 'v2' });
    expect(svc.list({ scope_type: 'user', scope_id: 'u1' })).toHaveLength(1);
    expect(svc.get({ scope_type: 'user', scope_id: 'u1', name: 'role' }).body).toBe('v2');
  });

  test('list filtra por kind', () => {
    svc.save({ scope_type: 'chat', scope_id: 'c1', kind: 'project', name: 'n1', body: 'a' });
    svc.save({ scope_type: 'chat', scope_id: 'c1', kind: 'feedback', name: 'n2', body: 'b' });
    expect(svc.list({ scope_type: 'chat', scope_id: 'c1', kind: 'project' })).toHaveLength(1);
  });

  test('forget elimina archivo + row', () => {
    const row = svc.save({ scope_type: 'global', kind: 'reference', name: 'url', body: 'https://...' });
    const filePath = path.join(svc.memoryRoot, row.body_path);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(svc.forget({ scope_type: 'global', scope_id: null, name: 'url' })).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(svc.get({ scope_type: 'global', scope_id: null, name: 'url' })).toBeNull();
  });

  test('forget de name inexistente → false', () => {
    expect(svc.forget({ scope_type: 'global', scope_id: null, name: 'nope' })).toBe(false);
  });
});

describe('TypedMemoryService — validaciones de name', () => {
  test('name con caracteres inválidos → throw', () => {
    expect(() => svc.save({ scope_type: 'global', kind: 'reference', name: '../hack', body: 'x' })).toThrow(/name/);
    expect(() => svc.save({ scope_type: 'global', kind: 'reference', name: 'with spaces', body: 'x' })).toThrow(/name/);
  });

  test('name muy largo → throw', () => {
    expect(() => svc.save({ scope_type: 'global', kind: 'reference', name: 'a'.repeat(200), body: 'x' })).toThrow(/120/);
  });

  test('name vacío → throw', () => {
    expect(() => svc.save({ scope_type: 'global', kind: 'reference', name: '', body: 'x' })).toThrow(/name/);
  });
});

describe('TypedMemoryService — MEMORY.md auto-generado', () => {
  test('save regenera MEMORY.md del scope', () => {
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'role', description: 'dev', body: 'x' });
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'feedback', name: 'style', description: 'verbose', body: 'y' });
    const idx = svc.readIndex('user', 'u1');
    expect(idx).toMatch(/# MEMORY \(user:u1\)/);
    expect(idx).toMatch(/## user/);
    expect(idx).toMatch(/## feedback/);
    expect(idx).toMatch(/role.*dev/);
    expect(idx).toMatch(/style.*verbose/);
  });

  test('forget regenera MEMORY.md sin el entry', () => {
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'a', body: 'x' });
    svc.save({ scope_type: 'user', scope_id: 'u1', kind: 'user', name: 'b', body: 'y' });
    svc.forget({ scope_type: 'user', scope_id: 'u1', name: 'a' });
    const idx = svc.readIndex('user', 'u1');
    expect(idx).not.toMatch(/\[a\]/);
    expect(idx).toMatch(/\[b\]/);
  });

  test('scope vacío genera MEMORY.md con "_vacío_"', () => {
    svc.save({ scope_type: 'agent', scope_id: 'a1', kind: 'project', name: 'foo', body: 'x' });
    svc.forget({ scope_type: 'agent', scope_id: 'a1', name: 'foo' });
    const idx = svc.readIndex('agent', 'a1');
    expect(idx).toMatch(/vacío/);
  });

  test('cap de tokens si excede MEMORY_MD_MAX_CHARS', () => {
    const smallSvc = new TypedMemoryService({
      repo, memoryRoot: path.join(tmpDir, 'small'),
      maxIndexChars: 200, // muy pequeño
      logger: { info: () => {}, warn: () => {} },
    });
    for (let i = 0; i < 20; i++) {
      smallSvc.save({ scope_type: 'global', kind: 'reference', name: `ref_${i}`, description: 'x'.repeat(40), body: 'x' });
    }
    const idx = smallSvc.readIndex('global', null);
    expect(idx.length).toBeLessThanOrEqual(200);
    expect(idx).toMatch(/TRUNCADO/);
  });
});
