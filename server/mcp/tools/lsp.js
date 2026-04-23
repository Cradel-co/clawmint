'use strict';

/**
 * mcp/tools/lsp.js — 6 tools LSP que delegan al `LSPServerManager` inyectado
 * en ctx. Fase 10.
 *
 * Flag: `LSP_ENABLED=false` por default. Con flag off, todas las tools devuelven
 * el mismo mensaje de error para que el modelo sepa que no está disponible.
 *
 * Si el manager no está en ctx, error. Si está pero el binario del language
 * server no existe o falla en spawn, error amigable (el manager throwea y la
 * tool lo captura).
 */

const { pathToFileURL } = require('url');
const path = require('path');

const LSP_ENABLED = () => process.env.LSP_ENABLED === 'true';

function _disabled() {
  return 'LSP no está habilitado (LSP_ENABLED=false).';
}

function _resolveMgr(ctx) {
  return ctx && ctx.lspServerManager;
}

function _uri(filePath) {
  return pathToFileURL(filePath).href;
}

function _checkAvailability(mgr, filePath) {
  if (typeof mgr.isAvailableForFile !== 'function') return null; // manager sin fail-open support
  const { language, available } = mgr.isAvailableForFile(filePath);
  if (language && !available) {
    return `Error: language server para "${language}" no está instalado en el host. Verificá con workspace_status o el admin.`;
  }
  return null;
}

async function _safeRequest({ mgr, filePath, workspaceRoot, method, position }) {
  const avail = _checkAvailability(mgr, filePath);
  if (avail) return avail;
  try {
    const result = await mgr.request({
      filePath, workspaceRoot, method,
      paramsBuilder: () => ({
        textDocument: { uri: _uri(filePath) },
        ...(position ? { position } : {}),
      }),
    });
    if (result && result.unsupported) {
      return `Error: no hay language server configurado para ${path.extname(filePath) || filePath}`;
    }
    return result;
  } catch (err) {
    return `Error LSP (${method}): ${err.message}`;
  }
}

function _formatLocations(locations) {
  if (!locations) return '(sin resultados)';
  const arr = Array.isArray(locations) ? locations : [locations];
  if (arr.length === 0) return '(sin resultados)';
  return arr.map(l => {
    const uri = l.uri || (l.targetUri || '');
    const range = l.range || l.targetRange || {};
    const start = range.start || { line: 0, character: 0 };
    return `${uri}:${start.line + 1}:${start.character + 1}`;
  }).join('\n');
}

function _formatHover(hover) {
  if (!hover) return '(sin hover)';
  const c = hover.contents;
  if (!c) return '(sin hover)';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : x.value).join('\n');
  if (c.value) return c.value;
  return JSON.stringify(c);
}

function _formatSymbols(syms) {
  if (!syms || !Array.isArray(syms) || syms.length === 0) return '(sin símbolos)';
  return syms.map(s => {
    const loc = s.location || {};
    const range = loc.range || s.range || {};
    const start = range.start || { line: 0, character: 0 };
    const name = s.name || '(sin nombre)';
    return `${name}\t${loc.uri || ''}:${start.line + 1}`;
  }).join('\n');
}

const LSP_GO_TO_DEFINITION = {
  name: 'lsp_go_to_definition',
  description: 'Salta a la definición del símbolo en la posición dada (line/character 0-indexed).',
  params: { file: 'string', line: 'number', character: 'number' },
  async execute({ file, line, character } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!file) return 'Error: parámetro file requerido';
    const r = await _safeRequest({
      mgr, filePath: file, workspaceRoot: ctx.cwd,
      method: 'textDocument/definition',
      position: { line: Number(line) || 0, character: Number(character) || 0 },
    });
    return typeof r === 'string' ? r : _formatLocations(r);
  },
};

const LSP_FIND_REFERENCES = {
  name: 'lsp_find_references',
  description: 'Busca referencias al símbolo en la posición (incluye declaración).',
  params: { file: 'string', line: 'number', character: 'number' },
  async execute({ file, line, character } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!file) return 'Error: parámetro file requerido';
    const avail = _checkAvailability(mgr, file);
    if (avail) return avail;
    try {
      const result = await mgr.request({
        filePath: file, workspaceRoot: ctx.cwd,
        method: 'textDocument/references',
        paramsBuilder: () => ({
          textDocument: { uri: _uri(file) },
          position: { line: Number(line) || 0, character: Number(character) || 0 },
          context: { includeDeclaration: true },
        }),
      });
      if (result && result.unsupported) return `Error: no hay language server para ${path.extname(file)}`;
      return _formatLocations(result);
    } catch (err) {
      return `Error LSP (references): ${err.message}`;
    }
  },
};

const LSP_HOVER = {
  name: 'lsp_hover',
  description: 'Hover docs / tipo del símbolo en la posición.',
  params: { file: 'string', line: 'number', character: 'number' },
  async execute({ file, line, character } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!file) return 'Error: parámetro file requerido';
    const r = await _safeRequest({
      mgr, filePath: file, workspaceRoot: ctx.cwd,
      method: 'textDocument/hover',
      position: { line: Number(line) || 0, character: Number(character) || 0 },
    });
    return typeof r === 'string' ? r : _formatHover(r);
  },
};

const LSP_DOCUMENT_SYMBOLS = {
  name: 'lsp_document_symbols',
  description: 'Lista todos los símbolos definidos en un archivo.',
  params: { file: 'string' },
  async execute({ file } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!file) return 'Error: parámetro file requerido';
    const availDs = _checkAvailability(mgr, file);
    if (availDs) return availDs;
    try {
      const result = await mgr.request({
        filePath: file, workspaceRoot: ctx.cwd,
        method: 'textDocument/documentSymbol',
        paramsBuilder: () => ({ textDocument: { uri: _uri(file) } }),
      });
      if (result && result.unsupported) return `Error: no hay language server para ${path.extname(file)}`;
      return _formatSymbols(result);
    } catch (err) {
      return `Error LSP (documentSymbol): ${err.message}`;
    }
  },
};

const LSP_WORKSPACE_SYMBOLS = {
  name: 'lsp_workspace_symbols',
  description: 'Busca símbolos por nombre en todo el workspace.',
  params: { query: 'string', file: '?string' },
  async execute({ query, file } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!query) return 'Error: parámetro query requerido';
    // Si no nos dan file, usamos un dummy para que el manager resuelva ts por default
    const filePath = file || path.join(ctx.cwd || process.cwd(), 'dummy.ts');
    try {
      const result = await mgr.request({
        filePath, workspaceRoot: ctx.cwd,
        method: 'workspace/symbol',
        paramsBuilder: () => ({ query }),
      });
      if (result && result.unsupported) return `Error: no hay language server disponible`;
      return _formatSymbols(result);
    } catch (err) {
      return `Error LSP (workspaceSymbol): ${err.message}`;
    }
  },
};

const LSP_DIAGNOSTICS = {
  name: 'lsp_diagnostics',
  description: 'Diagnósticos (errores, warnings) de un archivo.',
  params: { file: 'string' },
  async execute({ file } = {}, ctx = {}) {
    if (!LSP_ENABLED()) return _disabled();
    const mgr = _resolveMgr(ctx);
    if (!mgr) return 'Error: LSPServerManager no disponible en ctx';
    if (!file) return 'Error: parámetro file requerido';
    const availDx = _checkAvailability(mgr, file);
    if (availDx) return availDx;
    try {
      // LSP v3.17: textDocument/diagnostic (pull model). Muchos servers aún
      // usan push via publishDiagnostics. Intentamos pull primero.
      const result = await mgr.request({
        filePath: file, workspaceRoot: ctx.cwd,
        method: 'textDocument/diagnostic',
        paramsBuilder: () => ({ textDocument: { uri: _uri(file) } }),
      });
      if (result && result.unsupported) return `Error: no hay language server para ${path.extname(file)}`;
      const items = (result && result.items) || [];
      if (items.length === 0) return '(sin diagnósticos)';
      return items.map(d => {
        const sev = ['', 'error', 'warning', 'info', 'hint'][d.severity || 1];
        const r = d.range?.start || { line: 0, character: 0 };
        return `${sev}\t${r.line + 1}:${r.character + 1}\t${d.message}`;
      }).join('\n');
    } catch (err) {
      return `Error LSP (diagnostic): ${err.message}`;
    }
  },
};

module.exports = [
  LSP_GO_TO_DEFINITION,
  LSP_FIND_REFERENCES,
  LSP_HOVER,
  LSP_DOCUMENT_SYMBOLS,
  LSP_WORKSPACE_SYMBOLS,
  LSP_DIAGNOSTICS,
];
