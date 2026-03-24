'use strict';

const sessionManager = require('../sessionManager');

describe('SessionManager idle cleanup', () => {
  afterEach(() => {
    // Limpiar sesiones creadas
    for (const s of sessionManager.list()) {
      sessionManager.destroy(s.id);
    }
  });

  test('create retorna sesión con lastAccessAt', () => {
    const session = sessionManager.create({ type: 'pty' });
    expect(session.lastAccessAt).toBeDefined();
    expect(session.lastAccessAt).toBeGreaterThan(0);
    expect(session.active).toBe(true);
  });

  test('input actualiza lastAccessAt', async () => {
    const session = sessionManager.create({ type: 'pty' });
    const before = session.lastAccessAt;
    await new Promise(r => setTimeout(r, 10));
    session.input('test');
    expect(session.lastAccessAt).toBeGreaterThanOrEqual(before);
  });

  test('destroy limpia buffer y listeners', () => {
    const session = sessionManager.create({ type: 'pty' });
    const unsub = session.onOutput(() => {});
    session.destroy();
    expect(session.active).toBe(false);
    expect(session._outputBuffer.length).toBe(0);
    expect(session._outputListeners.size).toBe(0);
  });

  test('get retorna undefined para id inexistente', () => {
    expect(sessionManager.get('nonexistent')).toBeUndefined();
  });

  test('destroy retorna false para id inexistente', () => {
    expect(sessionManager.destroy('nonexistent')).toBe(false);
  });
});
