'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TypedMemoryRepository = require('../storage/TypedMemoryRepository');
const TypedMemoryService = require('../services/TypedMemoryService');
const tools = require('../mcp/tools/typedMemory');

function byName(n) { return tools.find(t => t.name === n); }

let db;
let tmpDir;
let svc;
let ctx;

async function setup() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tools-'));
  db = new Database(path.join(tmpDir, 'test.db'));
  const repo = new TypedMemoryRepository(db);
  repo.init();
  svc = new TypedMemoryService({
    repo,
    memoryRoot: path.join(tmpDir, 'mem'),
    logger: { info: () => {}, warn: () => {} },
  });
  ctx = {
    typedMemoryService: svc,
    chatId: 'chat-1',
    agentKey: 'claude',
    usersRepo: {
      getById: (id) => id === 'u1' ? { id: 'u1', role: 'user' } : null,
      findByIdentity: (ch, cid) => cid === 'chat-1' ? { id: 'u1' } : null,
    },
    channel: 'telegram',
  };
}

beforeAll(async () => setup());

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { db.prepare('DELETE FROM typed_memory').run(); });

describe('memory_save_typed', () => {
  test('sin typedMemoryService en ctx → error', () => {
    expect(byName('memory_save_typed').execute({ kind: 'user', name: 'n', body: 'x' }, {})).toMatch(/no disponible/);
  });

  test('kind inválido → error', () => {
    expect(byName('memory_save_typed').execute({ kind: 'bad', name: 'n', body: 'x' }, ctx)).toMatch(/kind inválido/);
  });

  test('guarda scope=chat con chatId auto-resuelto', () => {
    const out = byName('memory_save_typed').execute({ kind: 'project', name: 'scope', body: 'meta' }, ctx);
    expect(out).toMatch(/Guardada memoria "scope"/);
    expect(out).toMatch(/scope=chat:chat-1/);
  });

  test('scope=user auto-resuelve userId desde usersRepo', () => {
    const out = byName('memory_save_typed').execute({ kind: 'user', name: 'role', body: 'dev', scope_type: 'user' }, ctx);
    expect(out).toMatch(/scope=user:u1/);
  });

  test('scope=global sin scope_id', () => {
    const out = byName('memory_save_typed').execute({ kind: 'reference', name: 'url', body: 'https://ex.com', scope_type: 'global' }, ctx);
    expect(out).toMatch(/scope=global/);
    expect(out).not.toMatch(/scope=global:/);
  });

  test('scope_type inválido → error', () => {
    expect(byName('memory_save_typed').execute({ kind: 'user', name: 'n', body: 'x', scope_type: 'bogus' }, ctx))
      .toMatch(/scope_type inválido/);
  });

  test('sobrescribe memorias con mismo name en mismo scope', () => {
    byName('memory_save_typed').execute({ kind: 'user', name: 'role', body: 'v1', scope_type: 'global' }, ctx);
    byName('memory_save_typed').execute({ kind: 'user', name: 'role', body: 'v2', scope_type: 'global' }, ctx);
    const got = svc.get({ scope_type: 'global', scope_id: null, name: 'role' });
    expect(got.body).toBe('v2');
  });
});

describe('memory_list_typed', () => {
  test('sin memorias → "(sin memorias)"', () => {
    expect(byName('memory_list_typed').execute({}, ctx)).toBe('(sin memorias)');
  });

  test('lista con filtro por kind', () => {
    byName('memory_save_typed').execute({ kind: 'user', name: 'role', body: 'x', scope_type: 'global' }, ctx);
    byName('memory_save_typed').execute({ kind: 'feedback', name: 'style', body: 'y', scope_type: 'global' }, ctx);
    const out = byName('memory_list_typed').execute({ kind: 'user' }, ctx);
    expect(out).toMatch(/\[user\] role/);
    expect(out).not.toMatch(/style/);
  });

  test('lista con filtro por scope_type', () => {
    byName('memory_save_typed').execute({ kind: 'user', name: 'a', body: 'x', scope_type: 'global' }, ctx);
    byName('memory_save_typed').execute({ kind: 'user', name: 'b', body: 'y', scope_type: 'chat' }, ctx);
    const out = byName('memory_list_typed').execute({ scope_type: 'global' }, ctx);
    expect(out).toMatch(/\[user\] a/);
    expect(out).not.toMatch(/\[user\] b/);
  });
});

describe('memory_forget', () => {
  test('name requerido', () => {
    expect(byName('memory_forget').execute({}, ctx)).toMatch(/name requerido/);
  });

  test('forget inexistente', () => {
    expect(byName('memory_forget').execute({ name: 'nope', scope_type: 'global' }, ctx)).toMatch(/No se encontró/);
  });

  test('forget elimina memoria existente', () => {
    byName('memory_save_typed').execute({ kind: 'user', name: 'role', body: 'x', scope_type: 'global' }, ctx);
    const out = byName('memory_forget').execute({ name: 'role', scope_type: 'global' }, ctx);
    expect(out).toMatch(/Eliminada/);
    expect(svc.list({ scope_type: 'global' })).toHaveLength(0);
  });
});
