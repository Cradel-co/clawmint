'use strict';

// Nota: agents.js exporta un singleton con un AGENTS_FILE hardcodeado (server/agents.json).
// Los tests usan una clave única con prefijo __test__ y limpian después.

const agents = require('../agents');

const TEST_KEY = `__test_${Date.now()}__`;
const TEST_KEY2 = `__test2_${Date.now()}__`;

afterAll(() => {
  // Limpieza: eliminar agentes de test si quedaron
  agents.remove(TEST_KEY);
  agents.remove(TEST_KEY2);
});

describe('AgentManager', () => {
  describe('list()', () => {
    test('retorna un array', () => {
      expect(Array.isArray(agents.list())).toBe(true);
    });
  });

  describe('add()', () => {
    afterEach(() => {
      agents.remove(TEST_KEY);
    });

    test('agrega un agente y lo devuelve', () => {
      const agent = agents.add(TEST_KEY, 'bash', 'Test agent', 'test prompt');
      expect(agent.key).toBe(TEST_KEY);
      expect(agent.command).toBe('bash');
      expect(agent.description).toBe('Test agent');
      expect(agent.prompt).toBe('test prompt');
    });

    test('el agente añadido aparece en list()', () => {
      agents.add(TEST_KEY, 'echo', 'Listed');
      const list = agents.list();
      expect(list.some(a => a.key === TEST_KEY)).toBe(true);
    });

    test('agrega agente con provider', () => {
      const agent = agents.add(TEST_KEY, null, 'Con provider', '', 'gemini');
      expect(agent.provider).toBe('gemini');
    });

    test('lanza error si la key tiene caracteres inválidos', () => {
      expect(() => agents.add('key con espacios', 'cmd')).toThrow(/key inválida/);
      expect(() => agents.add('key@especial', 'cmd')).toThrow(/key inválida/);
    });

    test('command null es permitido', () => {
      const agent = agents.add(TEST_KEY, null, 'Sin comando');
      expect(agent.command).toBeNull();
    });
  });

  describe('get()', () => {
    beforeEach(() => agents.add(TEST_KEY, 'bash', 'Para get'));
    afterEach(() => agents.remove(TEST_KEY));

    test('retorna el agente por key', () => {
      const a = agents.get(TEST_KEY);
      expect(a).toBeTruthy();
      expect(a.key).toBe(TEST_KEY);
    });

    test('retorna undefined para key inexistente', () => {
      expect(agents.get('__no_existe_nunca__')).toBeUndefined();
    });
  });

  describe('update()', () => {
    beforeEach(() => agents.add(TEST_KEY, 'bash', 'Original'));
    afterEach(() => agents.remove(TEST_KEY));

    test('actualiza description y command', () => {
      const updated = agents.update(TEST_KEY, { command: 'sh', description: 'Actualizado' });
      expect(updated.command).toBe('sh');
      expect(updated.description).toBe('Actualizado');
    });

    test('actualiza provider', () => {
      const updated = agents.update(TEST_KEY, { provider: 'anthropic' });
      expect(updated.provider).toBe('anthropic');
    });

    test('elimina provider si se pasa string vacío', () => {
      agents.update(TEST_KEY, { provider: 'gemini' });
      const updated = agents.update(TEST_KEY, { provider: '' });
      expect(updated.provider).toBeUndefined();
    });

    test('lanza error si la key no existe', () => {
      expect(() => agents.update('__no_existe__', { description: 'x' }))
        .toThrow(/no encontrado/);
    });
  });

  describe('remove()', () => {
    test('elimina el agente y retorna true', () => {
      agents.add(TEST_KEY2, 'bash', 'Para eliminar');
      const ok = agents.remove(TEST_KEY2);
      expect(ok).toBe(true);
      expect(agents.get(TEST_KEY2)).toBeUndefined();
    });

    test('retorna false si el agente no existe', () => {
      expect(agents.remove('__no_existe_jamás__')).toBe(false);
    });
  });
});
