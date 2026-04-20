'use strict';

/**
 * mcp/tools/search.js — Tools MCP de búsqueda de archivos usando ripgrep.
 *
 * Exporta:
 *   - glob: lista rutas que matchean un patrón glob (equivale a `rg --files -g`)
 *   - grep: busca contenido, con 3 modos (content/files/count) y contexto antes/después
 *
 * Dep: @vscode/ripgrep — trae binario multiplataforma.
 * Respeta assertPathAllowed del user-sandbox para aislar usuarios no-admin.
 */

const { spawn } = require('child_process');
const path = require('path');
const { rgPath } = require('@vscode/ripgrep');
const { getBaseDir, assertPathAllowed } = require('./user-sandbox');
const { grepHeadLimitDefault } = require('../../core/outputCaps');

const TIMEOUT_MS = 30_000;
const VALID_MODES = ['content', 'files', 'count'];

function _baseCwd(ctx, dir) {
  const base = getBaseDir(ctx) || process.cwd();
  const resolved = dir ? path.resolve(base, dir) : base;
  assertPathAllowed(resolved, ctx);
  return resolved;
}

function _runRg(args, cwd) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    // stdio: ['ignore', ...] — rg detecta stdin=pipe y espera input; ignorar evita el hang.
    const child = spawn(rgPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`timeout búsqueda (${TIMEOUT_MS / 1000}s)`));
    }, TIMEOUT_MS);

    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // rg exit code: 0 = matches, 1 = no matches, 2 = error real
      if (code === 0 || code === 1) resolve({ stdout, stderr, code });
      else reject(new Error(`ripgrep falló (exit ${code}): ${stderr.trim() || 'sin stderr'}`));
    });
  });
}

const GLOB = {
  name: 'glob',
  description: 'Lista archivos que matchean un patrón glob (ej. "**/*.js", "src/**/*.{ts,tsx}"). Usa ripgrep internamente.',
  params: {
    pattern: 'string',
    path: '?string',
    limit: '?number',
  },
  async execute(args = {}, ctx = {}) {
    if (!args.pattern) return 'Error: pattern requerido';
    const limit = Math.min(Number(args.limit) || 100, 1000);
    try {
      const cwd = _baseCwd(ctx, args.path);
      const rgArgs = [
        '--files',
        '--hidden',
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--glob', args.pattern,
      ];
      const { stdout } = await _runRg(rgArgs, cwd);
      const lines = stdout.split('\n').filter(Boolean).slice(0, limit);
      if (!lines.length) return '(sin resultados)';
      // Convertir a rutas absolutas para consistencia con search_files
      return lines.map(l => path.resolve(cwd, l)).join('\n');
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

const GREP = {
  name: 'grep',
  description: 'Busca un patrón regex en archivos. Modos: content (default, file:line:match), files (paths únicos), count (file:n). Soporta -A/-B/-C, glob, type, multiline.',
  params: {
    pattern: 'string',
    path: '?string',
    glob: '?string',
    type: '?string',
    mode: '?string',
    '-A': '?number',
    '-B': '?number',
    '-C': '?number',
    multiline: '?boolean',
  },
  async execute(args = {}, ctx = {}) {
    if (!args.pattern) return 'Error: pattern requerido';
    const mode = args.mode || 'content';
    if (!VALID_MODES.includes(mode)) return `Error: mode debe ser ${VALID_MODES.join('|')}`;
    try {
      const cwd = _baseCwd(ctx, args.path);
      const maxCount = grepHeadLimitDefault(); // Fase 7.5.6: default 250
      const rgArgs = [
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--max-count', String(maxCount),
      ];
      if (mode === 'files') rgArgs.push('--files-with-matches');
      else if (mode === 'count') rgArgs.push('--count');
      else rgArgs.push('--no-heading', '-n');

      if (args.glob) rgArgs.push('--glob', String(args.glob));
      if (args.type) rgArgs.push('--type', String(args.type));
      if (args.multiline) rgArgs.push('-U', '--multiline-dotall');

      const ctxN = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 20 ? String(Math.floor(n)) : null;
      };
      if (mode === 'content') {
        if (args['-A'] !== undefined) { const n = ctxN(args['-A']); if (n) rgArgs.push('-A', n); }
        if (args['-B'] !== undefined) { const n = ctxN(args['-B']); if (n) rgArgs.push('-B', n); }
        if (args['-C'] !== undefined) { const n = ctxN(args['-C']); if (n) rgArgs.push('-C', n); }
      }

      rgArgs.push('-e', String(args.pattern));
      const { stdout, code } = await _runRg(rgArgs, cwd);
      if (code === 1) return '(sin resultados)';
      const out = stdout.trim();
      return out || '(sin resultados)';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

module.exports = [GLOB, GREP];
