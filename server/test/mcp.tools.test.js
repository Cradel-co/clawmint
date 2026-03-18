'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const bash       = require('../mcp/tools/bash');
const filesTools = require('../mcp/tools/files');   // array
const ptyTools   = require('../mcp/tools/pty');     // array
const toolsIndex = require('../mcp/tools');
const { destroy: destroyShell, destroyAll } = require('../mcp/ShellSession');

const [READ_FILE, WRITE_FILE, LIST_DIR, SEARCH_FILES] = filesTools;
const [PTY_WRITE, PTY_READ]                            = ptyTools;

afterAll(() => destroyAll());

// ── bash tool ─────────────────────────────────────────────────────────────────

describe('bash tool', () => {
  test('sin command retorna error', async () => {
    const r = await bash.execute({});
    expect(r).toContain('Error');
  });

  test('ejecuta comando y retorna output', async () => {
    const id = 'bash-test-' + Date.now();
    const r  = await bash.execute({ command: 'echo bash_test_ok', session_id: id });
    expect(r).toContain('bash_test_ok');
    destroyShell(id);
  });

  test('usa ctx.shellId si no se provee session_id', async () => {
    const id = 'bash-ctx-' + Date.now();
    const r  = await bash.execute({ command: 'echo ctx_ok' }, { shellId: id });
    expect(r).toContain('ctx_ok');
    destroyShell(id);
  });

  test('usa "global" como shellId por defecto', async () => {
    const r = await bash.execute({ command: 'echo global_ok' }, {});
    expect(r).toContain('global_ok');
    destroyShell('global');
  });

  test('estado de shell persiste entre llamadas con el mismo id', async () => {
    const id = 'bash-persist-' + Date.now();
    const isWin = process.platform === 'win32';
    const tmpDir = isWin ? process.env.TEMP : '/tmp';
    const cwdCmd = isWin ? 'cd' : 'pwd';
    await bash.execute({ command: `cd ${tmpDir}`, session_id: id });
    const r = await bash.execute({ command: cwdCmd, session_id: id });
    expect(r.trim().toLowerCase()).toContain(tmpDir.toLowerCase().replace(/\//g, '\\'));
    destroyShell(id);
  });
});

// ── read_file tool ────────────────────────────────────────────────────────────

describe('read_file tool', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-read-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('sin path retorna error', () => {
    expect(READ_FILE.execute({})).toContain('Error');
  });

  test('archivo inexistente retorna error', () => {
    expect(READ_FILE.execute({ path: '/ruta-fantasma-99999/x.txt' })).toContain('Error');
  });

  test('lee contenido de un archivo existente', () => {
    const f = path.join(dir, 'test.txt');
    fs.writeFileSync(f, 'contenido de prueba', 'utf8');
    expect(READ_FILE.execute({ path: f })).toBe('contenido de prueba');
  });
});

// ── write_file tool ───────────────────────────────────────────────────────────

describe('write_file tool', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-write-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('sin path retorna error', () => {
    expect(WRITE_FILE.execute({ content: 'x' })).toContain('Error');
  });

  test('sin content retorna error', () => {
    expect(WRITE_FILE.execute({ path: path.join(dir, 'f.txt') })).toContain('Error');
  });

  test('escribe archivo y retorna confirmación', () => {
    const f = path.join(dir, 'salida.txt');
    const r = WRITE_FILE.execute({ path: f, content: 'prueba escritura' });
    expect(r).toContain('Archivo escrito');
    expect(fs.readFileSync(f, 'utf8')).toBe('prueba escritura');
  });

  test('crea directorios intermedios automáticamente', () => {
    const f = path.join(dir, 'sub', 'dir', 'nested.txt');
    WRITE_FILE.execute({ path: f, content: 'nested' });
    expect(fs.existsSync(f)).toBe(true);
  });
});

// ── list_dir tool ─────────────────────────────────────────────────────────────

describe('list_dir tool', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-list-'));
    fs.writeFileSync(path.join(dir, 'archivo.txt'), '');
    fs.mkdirSync(path.join(dir, 'subcarpeta'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('lista entradas del directorio con tipo file/dir', () => {
    const r = LIST_DIR.execute({ path: dir });
    expect(r).toContain('archivo.txt');
    expect(r).toContain('subcarpeta');
    expect(r).toMatch(/file\t|dir\t/);
  });

  test('directorio vacío retorna "(directorio vacío)"', () => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    expect(LIST_DIR.execute({ path: empty })).toBe('(directorio vacío)');
  });

  test('directorio inexistente retorna error', () => {
    expect(LIST_DIR.execute({ path: '/dir-que-no-existe-999' })).toContain('Error');
  });
});

// ── search_files tool ─────────────────────────────────────────────────────────

describe('search_files tool', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-search-'));
    fs.writeFileSync(path.join(dir, 'test.js'), '');
    fs.writeFileSync(path.join(dir, 'test.json'), '');
    fs.writeFileSync(path.join(dir, 'other.txt'), '');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('sin pattern retorna error', () => {
    expect(SEARCH_FILES.execute({})).toContain('Error');
  });

  test('encuentra archivos por extensión', () => {
    const r = SEARCH_FILES.execute({ pattern: '*.js', dir });
    expect(r).toContain('test.js');
  });
});

// ── pty tools ─────────────────────────────────────────────────────────────────

describe('pty tools', () => {
  test('pty_write sin session_id retorna error', () => {
    expect(PTY_WRITE.execute({ input: 'cmd' }, {})).toContain('Error');
  });

  test('pty_write sin sessionManager retorna error', () => {
    expect(PTY_WRITE.execute({ session_id: 's1', input: 'cmd' }, {}))
      .toContain('sessionManager no disponible');
  });

  test('pty_write con sesión inexistente retorna error', () => {
    const sm = { get: () => null };
    expect(PTY_WRITE.execute({ session_id: 'no-existe', input: 'cmd' }, { sessionManager: sm }))
      .toContain('sesión no encontrada');
  });

  test('pty_write con sesión válida llama session.input() y retorna "ok"', () => {
    let received = null;
    const sm = { get: () => ({ input: (t) => { received = t; } }) };
    const r = PTY_WRITE.execute({ session_id: 's1', input: 'hello pty' }, { sessionManager: sm });
    expect(r).toBe('ok');
    expect(received).toBe('hello pty');
  });

  test('pty_read sin session_id retorna error', () => {
    expect(PTY_READ.execute({}, {})).toContain('Error');
  });

  test('pty_read sin sessionManager retorna error', () => {
    expect(PTY_READ.execute({ session_id: 's1' }, {}))
      .toContain('sessionManager no disponible');
  });

  test('pty_read devuelve output de la sesión', () => {
    const sm = { get: () => ({ getOutputSince: () => 'output del pty' }) };
    expect(PTY_READ.execute({ session_id: 's1' }, { sessionManager: sm }))
      .toBe('output del pty');
  });

  test('pty_read retorna "(sin output)" cuando la sesión no tiene output', () => {
    const sm = { get: () => ({ getOutputSince: () => '' }) };
    expect(PTY_READ.execute({ session_id: 's1' }, { sessionManager: sm }))
      .toBe('(sin output)');
  });

  test('pty_read pasa el timestamp "since" a getOutputSince()', () => {
    let receivedTs = null;
    const sm = { get: () => ({ getOutputSince: (ts) => { receivedTs = ts; return 'data'; } }) };
    PTY_READ.execute({ session_id: 's1', since: '1234567890' }, { sessionManager: sm });
    expect(receivedTs).toBe(1234567890);
  });
});

// ── tools/index.js ────────────────────────────────────────────────────────────

describe('tools/index.js', () => {
  const EXPECTED_TOOLS = ['bash', 'read_file', 'write_file', 'list_dir', 'search_files', 'pty_write', 'pty_read'];

  test('all() retorna un array con 7 tools', () => {
    expect(toolsIndex.all()).toHaveLength(7);
  });

  test('all() incluye los tools esperados', () => {
    const names = toolsIndex.all().map(t => t.name);
    for (const name of EXPECTED_TOOLS) {
      expect(names).toContain(name);
    }
  });

  test('execute() con herramienta desconocida retorna string de error', async () => {
    const r = await toolsIndex.execute('herramienta-inexistente', {});
    expect(typeof r).toBe('string');
    expect(r).toMatch(/Error|desconocida/);
  });

  test('execute() llama al tool correcto y retorna string', async () => {
    const id = 'idx-exec-' + Date.now();
    const r  = await toolsIndex.execute('bash', { command: 'echo idx_ok' }, { shellId: id });
    expect(r).toContain('idx_ok');
    destroyShell(id);
  });

  test('execute() captura excepciones del tool y las retorna como string', async () => {
    // bash con command vacío — bash.execute retorna 'Error: ...' sin lanzar
    const r = await toolsIndex.execute('bash', { command: '' }, {});
    expect(typeof r).toBe('string');
  });
});
