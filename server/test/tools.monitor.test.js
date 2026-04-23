'use strict';

const tools = require('../mcp/tools/monitor');
function byName(n) { return tools.find(t => t.name === n); }

describe('monitor_process', () => {
  test('sin sessionManager → error', () => {
    expect(byName('monitor_process').execute({}, {})).toMatch(/sessionManager/);
  });

  test('sin shell activo → mensaje informativo', () => {
    const out = byName('monitor_process').execute({}, {
      sessionManager: { getShell: () => null },
      chatId: 'c1',
    });
    expect(out).toMatch(/shell no activo/);
  });

  test('shell sin snapshot() → mensaje informativo', () => {
    const out = byName('monitor_process').execute({}, {
      sessionManager: { getShell: () => ({ _proc: {} }) },
      chatId: 'c1',
    });
    expect(out).toMatch(/snapshot/);
  });

  test('con snapshot → devuelve tail + cursor', () => {
    const stdout = 'line1\nline2\nline3\n';
    const out = byName('monitor_process').execute({ cursor: 0 }, {
      sessionManager: { getShell: () => ({ _proc: {}, snapshot: () => ({ stdout }) }) },
      chatId: 'c1',
    });
    expect(out).toMatch(/cursor=\d+/);
    expect(out).toMatch(/line1/);
    expect(out).toMatch(/line3/);
  });

  test('cursor filtra bytes ya leídos', () => {
    const stdout = 'primera parte\nsegunda parte\n';
    const out = byName('monitor_process').execute({ cursor: 14 }, {
      sessionManager: { getShell: () => ({ _proc: {}, snapshot: () => ({ stdout }) }) },
      chatId: 'c1',
    });
    expect(out).not.toMatch(/primera/);
    expect(out).toMatch(/segunda/);
  });

  test('pattern filtra líneas', () => {
    const stdout = 'INFO: ok\nERROR: fail\nDEBUG: x\n';
    const out = byName('monitor_process').execute({ pattern: 'ERROR' }, {
      sessionManager: { getShell: () => ({ _proc: {}, snapshot: () => ({ stdout }) }) },
      chatId: 'c1',
    });
    expect(out).toMatch(/ERROR/);
    expect(out).not.toMatch(/DEBUG/);
  });

  test('pattern inválido → error', () => {
    const out = byName('monitor_process').execute({ pattern: '[unterminated' }, {
      sessionManager: { getShell: () => ({ _proc: {}, snapshot: () => ({ stdout: 'x' }) }) },
      chatId: 'c1',
    });
    expect(out).toMatch(/pattern inválido/);
  });

  test('sin output nuevo (cursor >= length)', () => {
    const out = byName('monitor_process').execute({ cursor: 100 }, {
      sessionManager: { getShell: () => ({ _proc: {}, snapshot: () => ({ stdout: 'short' }) }) },
      chatId: 'c1',
    });
    expect(out).toMatch(/sin output nuevo/);
  });
});
