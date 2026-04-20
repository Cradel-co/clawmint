'use strict';

const { ShellSession, get, destroy, destroyAll } = require('../mcp/ShellSession');

afterAll(() => destroyAll());

const IS_WIN = process.platform === 'win32';

// ── ShellSession (instancias) ─────────────────────────────────────────────────

describe('ShellSession — instancia directa', () => {
  let shell;

  beforeEach(() => { shell = new ShellSession(); });
  afterEach(() => { shell.destroy(); });

  test('run() retorna el output del comando', async () => {
    const out = await shell.run('echo hello shell');
    expect(out).toContain('hello shell');
  });

  test('cd persiste entre llamadas sucesivas', async () => {
    const tmpDir = IS_WIN ? process.env.TEMP : '/tmp';
    await shell.run(`cd ${tmpDir}`);
    const cwd = await shell.run(IS_WIN ? 'cd' : 'pwd');
    expect(cwd.trim()).toContain(IS_WIN ? tmpDir.replace(/\//g, '\\') : '/tmp');
  });

  test('variables de entorno persisten entre llamadas', async () => {
    if (IS_WIN) {
      await shell.run('set TESTVAR_CLAW=persistido');
      const val = await shell.run('echo %TESTVAR_CLAW%');
      expect(val).toContain('persistido');
    } else {
      await shell.run('TESTVAR_CLAW=persistido');
      const val = await shell.run('echo $TESTVAR_CLAW');
      expect(val).toContain('persistido');
    }
  });

  (IS_WIN ? test.skip : test)('exit code != 0 agrega prefijo [exit N]', async () => {
    const out = await shell.run('false');
    expect(out).toMatch(/^\[exit 1\]/);
  });

  test('stderr se incluye en el resultado', async () => {
    const cmd = IS_WIN ? 'echo error msg >&2' : 'echo "error msg" >&2';
    const out = await shell.run(cmd);
    expect(out).toContain('error msg');
  });

  (IS_WIN ? test.skip : test)('comando sin output retorna "(sin output)"', async () => {
    const out = await shell.run('true');
    expect(out).toBe('(sin output)');
  });

  test('run() en sesión destruida rechaza la promesa', async () => {
    shell.destroy();
    await expect(shell.run('echo test')).rejects.toThrow(/destruida/);
  });

  test('comandos en paralelo se serializan — todos retornan el output correcto', async () => {
    const results = await Promise.all([
      shell.run('echo A'),
      shell.run('echo B'),
      shell.run('echo C'),
    ]);
    expect(results[0]).toContain('A');
    expect(results[1]).toContain('B');
    expect(results[2]).toContain('C');
  });

  (IS_WIN ? test.skip : test)('output > 2MB se trunca al inicio (FIFO) con prefix', async () => {
    // Generar ~3MB de output; el sentinel al final sigue siendo detectable.
    const out = await shell.run('yes abcdefghij | head -c 3000000', 15000);
    expect(out).toMatch(/\[truncado \d+ bytes/);
    // El resultado no debe pasar demasiado de 2MB + prefix + stderr
    expect(out.length).toBeLessThan(2.5 * 1024 * 1024);
  }, 20000);

  (IS_WIN ? test.skip : test)('runaway >50MB/s dispara SIGKILL', async () => {
    // `yes` sin head produce ~GB/s; debe killearse antes de los 3s.
    await expect(shell.run('yes', 5000)).rejects.toThrow(/killed/);
  }, 10000);
});

// ── Pool de sesiones ──────────────────────────────────────────────────────────

describe('ShellSession — pool (get/destroy)', () => {
  test('get() crea una nueva sesión para un ID nuevo', () => {
    const id = 'pool-new-' + Date.now();
    const s = get(id);
    expect(s).toBeInstanceOf(ShellSession);
    destroy(id);
  });

  test('get() retorna la misma instancia para el mismo ID', () => {
    const id = 'pool-same-' + Date.now();
    const s1 = get(id);
    const s2 = get(id);
    expect(s1).toBe(s2);
    destroy(id);
  });

  test('get() crea una nueva instancia si la anterior fue destruida', () => {
    const id = 'pool-recreate-' + Date.now();
    const s1 = get(id);
    destroy(id);
    const s2 = get(id);
    expect(s2).not.toBe(s1);
    destroy(id);
  });

  test('destroy() mata el proceso de la sesión', () => {
    const id = 'pool-kill-' + Date.now();
    const s = get(id);
    expect(s._destroyed).toBe(false);
    destroy(id);
    expect(s._destroyed).toBe(true);
  });

  test('sesiones son independientes: cd en una no afecta a otra', async () => {
    const id1 = 'iso-1-' + Date.now();
    const id2 = 'iso-2-' + Date.now();
    const s1 = get(id1);
    const s2 = get(id2);
    await s1.run('cd /tmp');
    const cwd1 = await s1.run('pwd');
    const cwd2 = await s2.run('pwd');
    expect(cwd1.trim()).not.toBe(cwd2.trim());
    destroy(id1);
    destroy(id2);
  });
});
