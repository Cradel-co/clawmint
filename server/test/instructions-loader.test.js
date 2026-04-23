'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const InstructionsLoader = require('../services/InstructionsLoader');

function mktemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, name, content) {
  const abs = path.join(dir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('InstructionsLoader', () => {
  let tmpRepo, tmpHome;

  beforeEach(() => {
    tmpRepo = mktemp('il-repo-');
    tmpHome = mktemp('il-home-');
  });

  afterEach(() => {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  test('flag off → no-op', () => {
    writeFile(tmpRepo, 'CLAUDE.md', '# test');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: false });
    expect(il.build({})).toBe('');
  });

  test('carga CLAUDE.md del repo cuando está habilitado', () => {
    writeFile(tmpRepo, 'CLAUDE.md', '# Instrucciones del proyecto\nSer conciso.');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out).toContain('[instructions: CLAUDE.md (repo)]');
    expect(out).toContain('Ser conciso');
  });

  test('carga GLOBAL.md de ~/.clawmint', () => {
    writeFile(tmpHome, '.clawmint/GLOBAL.md', 'Respondé siempre en español.');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out).toContain('[instructions: GLOBAL.md (~/.clawmint)]');
    expect(out).toContain('español');
  });

  test('orden jerárquico: GLOBAL → CLAUDE → AGENTS (cwd)', () => {
    writeFile(tmpHome, '.clawmint/GLOBAL.md', 'GLOBAL_MARKER');
    writeFile(tmpRepo, 'CLAUDE.md', 'REPO_MARKER');
    const cwd = mktemp('il-cwd-');
    writeFile(cwd, 'AGENTS.md', 'CWD_MARKER');
    try {
      const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
      const out = il.build({ cwd });
      const gi = out.indexOf('GLOBAL_MARKER');
      const ri = out.indexOf('REPO_MARKER');
      const ci = out.indexOf('CWD_MARKER');
      expect(gi).toBeGreaterThanOrEqual(0);
      expect(ri).toBeGreaterThan(gi);
      expect(ci).toBeGreaterThan(ri);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('strip frontmatter YAML del body', () => {
    writeFile(tmpRepo, 'CLAUDE.md', '---\ntitle: foo\n---\n\nContenido real.');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out).not.toContain('title: foo');
    expect(out).toContain('Contenido real');
  });

  test('strip comentarios HTML', () => {
    writeFile(tmpRepo, 'CLAUDE.md', 'antes <!-- secreto --> después');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out).not.toContain('secreto');
    expect(out).toContain('antes');
    expect(out).toContain('después');
  });

  test('cap 40KB con disclaimer', () => {
    const big = 'x'.repeat(50 * 1024);
    writeFile(tmpRepo, 'CLAUDE.md', big);
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out.length).toBeLessThan(45 * 1024);
    expect(out).toContain('truncado');
  });

  test('archivo inexistente no bloquea', () => {
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    const out = il.build({});
    expect(out).toBe('');
  });

  test('cache invalida al cambiar mtime', () => {
    const p = writeFile(tmpRepo, 'CLAUDE.md', 'v1');
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true });
    expect(il.build({})).toContain('v1');
    // Simular cambio con mtime distinto
    const future = new Date(Date.now() + 1000);
    fs.writeFileSync(p, 'v2', 'utf8');
    fs.utimesSync(p, future, future);
    expect(il.build({})).toContain('v2');
  });

  test('emite hook instructions_loaded si hookRegistry presente', async () => {
    writeFile(tmpRepo, 'CLAUDE.md', 'stuff');
    const events = [];
    const fakeHook = {
      enabled: true,
      emit: (event, payload, ctx) => { events.push({ event, payload, ctx }); return Promise.resolve({}); },
    };
    const il = new InstructionsLoader({ repoRoot: tmpRepo, userHome: tmpHome, enabled: true, hookRegistry: fakeHook });
    il.build({ chatId: 'c1', userId: 'u1' });
    // fire-and-forget → esperar microtask
    await new Promise(r => setImmediate(r));
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('instructions_loaded');
    expect(events[0].payload.files.length).toBe(1);
    expect(events[0].ctx.chatId).toBe('c1');
  });
});
