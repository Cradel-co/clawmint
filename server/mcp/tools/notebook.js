'use strict';

/**
 * mcp/tools/notebook.js — `notebook_edit` para Jupyter (.ipynb).
 *
 * Parser minimal:
 *   .ipynb es JSON con shape: { cells: [{ cell_type, source, metadata, outputs }], metadata, nbformat }
 *
 * NO ejecuta kernel — solo edita código/markdown en una celda existente o
 * inserta una nueva. Out of scope: ejecutar el notebook, gestionar outputs.
 *
 * Ops soportadas:
 *   - `update`  — reemplaza `source` de la celda `cellIndex`
 *   - `insert`  — inserta nueva celda antes de `cellIndex`
 *   - `delete`  — elimina celda `cellIndex`
 */

const fs = require('fs');
const path = require('path');
const { getBaseDir, assertPathAllowed } = require('./user-sandbox');

const NOTEBOOK_EDIT = {
  name: 'notebook_edit',
  description: 'Edita una celda en un archivo Jupyter (.ipynb). Ops: update (reemplaza source), insert (nueva celda antes del index), delete. NO ejecuta el notebook.',
  params: {
    path: 'string',
    cellIndex: 'number',
    op: '?string',          // 'update' (default) | 'insert' | 'delete'
    newSource: '?string',
    cellType: '?string',    // 'code' | 'markdown' (para insert)
  },
  execute(args = {}, ctx = {}) {
    if (!args.path) return 'Error: path requerido';
    const op = args.op || 'update';
    if (!['update', 'insert', 'delete'].includes(op)) return `Error: op debe ser update|insert|delete`;

    // Resolve + sandbox
    const base = getBaseDir(ctx) || process.env.HOME || '/';
    const filePath = path.resolve(base, args.path);
    try { assertPathAllowed(filePath, ctx); }
    catch (err) { return `Error: ${err.message}`; }

    if (!filePath.endsWith('.ipynb')) return 'Error: path debe ser un archivo .ipynb';
    if (!fs.existsSync(filePath)) return `Error: archivo no encontrado: ${filePath}`;

    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (err) { return `Error leyendo: ${err.message}`; }

    let nb;
    try { nb = JSON.parse(raw); }
    catch (err) { return `Error: .ipynb inválido (JSON): ${err.message}`; }

    if (!Array.isArray(nb.cells)) return 'Error: .ipynb sin array "cells"';

    const idx = Number(args.cellIndex);
    if (!Number.isInteger(idx) || idx < 0) return 'Error: cellIndex debe ser entero ≥ 0';

    if (op === 'update') {
      if (idx >= nb.cells.length) return `Error: cellIndex ${idx} fuera de rango (celdas: ${nb.cells.length})`;
      if (args.newSource === undefined) return 'Error: newSource requerido para op=update';
      nb.cells[idx].source = _toSourceArray(args.newSource);
    } else if (op === 'insert') {
      if (idx > nb.cells.length) return `Error: cellIndex ${idx} fuera de rango para insert`;
      if (args.newSource === undefined) return 'Error: newSource requerido para op=insert';
      const cellType = args.cellType || 'code';
      if (!['code', 'markdown', 'raw'].includes(cellType)) return 'Error: cellType debe ser code|markdown|raw';
      const newCell = { cell_type: cellType, source: _toSourceArray(args.newSource), metadata: {} };
      if (cellType === 'code') newCell.outputs = [], newCell.execution_count = null;
      nb.cells.splice(idx, 0, newCell);
    } else if (op === 'delete') {
      if (idx >= nb.cells.length) return `Error: cellIndex ${idx} fuera de rango`;
      nb.cells.splice(idx, 1);
    }

    try { fs.writeFileSync(filePath, JSON.stringify(nb, null, 1) + '\n', 'utf8'); }
    catch (err) { return `Error escribiendo: ${err.message}`; }

    return `${op === 'update' ? 'Actualizada' : op === 'insert' ? 'Insertada' : 'Eliminada'} celda ${idx} en ${filePath} (${nb.cells.length} celdas totales)`;
  },
};

function _toSourceArray(source) {
  // Jupyter almacena source como array de strings (una por línea) o string.
  // Normalizamos a array para consistencia.
  if (Array.isArray(source)) return source;
  const str = String(source);
  const lines = str.split('\n');
  // Cada línea excepto la última debe tener \n al final
  return lines.map((l, i) => i < lines.length - 1 ? l + '\n' : l).filter((l, i) => !(i === lines.length - 1 && l === ''));
}

module.exports = [NOTEBOOK_EDIT];
module.exports._internal = { _toSourceArray };
