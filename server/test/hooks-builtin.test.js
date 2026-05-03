'use strict';

const { auditLogHandler } = require('../hooks/builtin/auditLog');
const { blockDangerousBashHandler, DANGEROUS_PATTERNS } = require('../hooks/builtin/blockDangerousBash');

describe('auditLog built-in', () => {
  test('loguea una línea por tool_use y retorna null', async () => {
    const logs = [];
    const logger = { info: (m) => logs.push(m) };
    const handler = auditLogHandler({ logger });
    const r = await handler({ name: 'grep', args: { pattern: 'x' }, result: 'hit', agentKey: 'claude', userId: 'u1' }, { ctx: { chatId: 'c1', channel: 'telegram' } });
    expect(r).toBeNull();
    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0].replace('[audit] ', ''));
    expect(payload.tool).toBe('grep');
    expect(payload.agent).toBe('claude');
    expect(payload.args_keys).toEqual(['pattern']);
  });

  test('maneja args=null sin romper', async () => {
    const logger = { info: () => {} };
    const handler = auditLogHandler({ logger });
    expect(await handler({ name: 'x' }, {})).toBeNull();
  });
});

describe('blockDangerousBash built-in', () => {
  const handler = blockDangerousBashHandler();

  test('no bloquea tools que no son shell', async () => {
    expect(await handler({ name: 'grep', args: { pattern: 'rm -rf /' } })).toBeNull();
    expect(await handler({ name: 'read_file', args: { path: '/etc/passwd' } })).toBeNull();
  });

  test('bloquea rm -rf /', async () => {
    const r = await handler({ name: 'bash', args: { command: 'rm -rf /' } });
    expect(r).toBeTruthy();
    expect(r.block).toMatch(/peligroso bloqueado/);
  });

  test('bloquea rm -rf / --no-preserve-root', async () => {
    const r = await handler({ name: 'bash', args: { command: 'rm -rf --no-preserve-root' } });
    expect(r).toBeTruthy();
  });

  test('NO bloquea rm -rf /tmp/foo (path específico seguro)', async () => {
    const r = await handler({ name: 'bash', args: { command: 'rm -rf /tmp/foo' } });
    expect(r).toBeNull();
  });

  test('bloquea fork bomb :(){ :|:& };:', async () => {
    const r = await handler({ name: 'bash', args: { command: ':(){ :|:& };:' } });
    expect(r).toBeTruthy();
  });

  test('bloquea dd con device', async () => {
    const r = await handler({ name: 'bash', args: { command: 'dd if=/dev/zero of=/dev/sda bs=1M' } });
    expect(r).toBeTruthy();
  });

  test('bloquea mkfs', async () => {
    const r = await handler({ name: 'bash', args: { command: 'mkfs.ext4 /dev/sda1' } });
    expect(r).toBeTruthy();
  });

  test('bloquea redirección a /dev/sd', async () => {
    const r = await handler({ name: 'bash', args: { command: 'cat file > /dev/sda' } });
    expect(r).toBeTruthy();
  });

  test('aplica a pty_exec también', async () => {
    const r = await handler({ name: 'pty_exec', args: { command: 'rm -rf /' } });
    expect(r).toBeTruthy();
  });

  test('args sin command → no bloquea (nada que evaluar)', async () => {
    expect(await handler({ name: 'bash', args: {} })).toBeNull();
  });

  test('DANGEROUS_PATTERNS exportado para inspección/test', () => {
    expect(DANGEROUS_PATTERNS.length).toBeGreaterThan(3);
  });
});
