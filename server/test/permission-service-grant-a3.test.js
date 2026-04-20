'use strict';

const PermissionService = require('../core/PermissionService');

function mkRepo(matchResult = null) {
  return {
    resolve: () => matchResult,
    list: () => [],
    create: () => ({}),
    remove: () => true,
    getById: () => null,
    count: () => 0,
  };
}

describe('PermissionService.grantTemporary (A3)', () => {
  test('flag off → resolve retorna auto; grant no tiene efecto', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: false });
    ps.grantTemporary('chat1', ['bash']);
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
  });

  test('sin grant y repo devuelve ask → resolve es ask', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('ask');
  });

  test('grant exact match baja ask → auto', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['bash'], 60_000);
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
  });

  test('grant no aplica a otro chatId', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['bash']);
    expect(ps.resolve('bash', { chatId: 'chat2' })).toBe('ask');
  });

  test('grant con wildcard prefix matchea', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['memory_*']);
    expect(ps.resolve('memory_read', { chatId: 'chat1' })).toBe('auto');
    expect(ps.resolve('memory_write', { chatId: 'chat1' })).toBe('auto');
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('ask');
  });

  test('grant "*" matchea cualquier tool', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['*']);
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
    expect(ps.resolve('telegram_send_message', { chatId: 'chat1' })).toBe('auto');
  });

  test('grant NO baja deny → auto (seguridad)', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'deny' }), enabled: true });
    ps.grantTemporary('chat1', ['bash']);
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('deny');
  });

  test('grant expira después de TTL', async () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['bash'], 1000); // mínimo respetado (1s)
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
    // Expirar manualmente vía mock de Date.now
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2000;
      expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('ask');
    } finally {
      Date.now = realNow;
    }
  });

  test('clearTemporaryGrants limpia grants del chat', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['bash']);
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
    ps.clearTemporaryGrants('chat1');
    expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('ask');
  });

  test('extender grant renueva expiresAt', () => {
    const ps = new PermissionService({ repo: mkRepo({ action: 'ask' }), enabled: true });
    ps.grantTemporary('chat1', ['bash'], 1000);
    ps.grantTemporary('chat1', ['bash'], 60_000); // extensión
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2000;
      expect(ps.resolve('bash', { chatId: 'chat1' })).toBe('auto');
    } finally {
      Date.now = realNow;
    }
  });
});
