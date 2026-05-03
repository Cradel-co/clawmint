'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TokenCrypto = require('../core/security/tokenCrypto');
const McpAuthRepository = require('../storage/McpAuthRepository');
const McpAuthService = require('../services/McpAuthService');
const tools = require('../mcp/tools/mcpAuth');
const EventBus = require('../core/EventBus');

function byName(n) { return tools.find(t => t.name === n); }

// ── TokenCrypto ─────────────────────────────────────────────────────────

describe('TokenCrypto', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-')); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  test('encrypt + decrypt round-trip', () => {
    const tc = new TokenCrypto({ masterKey: 'test-key-123456', logger: { info: () => {}, warn: () => {} } });
    const enc = tc.encrypt('sk-ant-secret-abc');
    expect(enc).not.toBe('sk-ant-secret-abc');
    expect(tc.decrypt(enc)).toBe('sk-ant-secret-abc');
  });

  test('ciphertexts distintos para mismo plaintext (IV random)', () => {
    const tc = new TokenCrypto({ masterKey: 'k', logger: { info: () => {}, warn: () => {} } });
    expect(tc.encrypt('hola')).not.toBe(tc.encrypt('hola'));
  });

  test('tampering detectado (GCM auth tag)', () => {
    const tc = new TokenCrypto({ masterKey: 'k', logger: { info: () => {}, warn: () => {} } });
    const enc = tc.encrypt('data');
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip último byte
    const tampered = buf.toString('base64');
    expect(() => tc.decrypt(tampered)).toThrow();
  });

  test('decrypt con key distinta falla', () => {
    const tc1 = new TokenCrypto({ masterKey: 'key-1', logger: { info: () => {}, warn: () => {} } });
    const tc2 = new TokenCrypto({ masterKey: 'key-2', logger: { info: () => {}, warn: () => {} } });
    const enc = tc1.encrypt('x');
    expect(() => tc2.decrypt(enc)).toThrow();
  });

  test('auto-genera key file si no existe', () => {
    const keyFile = path.join(tmpDir, 'k');
    const tc = new TokenCrypto({ keyFilePath: keyFile, logger: { info: () => {}, warn: () => {} } });
    const enc = tc.encrypt('x');
    expect(fs.existsSync(keyFile)).toBe(true);
    // Nuevo instance con mismo keyfile descifra correctamente
    const tc2 = new TokenCrypto({ keyFilePath: keyFile, logger: { info: () => {}, warn: () => {} } });
    expect(tc2.decrypt(enc)).toBe('x');
  });

  test('encrypt con input no-string → throw', () => {
    const tc = new TokenCrypto({ masterKey: 'k', logger: { info: () => {}, warn: () => {} } });
    expect(() => tc.encrypt(123)).toThrow(/string/);
  });
});

// ── McpAuthRepository ───────────────────────────────────────────────────

describe('McpAuthRepository', () => {
  let db, repo, tmpDir;

  beforeAll(async () => {
    const Database = require('../storage/sqlite-wrapper');
    if (!Database.isInitialized()) await Database.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    repo = new McpAuthRepository(db);
    repo.init();
  });

  afterAll(() => {
    try { db?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM mcp_auth').run(); });

  test('upsert crea nueva entrada', () => {
    const r = repo.upsert({ mcp_name: 'gmail', user_id: 'u1', encrypted_token: 'ABC' });
    expect(r.id).toBeTruthy();
    expect(r.mcp_name).toBe('gmail');
  });

  test('upsert sobrescribe si (mcp_name, user_id) ya existe', () => {
    repo.upsert({ mcp_name: 'gmail', user_id: 'u1', encrypted_token: 'v1' });
    repo.upsert({ mcp_name: 'gmail', user_id: 'u1', encrypted_token: 'v2' });
    expect(repo.listByUser('u1')).toHaveLength(1);
    expect(repo.findByMcpUser('gmail', 'u1').encrypted_token).toBe('v2');
  });

  test('findByMcpUser retorna null si no existe', () => {
    expect(repo.findByMcpUser('no-existe', 'u1')).toBeNull();
  });

  test('listByUser retorna todos los MCPs del user', () => {
    repo.upsert({ mcp_name: 'gmail',     user_id: 'u1', encrypted_token: 'a' });
    repo.upsert({ mcp_name: 'calendar',  user_id: 'u1', encrypted_token: 'b' });
    repo.upsert({ mcp_name: 'gmail',     user_id: 'u2', encrypted_token: 'c' });
    expect(repo.listByUser('u1')).toHaveLength(2);
    expect(repo.listByUser('u2')).toHaveLength(1);
  });

  test('removeByMcpUser elimina entrada específica', () => {
    repo.upsert({ mcp_name: 'gmail', user_id: 'u1', encrypted_token: 'x' });
    expect(repo.removeByMcpUser('gmail', 'u1')).toBe(true);
    expect(repo.findByMcpUser('gmail', 'u1')).toBeNull();
  });

  test('listExpiring filtra por expires_at', () => {
    const now = Date.now();
    repo.upsert({ mcp_name: 'a', user_id: 'u1', encrypted_token: 'x', expires_at: now - 1000 });
    repo.upsert({ mcp_name: 'b', user_id: 'u1', encrypted_token: 'y', expires_at: now + 100_000 });
    repo.upsert({ mcp_name: 'c', user_id: 'u1', encrypted_token: 'z' }); // sin expires_at
    const expiring = repo.listExpiring(now);
    expect(expiring).toHaveLength(1);
    expect(expiring[0].mcp_name).toBe('a');
  });

  test('validaciones — mcp_name, user_id, encrypted_token requeridos', () => {
    expect(() => repo.upsert({ user_id: 'u', encrypted_token: 'x' })).toThrow(/mcp_name/);
    expect(() => repo.upsert({ mcp_name: 'a', encrypted_token: 'x' })).toThrow(/user_id/);
    expect(() => repo.upsert({ mcp_name: 'a', user_id: 'u' })).toThrow(/encrypted_token/);
  });
});

// ── McpAuthService ──────────────────────────────────────────────────────

describe('McpAuthService', () => {
  let db, repo, svc, bus, tmpDir;
  const crypto = new TokenCrypto({ masterKey: 'testkey', logger: { info: () => {}, warn: () => {} } });

  beforeAll(async () => {
    const Database = require('../storage/sqlite-wrapper');
    if (!Database.isInitialized()) await Database.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    repo = new McpAuthRepository(db);
    repo.init();
    bus = new EventBus();
    svc = new McpAuthService({ repo, crypto, eventBus: bus, logger: { info: () => {}, warn: () => {} } });
  });

  afterAll(() => {
    try { db?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM mcp_auth').run(); });

  test('saveToken cifra + emite mcp:auth_completed', () => {
    const events = [];
    bus.once('mcp:auth_completed', (p) => events.push(p));
    const r = svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'secret-token' });
    expect(r.encrypted_token).not.toContain('secret-token');
    expect(events).toHaveLength(1);
    expect(events[0].mcp_name).toBe('gmail');
  });

  test('getToken descifra correctamente', () => {
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'plain-abc' });
    const got = svc.getToken('gmail', 'u1');
    expect(got.token).toBe('plain-abc');
  });

  test('getToken para no existente → null', () => {
    expect(svc.getToken('nope', 'u1')).toBeNull();
  });

  test('hasToken true/false', () => {
    expect(svc.hasToken('nope', 'u1')).toBe(false);
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'x' });
    expect(svc.hasToken('gmail', 'u1')).toBe(true);
  });

  test('removeToken elimina entrada', () => {
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'x' });
    expect(svc.removeToken('gmail', 'u1')).toBe(true);
    expect(svc.getToken('gmail', 'u1')).toBeNull();
  });

  test('requireAuth emite mcp:auth_required', () => {
    const events = [];
    bus.once('mcp:auth_required', (p) => events.push(p));
    svc.requireAuth({ mcp_name: 'gmail', user_id: 'u1', auth_url: 'https://...', chatId: 'c1' });
    expect(events).toHaveLength(1);
    expect(events[0].auth_url).toBe('https://...');
    expect(events[0].chatId).toBe('c1');
  });

  test('listByUser NO retorna encrypted_token', () => {
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'x' });
    const list = svc.listByUser('u1');
    expect(list[0].encrypted_token).toBeUndefined();
    expect(list[0].mcp_name).toBe('gmail');
  });
});

// ── mcp/tools/mcpAuth ───────────────────────────────────────────────────

describe('mcp_authenticate / mcp_complete_authentication / mcp_list_authenticated', () => {
  let db, svc, ctx, tmpDir;
  const crypto = new TokenCrypto({ masterKey: 'k', logger: { info: () => {}, warn: () => {} } });

  beforeAll(async () => {
    const Database = require('../storage/sqlite-wrapper');
    if (!Database.isInitialized()) await Database.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const repo = new McpAuthRepository(db);
    repo.init();
    svc = new McpAuthService({ repo, crypto, logger: { info: () => {}, warn: () => {} } });
  });

  beforeEach(() => {
    db.prepare('DELETE FROM mcp_auth').run();
    ctx = {
      mcpAuthService: svc,
      usersRepo: { findByIdentity: () => ({ id: 'u1' }), getById: () => ({ id: 'u1', role: 'user' }) },
      userId: 'u1',
      chatId: 'c1',
      channel: 'telegram',
    };
  });

  afterAll(() => {
    try { db?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('mcp_authenticate sin server → error', () => {
    expect(byName('mcp_authenticate').execute({}, ctx)).toMatch(/server requerido/);
  });

  test('mcp_authenticate inicia flow con URL', () => {
    const out = byName('mcp_authenticate').execute({ server: 'gmail', auth_url: 'https://auth.example/x' }, ctx);
    expect(out).toMatch(/gmail/);
    expect(out).toMatch(/https:\/\/auth\.example\/x/);
  });

  test('mcp_authenticate con token existente informa', () => {
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'existing' });
    expect(byName('mcp_authenticate').execute({ server: 'gmail' }, ctx)).toMatch(/Ya hay un token/);
  });

  test('mcp_complete_authentication persiste token', () => {
    const out = byName('mcp_complete_authentication').execute({ server: 'gmail', token: 'secret-123' }, ctx);
    expect(out).toMatch(/persistido/);
    expect(svc.getToken('gmail', 'u1').token).toBe('secret-123');
  });

  test('mcp_complete_authentication con expires_in', () => {
    const before = Date.now();
    byName('mcp_complete_authentication').execute({ server: 'gmail', token: 'x', expires_in: 3600 }, ctx);
    const row = svc.getToken('gmail', 'u1');
    expect(row.expires_at).toBeGreaterThan(before);
  });

  test('mcp_list_authenticated retorna lista sin tokens', () => {
    svc.saveToken({ mcp_name: 'gmail', user_id: 'u1', token: 'x' });
    svc.saveToken({ mcp_name: 'calendar', user_id: 'u1', token: 'y' });
    const out = byName('mcp_list_authenticated').execute({}, ctx);
    expect(out).toMatch(/gmail/);
    expect(out).toMatch(/calendar/);
    expect(out).not.toMatch(/x|y/);
  });

  test('mcp_list_authenticated sin entries → mensaje específico', () => {
    expect(byName('mcp_list_authenticated').execute({}, ctx)).toMatch(/\(sin MCPs autenticados\)/);
  });
});
