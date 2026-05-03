'use strict';

const path = require('path');
const {
  buildSafeEnv, isCwdWithin,
  DEFAULT_ALLOWED_ENV_VARS,
} = require('../core/security/shellSandbox');

describe('buildSafeEnv — strict mode (default)', () => {
  const realEnv = process.env;
  beforeEach(() => {
    process.env = { ...realEnv };
    // Poblar env con secretos + vars safe para testear
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-123';
    process.env.BRAVE_SEARCH_API_KEY = 'BSA-secret';
    process.env.JWT_SECRET = 'supersecret';
    process.env.PATH = '/custom/path:/usr/bin';
    process.env.HOME = '/home/user';
    process.env.LANG = 'en_US.UTF-8';
    delete process.env.SHELL_SANDBOX_STRICT; // dejar default
  });
  afterEach(() => { process.env = realEnv; });

  test('no hereda ANTHROPIC_API_KEY ni otros secretos', () => {
    const env = buildSafeEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.BRAVE_SEARCH_API_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  test('hereda PATH, HOME, LANG', () => {
    const env = buildSafeEnv();
    expect(env.PATH).toBe('/custom/path:/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  test('extraEnv merge over allowlist', () => {
    const env = buildSafeEnv({ extraEnv: { MY_VAR: 'value', PATH: '/override' } });
    expect(env.MY_VAR).toBe('value');
    expect(env.PATH).toBe('/override');
  });

  test('allowedVars override reduce lista', () => {
    const env = buildSafeEnv({ allowedVars: ['PATH'] });
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeUndefined();
    expect(env.LANG).toBeUndefined();
  });

  test('path option sobreescribe PATH heredado', () => {
    const env = buildSafeEnv({ path: '/safe/bin' });
    expect(env.PATH).toBe('/safe/bin');
  });

  test('PATH default fallback si no hay en env', () => {
    delete process.env.PATH;
    const env = buildSafeEnv();
    expect(env.PATH).toBeTruthy();
  });
});

describe('buildSafeEnv — legacy mode (strict=false)', () => {
  test('hereda toda la env cuando strict=false', () => {
    const env = buildSafeEnv({
      strict: false,
      extraEnv: { EXTRA: 'x' },
    });
    // Debe tener las vars del process.env actual (node, home, etc.)
    expect(env.EXTRA).toBe('x');
    expect(Object.keys(env).length).toBeGreaterThan(DEFAULT_ALLOWED_ENV_VARS.length);
  });

  test('SHELL_SANDBOX_STRICT=false activa legacy', () => {
    const orig = process.env.SHELL_SANDBOX_STRICT;
    process.env.SHELL_SANDBOX_STRICT = 'false';
    process.env.MY_CUSTOM_VAR = 'visible';
    const env = buildSafeEnv();
    expect(env.MY_CUSTOM_VAR).toBe('visible');
    if (orig === undefined) delete process.env.SHELL_SANDBOX_STRICT;
    else process.env.SHELL_SANDBOX_STRICT = orig;
    delete process.env.MY_CUSTOM_VAR;
  });
});

describe('isCwdWithin', () => {
  test('cwd dentro de root → true', () => {
    const root = path.resolve('/tmp/user-data');
    expect(isCwdWithin(path.join(root, 'foo', 'bar'), root)).toBe(true);
  });

  test('cwd igual al root → true', () => {
    const root = path.resolve('/tmp/user-data');
    expect(isCwdWithin(root, root)).toBe(true);
  });

  test('cwd fuera del root → false', () => {
    const root = path.resolve('/tmp/user-data');
    expect(isCwdWithin(path.resolve('/etc/passwd'), root)).toBe(false);
  });

  test('cwd que empieza con nombre similar pero no dentro → false', () => {
    const root = path.resolve('/tmp/user-data');
    const sibling = path.resolve('/tmp/user-data-other');
    expect(isCwdWithin(sibling, root)).toBe(false);
  });

  test('null/empty → false', () => {
    expect(isCwdWithin(null, '/tmp')).toBe(false);
    expect(isCwdWithin('/tmp', null)).toBe(false);
    expect(isCwdWithin('', '')).toBe(false);
  });
});

describe('DEFAULT_ALLOWED_ENV_VARS', () => {
  test('incluye PATH y HOME', () => {
    expect(DEFAULT_ALLOWED_ENV_VARS).toContain('PATH');
    expect(DEFAULT_ALLOWED_ENV_VARS).toContain('HOME');
  });

  test('NO incluye vars de API keys comunes', () => {
    expect(DEFAULT_ALLOWED_ENV_VARS).not.toContain('ANTHROPIC_API_KEY');
    expect(DEFAULT_ALLOWED_ENV_VARS).not.toContain('OPENAI_API_KEY');
    expect(DEFAULT_ALLOWED_ENV_VARS).not.toContain('JWT_SECRET');
    expect(DEFAULT_ALLOWED_ENV_VARS).not.toContain('BRAVE_SEARCH_API_KEY');
  });

  test('es inmutable (frozen)', () => {
    expect(Object.isFrozen(DEFAULT_ALLOWED_ENV_VARS)).toBe(true);
  });
});
