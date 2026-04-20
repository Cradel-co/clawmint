'use strict';

const { SUBAGENT_TYPES, getType, listTypes } = require('../core/SubagentRegistry');

describe('SubagentRegistry', () => {
  test('5 tipos declarados', () => {
    const names = Object.keys(SUBAGENT_TYPES);
    expect(names.sort()).toEqual(['code', 'explore', 'general', 'plan', 'researcher']);
  });

  test('explore es read-only (no incluye write_file ni bash)', () => {
    const t = getType('explore');
    expect(t.allowedToolPatterns).toBeDefined();
    expect(t.allowedToolPatterns).not.toContain('write_file');
    expect(t.allowedToolPatterns).not.toContain('bash');
  });

  test('code tiene toolset completo (wildcard)', () => {
    const t = getType('code');
    expect(t.allowedToolPatterns).toContain('*');
    expect(t.maxDelegationDepth).toBe(1);
  });

  test('plan no puede ejecutar tools de escritura/side-effect', () => {
    const t = getType('plan');
    expect(t.allowedToolPatterns).toContain('read_file');
    expect(t.allowedToolPatterns).not.toContain('write_file');
    expect(t.allowedToolPatterns).not.toContain('bash');
  });

  test('researcher tiene web + memory patterns', () => {
    const t = getType('researcher');
    expect(t.allowedToolPatterns).toContain('webfetch');
    expect(t.allowedToolPatterns).toContain('websearch');
    expect(t.allowedToolPatterns).toContain('memory_*');
  });

  test('general hereda del coordinador (allowedToolPatterns=null, model=null)', () => {
    const t = getType('general');
    expect(t.allowedToolPatterns).toBeNull();
    expect(t.model).toBeNull();
  });

  test('maxDelegationDepth = 0 para todos salvo code (que es 1)', () => {
    expect(getType('explore').maxDelegationDepth).toBe(0);
    expect(getType('plan').maxDelegationDepth).toBe(0);
    expect(getType('researcher').maxDelegationDepth).toBe(0);
    expect(getType('general').maxDelegationDepth).toBe(0);
    expect(getType('code').maxDelegationDepth).toBe(1);
  });

  test('getType case-insensitive', () => {
    expect(getType('EXPLORE')).toBe(getType('explore'));
    expect(getType('Code')).toBe(getType('code'));
  });

  test('getType undefined para tipo inexistente', () => {
    expect(getType('nonexistent')).toBeUndefined();
    expect(getType('')).toBeUndefined();
    expect(getType(null)).toBeUndefined();
  });

  test('SUBAGENT_TYPES está frozen (inmutable)', () => {
    expect(Object.isFrozen(SUBAGENT_TYPES)).toBe(true);
    expect(() => { SUBAGENT_TYPES.hacker = { model: 'evil' }; }).toThrow();
    expect(Object.isFrozen(SUBAGENT_TYPES.explore)).toBe(true);
    expect(() => { SUBAGENT_TYPES.explore.model = 'hacked'; }).toThrow();
  });

  test('allowedToolPatterns arrays también frozen', () => {
    expect(Object.isFrozen(SUBAGENT_TYPES.explore.allowedToolPatterns)).toBe(true);
    expect(() => { SUBAGENT_TYPES.explore.allowedToolPatterns.push('bash'); }).toThrow();
  });

  test('listTypes retorna 5 objects con shape esperado', () => {
    const list = listTypes();
    expect(list).toHaveLength(5);
    for (const t of list) {
      expect(t).toEqual(expect.objectContaining({
        type: expect.any(String),
        description: expect.any(String),
        maxDelegationDepth: expect.any(Number),
      }));
    }
  });
});
