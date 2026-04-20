'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const tools = require('../mcp/tools/notebook');
function byName(n) { return tools.find(t => t.name === n); }

let tmpDir;
let notebookPath;
let adminCtx;

function makeNotebook() {
  return {
    cells: [
      { cell_type: 'markdown', source: ['# Título\n'], metadata: {} },
      { cell_type: 'code', source: ['print("hola")\n'], outputs: [], execution_count: null, metadata: {} },
      { cell_type: 'code', source: ['x = 42\n'], outputs: [], execution_count: null, metadata: {} },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-test-'));
  notebookPath = path.join(tmpDir, 'test.ipynb');
  fs.writeFileSync(notebookPath, JSON.stringify(makeNotebook(), null, 2));
  process.env.HOME = tmpDir;
  adminCtx = {
    usersRepo: {
      findByIdentity: () => ({ id: 'admin-test' }),
      getById: () => ({ id: 'admin-test', role: 'admin' }),
    },
    userId: 'admin-test', chatId: 'c1', channel: 'test',
  };
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('notebook_edit — validaciones', () => {
  test('sin path → error', () => {
    expect(byName('notebook_edit').execute({}, adminCtx)).toMatch(/path requerido/);
  });

  test('op inválida → error', () => {
    expect(byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 0, op: 'bogus' }, adminCtx)).toMatch(/op debe ser/);
  });

  test('path no .ipynb → error', () => {
    fs.writeFileSync(path.join(tmpDir, 'fake.txt'), 'no ipynb');
    expect(byName('notebook_edit').execute({ path: 'fake.txt', cellIndex: 0 }, adminCtx)).toMatch(/debe ser un archivo \.ipynb/);
  });

  test('archivo inexistente → error', () => {
    expect(byName('notebook_edit').execute({ path: 'nope.ipynb', cellIndex: 0, newSource: 'x' }, adminCtx)).toMatch(/no encontrado/);
  });

  test('cellIndex negativo → error', () => {
    expect(byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: -1, newSource: 'x' }, adminCtx)).toMatch(/cellIndex/);
  });
});

describe('notebook_edit — update', () => {
  test('reemplaza source de celda existente', () => {
    const out = byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 1, newSource: 'print("nuevo")' }, adminCtx);
    expect(out).toMatch(/Actualizada celda 1/);
    const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
    expect(nb.cells[1].source.join('')).toMatch(/nuevo/);
  });

  test('cellIndex fuera de rango → error', () => {
    expect(byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 99, newSource: 'x' }, adminCtx)).toMatch(/fuera de rango/);
  });

  test('sin newSource → error', () => {
    expect(byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 0, op: 'update' }, adminCtx)).toMatch(/newSource requerido/);
  });
});

describe('notebook_edit — insert', () => {
  test('inserta nueva celda code', () => {
    const out = byName('notebook_edit').execute({
      path: 'test.ipynb', cellIndex: 1, op: 'insert', newSource: '# comentario', cellType: 'code',
    }, adminCtx);
    expect(out).toMatch(/Insertada celda 1/);
    const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
    expect(nb.cells).toHaveLength(4);
    expect(nb.cells[1].cell_type).toBe('code');
    expect(nb.cells[1].outputs).toBeDefined();
  });

  test('inserta celda markdown', () => {
    byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 0, op: 'insert', newSource: '## sub', cellType: 'markdown' }, adminCtx);
    const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
    expect(nb.cells[0].cell_type).toBe('markdown');
  });

  test('cellType inválido → error', () => {
    expect(byName('notebook_edit').execute({
      path: 'test.ipynb', cellIndex: 0, op: 'insert', newSource: 'x', cellType: 'bogus',
    }, adminCtx)).toMatch(/cellType/);
  });
});

describe('notebook_edit — delete', () => {
  test('elimina celda', () => {
    const out = byName('notebook_edit').execute({ path: 'test.ipynb', cellIndex: 1, op: 'delete' }, adminCtx);
    expect(out).toMatch(/Eliminada celda 1/);
    const nb = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0].cell_type).toBe('markdown');
    expect(nb.cells[1].source.join('')).toMatch(/x = 42/);
  });
});
