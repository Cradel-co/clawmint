'use strict';

const memory = require('../memory');
const cronParser = require('../utils/cron-parser');
const { parseDuration, formatRemaining } = require('../utils/duration');

let db;

beforeAll(async () => {
  await memory.initDBAsync();
  db = memory.getDB();
});

// ── Cron Parser ──────────────────────────────────────────────────────────────

describe('cron-parser', () => {
  test('isValid acepta expresiones válidas', () => {
    expect(cronParser.isValid('0 8 * * *')).toBe(true);
    expect(cronParser.isValid('*/15 * * * *')).toBe(true);
    expect(cronParser.isValid('30 9 * * 1-5')).toBe(true);
  });

  test('isValid rechaza expresiones inválidas', () => {
    expect(cronParser.isValid('invalid')).toBe(false);
    expect(cronParser.isValid('')).toBe(false);
    expect(cronParser.isValid('* *')).toBe(false);
  });

  test('getNextRun retorna fecha futura', () => {
    const next = cronParser.getNextRun('0 8 * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  test('getNextRun retorna null para expresión inválida', () => {
    expect(cronParser.getNextRun('bad')).toBeNull();
  });

  test('describe genera texto legible', () => {
    expect(cronParser.describe('0 8 * * *')).toContain('08:00');
    expect(cronParser.describe('30 9 * * 1-5')).toContain('lunes a viernes');
  });
});

// ── Duration Parser ──────────────────────────────────────────────────────────

describe('duration', () => {
  test('parseDuration parsea correctamente', () => {
    expect(parseDuration('10m')).toBe(600000);
    expect(parseDuration('2h')).toBe(7200000);
    expect(parseDuration('1d')).toBe(86400000);
    expect(parseDuration('1h30m')).toBe(5400000);
  });

  test('parseDuration retorna null para input inválido', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
  });

  test('formatRemaining formatea correctamente', () => {
    expect(formatRemaining(30000)).toBe('30s');
    expect(formatRemaining(300000)).toBe('5m');
    expect(formatRemaining(7200000)).toBe('2h');
    expect(formatRemaining(90000000)).toBe('1d 1h');
  });
});

// ── UsersRepository ──────────────────────────────────────────────────────────

describe('UsersRepository', () => {
  const UsersRepository = require('../storage/UsersRepository');
  let users;

  beforeEach(() => {
    users = new UsersRepository(db);
    users.init();
  });

  test('create y getById', () => {
    const u = users.create('TestUser');
    expect(u.name).toBe('TestUser');
    const found = users.getById(u.id);
    expect(found.name).toBe('TestUser');
    users.remove(u.id);
  });

  test('getOrCreate es idempotente', () => {
    const u1 = users.getOrCreate('telegram', '99999', 'Test', 'bot');
    const u2 = users.getOrCreate('telegram', '99999', 'Test2', 'bot');
    expect(u1.id).toBe(u2.id);
    users.remove(u1.id);
  });

  test('linkIdentity y findByIdentity', () => {
    const u = users.create('Multi');
    users.linkIdentity(u.id, 'web', 'web-123', 'web');
    const found = users.findByIdentity('web', 'web-123');
    expect(found.id).toBe(u.id);
    expect(found.identities.length).toBeGreaterThanOrEqual(1);
    users.remove(u.id);
  });

  test('searchByName busca parcial', () => {
    const u = users.create('BuscarEste');
    const results = users.searchByName('Buscar');
    expect(results.some(r => r.id === u.id)).toBe(true);
    users.remove(u.id);
  });

  // Contacts
  test('createContact y listContacts', () => {
    const owner = users.create('Owner');
    const c1 = users.createContact(owner.id, { name: 'ContactA', phone: '123' });
    const c2 = users.createContact(owner.id, { name: 'ContactB', isFavorite: true });
    expect(c1.name).toBe('ContactA');

    const all = users.listContacts(owner.id);
    expect(all.length).toBe(2);

    const favs = users.listContacts(owner.id, { favoritesOnly: true });
    expect(favs.length).toBe(1);
    expect(favs[0].name).toBe('ContactB');

    users.removeContact(c1.id);
    users.removeContact(c2.id);
    users.remove(owner.id);
  });

  test('updateContact modifica campos', () => {
    const owner = users.create('Owner2');
    const c = users.createContact(owner.id, { name: 'Original' });
    users.updateContact(c.id, { name: 'Modificado', is_favorite: true });
    const updated = users.getContact(c.id);
    expect(updated.name).toBe('Modificado');
    expect(updated.is_favorite).toBe(1);
    users.removeContact(c.id);
    users.remove(owner.id);
  });

  test('remove usuario elimina contactos en cascade', () => {
    const owner = users.create('CascadeTest');
    users.createContact(owner.id, { name: 'WillBeDeleted' });
    users.remove(owner.id);
    // Los contactos deben haber sido eliminados
    const contacts = users.listContacts(owner.id);
    expect(contacts.length).toBe(0);
  });
});

// ── ScheduledActionsRepository ───────────────────────────────────────────────

describe('ScheduledActionsRepository', () => {
  const SARepo = require('../storage/ScheduledActionsRepository');
  let repo;

  beforeEach(() => {
    repo = new SARepo(db);
    repo.init();
  });

  test('create y getById', () => {
    const a = repo.create({ creator_id: 'u1', label: 'Test', trigger_type: 'once', trigger_at: Date.now() + 60000, next_run_at: Date.now() + 60000 });
    expect(a.label).toBe('Test');
    const found = repo.getById(a.id);
    expect(found.label).toBe('Test');
    repo.remove(a.id);
  });

  test('getTriggered retorna acciones vencidas', () => {
    const a = repo.create({ creator_id: 'u1', label: 'Vencida', trigger_at: Date.now() - 1000, next_run_at: Date.now() - 1000 });
    const triggered = repo.getTriggered(Date.now());
    expect(triggered.some(t => t.id === a.id)).toBe(true);
    repo.remove(a.id);
  });

  test('listActive con limit', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const a = repo.create({ creator_id: 'u1', label: `A${i}`, next_run_at: Date.now() + i * 1000 });
      ids.push(a.id);
    }
    const limited = repo.listActive(3);
    expect(limited.length).toBe(3);
    for (const id of ids) repo.remove(id);
  });

  test('incrementRun actualiza run_count', () => {
    const a = repo.create({ creator_id: 'u1', label: 'Runs', next_run_at: Date.now() + 60000 });
    repo.incrementRun(a.id);
    repo.incrementRun(a.id);
    const updated = repo.getById(a.id);
    expect(updated.run_count).toBe(2);
    repo.remove(a.id);
  });
});

// ── PendingDeliveriesRepository ──────────────────────────────────────────────

describe('PendingDeliveriesRepository', () => {
  const PDRepo = require('../storage/PendingDeliveriesRepository');
  let repo;

  beforeEach(() => {
    repo = new PDRepo(db);
    repo.init();
  });

  test('enqueue y getPending', () => {
    const p = repo.enqueue({ user_id: 'u1', channel: 'web', identifier: 'sess1', content: { text: 'hello' } });
    expect(p.status).toBe('pending');
    const pending = repo.getPending('web', 'sess1');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].content.text).toBe('hello');
    repo.markDelivered(p.id);
  });

  test('markAllDelivered limpia pendientes', () => {
    repo.enqueue({ user_id: 'u1', channel: 'web', identifier: 'sess2', content: { text: 'a' } });
    repo.enqueue({ user_id: 'u1', channel: 'web', identifier: 'sess2', content: { text: 'b' } });
    repo.markAllDelivered('web', 'sess2');
    const pending = repo.getPending('web', 'sess2');
    expect(pending.length).toBe(0);
  });
});

// ── ChatSettingsRepository global_settings ───────────────────────────────────

describe('ChatSettingsRepository global_settings', () => {
  const CSR = require('../storage/ChatSettingsRepository');
  let repo;

  beforeEach(() => {
    repo = new CSR(db);
    repo.init();
  });

  test('setGlobal y getGlobal', () => {
    repo.setGlobal('test_key', 'test_value');
    expect(repo.getGlobal('test_key')).toBe('test_value');
  });

  test('setGlobal sobreescribe valor existente', () => {
    repo.setGlobal('overwrite_key', 'v1');
    repo.setGlobal('overwrite_key', 'v2');
    expect(repo.getGlobal('overwrite_key')).toBe('v2');
  });

  test('getGlobal retorna null para clave inexistente', () => {
    expect(repo.getGlobal('nonexistent_key')).toBeNull();
  });
});

// ── MCP Tools: orchestration filtering ───────────────────────────────────────

describe('tools/index orchestration filtering', () => {
  const toolsIndex = require('../mcp/tools');

  test('agentes normales no ven tools de orquestación', () => {
    const names = toolsIndex.all({ agentRole: undefined }).map(t => t.name);
    expect(names).not.toContain('delegate_task');
    expect(names).not.toContain('ask_agent');
    expect(names).not.toContain('list_agents');
  });

  test('coordinador sí ve tools de orquestación', () => {
    const names = toolsIndex.all({ agentRole: 'coordinator' }).map(t => t.name);
    expect(names).toContain('delegate_task');
    expect(names).toContain('ask_agent');
    expect(names).toContain('list_agents');
  });

  test('tools normales siguen disponibles para todos', () => {
    const normal = toolsIndex.all({}).map(t => t.name);
    const coord = toolsIndex.all({ agentRole: 'coordinator' }).map(t => t.name);
    expect(normal).toContain('bash');
    expect(coord).toContain('bash');
    expect(coord.length).toBeGreaterThan(normal.length);
  });
});
