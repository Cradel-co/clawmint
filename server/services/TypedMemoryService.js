'use strict';

/**
 * TypedMemoryService — fachada sobre `TypedMemoryRepository` + filesystem.
 *
 * Responsabilidades:
 *   - `save({kind, name, description, body, scope_type, scope_id})` — escribe archivo + row.
 *   - `list({scope_type?, scope_id?, kind?})` — metadata (sin body).
 *   - `get({scope_type, scope_id, name})` — metadata + body.
 *   - `forget({scope_type, scope_id, name})` — delete row + archivo.
 *   - `index(scope_type, scope_id?)` — genera `MEMORY.md` del scope.
 *
 * Layout:
 *   memory/typed/<scope_type>/[<scope_id>/]<name>.md
 *
 * MEMORY.md por scope:
 *   memory/typed/<scope_type>/[<scope_id>/]MEMORY.md
 *
 * Cap de tokens en MEMORY.md: env `MEMORY_MD_MAX_CHARS` (default 10000).
 * Si el índice excede, se truncan las más viejas (por `updated_at`).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_CHARS = 10_000;

class TypedMemoryService {
  /**
   * @param {object} deps
   * @param {TypedMemoryRepository} deps.repo
   * @param {string} [deps.memoryRoot]      — default: `./memory/typed`
   * @param {object} [deps.logger]
   * @param {number} [deps.maxIndexChars]
   */
  constructor({ repo, memoryRoot, logger = console, maxIndexChars } = {}) {
    if (!repo) throw new Error('TypedMemoryService: repo requerido');
    this._repo = repo;
    this._root = memoryRoot || path.join(__dirname, '..', 'memory', 'typed');
    this._logger = logger;
    this._maxIndexChars = Number.isFinite(maxIndexChars)
      ? maxIndexChars
      : Number(process.env.MEMORY_MD_MAX_CHARS) || DEFAULT_MAX_CHARS;
    fs.mkdirSync(this._root, { recursive: true });
  }

  /**
   * Guarda una memoria tipada.
   * @returns {object} row persistida
   */
  save({ scope_type, scope_id = null, kind = 'freeform', name, description = null, body = '' }) {
    _validateName(name);
    const filePath = this._bodyPath(scope_type, scope_id, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(body || ''), 'utf8');

    const row = this._repo.upsert({
      scope_type, scope_id, kind, name, description,
      body_path: path.relative(this._root, filePath),
    });

    this._regenerateIndex(scope_type, scope_id);
    return row;
  }

  list({ scope_type, scope_id, kind } = {}) {
    return this._repo.list({ scope_type, scope_id, kind });
  }

  get({ scope_type, scope_id, name }) {
    const row = this._repo.findByName({ scope_type, scope_id, name });
    if (!row) return null;
    const fullPath = this._resolveBodyPath(row);
    let body = '';
    try { body = fs.readFileSync(fullPath, 'utf8'); }
    catch { body = ''; }
    return { ...row, body };
  }

  forget({ scope_type, scope_id, name }) {
    const row = this._repo.findByName({ scope_type, scope_id, name });
    if (!row) return false;
    const fullPath = this._resolveBodyPath(row);
    try { fs.unlinkSync(fullPath); } catch { /* ya no estaba */ }
    this._repo.remove(row.id);
    this._regenerateIndex(scope_type, scope_id);
    return true;
  }

  /**
   * Regenera el MEMORY.md del scope. Retorna el path absoluto del archivo.
   */
  _regenerateIndex(scope_type, scope_id) {
    const rows = this._repo.list({ scope_type, scope_id });
    const scopeDir = scope_id
      ? path.join(this._root, scope_type, _safeSegment(scope_id))
      : path.join(this._root, scope_type);
    fs.mkdirSync(scopeDir, { recursive: true });
    const memoryPath = path.join(scopeDir, 'MEMORY.md');

    if (!rows.length) {
      try { fs.writeFileSync(memoryPath, `# MEMORY (${scope_type}${scope_id ? ':' + scope_id : ''})\n\n_vacío_\n`, 'utf8'); }
      catch { /* no-op */ }
      return memoryPath;
    }

    // Orden: por kind, luego por updated_at DESC
    const sorted = rows.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return b.updated_at - a.updated_at;
    });

    const lines = [`# MEMORY (${scope_type}${scope_id ? ':' + scope_id : ''})`, ''];
    let currentKind = null;
    for (const row of sorted) {
      if (row.kind !== currentKind) {
        lines.push(`## ${row.kind}`);
        currentKind = row.kind;
      }
      const desc = row.description ? ` — ${row.description}` : '';
      lines.push(`- [${row.name}](${row.body_path})${desc}`);
    }
    let content = lines.join('\n') + '\n';

    // Cap: si excede, truncar preservando encabezado
    if (content.length > this._maxIndexChars) {
      const header = `# MEMORY (${scope_type}${scope_id ? ':' + scope_id : ''}) — TRUNCADO\n\n> Cap ${this._maxIndexChars} chars excedido (${content.length}). Entries más viejas excluidas.\n\n`;
      content = header + content.slice(header.length, this._maxIndexChars);
    }

    try { fs.writeFileSync(memoryPath, content, 'utf8'); }
    catch (err) { this._logger.warn && this._logger.warn(`[TypedMemoryService] no pude escribir ${memoryPath}: ${err.message}`); }
    return memoryPath;
  }

  /**
   * Devuelve el contenido de MEMORY.md para un scope (sin regenerar).
   */
  readIndex(scope_type, scope_id = null) {
    const scopeDir = scope_id
      ? path.join(this._root, scope_type, _safeSegment(scope_id))
      : path.join(this._root, scope_type);
    const memoryPath = path.join(scopeDir, 'MEMORY.md');
    try { return fs.readFileSync(memoryPath, 'utf8'); } catch { return ''; }
  }

  _bodyPath(scope_type, scope_id, name) {
    const safeName = _safeSegment(name) + '.md';
    if (scope_id) return path.join(this._root, scope_type, _safeSegment(scope_id), safeName);
    return path.join(this._root, scope_type, safeName);
  }

  _resolveBodyPath(row) {
    if (!row || !row.body_path) return null;
    return path.isAbsolute(row.body_path) ? row.body_path : path.join(this._root, row.body_path);
  }

  get memoryRoot() { return this._root; }
}

function _validateName(name) {
  if (!name || typeof name !== 'string') throw new Error('name inválido');
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) throw new Error('name solo permite a-zA-Z0-9_-.');
  if (name.length > 120) throw new Error('name > 120 caracteres');
}

function _safeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 120);
}

module.exports = TypedMemoryService;
