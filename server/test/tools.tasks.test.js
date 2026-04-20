'use strict';

/**
 * Tests de mcp/tools/tasks.js + storage/TaskRepository
 * Cubre: CRUD básico + cascade delete + aislamiento por chat_id + validación de status.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const TaskRepository = require('../storage/TaskRepository');
const tools          = require('../mcp/tools/tasks');

let db;
let repo;
let tmpDir;

async function makeDB() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

beforeAll(async () => {
  db = await makeDB();
  repo = new TaskRepository(db);
  repo.init();
});

afterAll(() => {
  try { db?.close?.(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function byName(n) { return tools.find(t => t.name === n); }

describe('TaskRepository — CRUD', () => {
  test('create + getById', () => {
    const row = repo.create({ chat_id: 'c1', title: 'revisar logs', description: 'del lunes' });
    expect(row.id).toBeTruthy();
    const got = repo.getById(row.id, 'c1');
    expect(got.title).toBe('revisar logs');
    expect(got.description).toBe('del lunes');
    expect(got.status).toBe('pending');
  });

  test('aislamiento por chat_id — scoped get no encuentra de otro chat', () => {
    const row = repo.create({ chat_id: 'cA', title: 'solo A' });
    expect(repo.getById(row.id, 'cB')).toBeNull();
    expect(repo.getById(row.id, 'cA').title).toBe('solo A');
    expect(repo.getById(row.id, '*').title).toBe('solo A'); // admin bypass
  });

  test('update status válido', () => {
    const row = repo.create({ chat_id: 'c2', title: 't' });
    const ok = repo.update(row.id, 'c2', { status: 'in_progress' });
    expect(ok).toBe(true);
    expect(repo.getById(row.id, 'c2').status).toBe('in_progress');
  });

  test('update status inválido throwea', () => {
    const row = repo.create({ chat_id: 'c3', title: 't' });
    expect(() => repo.update(row.id, 'c3', { status: 'mexican-standoff' })).toThrow(/inválido/);
  });

  test('metadata se serializa y deserializa', () => {
    const row = repo.create({ chat_id: 'c4', title: 't', metadata: { priority: 'high', tags: ['urgent'] } });
    const got = repo.getById(row.id, 'c4');
    expect(got.metadata).toEqual({ priority: 'high', tags: ['urgent'] });
  });

  test('cascade delete elimina subtareas', () => {
    const parent = repo.create({ chat_id: 'c5', title: 'padre' });
    const child1 = repo.create({ chat_id: 'c5', title: 'hijo 1', parent_id: parent.id });
    const child2 = repo.create({ chat_id: 'c5', title: 'hijo 2', parent_id: parent.id });
    const grand  = repo.create({ chat_id: 'c5', title: 'nieto',  parent_id: child1.id });

    const { removed, descendants } = repo.remove(parent.id, 'c5');
    expect(removed).toBe(1);
    expect(descendants).toBe(3);
    expect(repo.getById(child1.id, 'c5')).toBeNull();
    expect(repo.getById(child2.id, 'c5')).toBeNull();
    expect(repo.getById(grand.id, 'c5')).toBeNull();
  });

  test('list filtra por status y scope', () => {
    repo.create({ chat_id: 'c6', title: 'a' });
    repo.create({ chat_id: 'c6', title: 'b' });
    const t3 = repo.create({ chat_id: 'c6', title: 'c' });
    repo.update(t3.id, 'c6', { status: 'completed' });

    const pending = repo.list({ chat_id: 'c6', status: 'pending' });
    const completed = repo.list({ chat_id: 'c6', status: 'completed' });
    expect(pending).toHaveLength(2);
    expect(completed).toHaveLength(1);
  });
});

describe('mcp/tools/tasks — interfaz MCP', () => {
  const ctx = { tasksRepo: null, chatId: 't1' };

  beforeAll(() => { ctx.tasksRepo = repo; });

  test('task_create crea con formato "Creada #N: title"', () => {
    const out = byName('task_create').execute({ title: 'probar tool' }, ctx);
    expect(out).toMatch(/^Creada #\d+: probar tool$/);
  });

  test('task_create sin title retorna error', () => {
    expect(byName('task_create').execute({}, ctx)).toMatch(/Error: title/);
  });

  test('task_list muestra lista formateada', () => {
    byName('task_create').execute({ title: 'foo' }, ctx);
    byName('task_create').execute({ title: 'bar' }, ctx);
    const out = byName('task_list').execute({}, ctx);
    expect(out).toMatch(/#\d+ \[pending\]/);
    expect(out).toMatch(/foo/);
  });

  test('task_list con status inválido retorna error', () => {
    expect(byName('task_list').execute({ status: 'invalido' }, ctx)).toMatch(/status debe ser uno de/);
  });

  test('task_get devuelve JSON con children', () => {
    const created = byName('task_create').execute({ title: 'papá' }, ctx);
    const id = Number(created.match(/#(\d+)/)[1]);
    byName('task_create').execute({ title: 'hijito', parent_id: id }, ctx);
    const out = byName('task_get').execute({ id }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.title).toBe('papá');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0].title).toBe('hijito');
  });

  test('task_update cambia status', () => {
    const created = byName('task_create').execute({ title: 'mutable' }, ctx);
    const id = Number(created.match(/#(\d+)/)[1]);
    const out = byName('task_update').execute({ id, status: 'completed' }, ctx);
    expect(out).toMatch(/Actualizada/);
    const got = repo.getById(id, 't1');
    expect(got.status).toBe('completed');
  });

  test('task_update con status inválido retorna error canónico', () => {
    expect(byName('task_update').execute({ id: 1, status: 'bogus' }, ctx)).toMatch(/status debe ser uno de/);
  });

  test('task_delete de tarea ajena retorna error', () => {
    const row = repo.create({ chat_id: 'otro', title: 'ajena' });
    expect(byName('task_delete').execute({ id: row.id }, ctx)).toMatch(/no existe o no te pertenece/);
  });

  test('task_delete reporta cantidad de subtareas eliminadas', () => {
    const created = byName('task_create').execute({ title: 'con hijos' }, ctx);
    const id = Number(created.match(/#(\d+)/)[1]);
    byName('task_create').execute({ title: 'h1', parent_id: id }, ctx);
    byName('task_create').execute({ title: 'h2', parent_id: id }, ctx);
    const out = byName('task_delete').execute({ id }, ctx);
    expect(out).toMatch(/Eliminada #\d+ \(y 2 subtareas\)/);
  });
});
