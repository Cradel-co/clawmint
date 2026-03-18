'use strict';

/**
 * sqlite-wrapper.js — Wrapper de compatibilidad better-sqlite3 sobre sql.js (WASM).
 *
 * Expone la misma API síncrona que better-sqlite3:
 *   const Database = require('./storage/sqlite-wrapper');
 *   const db = new Database('/ruta/a/archivo.db');  // o ':memory:'
 *   db.pragma('journal_mode = WAL');
 *   db.exec('CREATE TABLE ...');
 *   db.prepare('SELECT ...').all(param1, param2);
 *   db.prepare('INSERT ...').run(param1, param2);
 *   db.prepare('SELECT ...').get(param1);
 *
 * Persistencia: auto-save debounced tras cada escritura (run/exec).
 */

const fs   = require('fs');
const path = require('path');

// ── Inicialización WASM (una sola vez, síncrona con deasync-like approach) ───

let _SQL = null;
let _initPromise = null;

function _ensureSQL() {
  if (_SQL) return _SQL;

  // sql.js requiere init async; usamos un patrón de carga eager
  // que se ejecuta al primer require() de este módulo.
  throw new Error(
    'sql.js WASM no inicializado. Llamar await SqliteWrapper.initialize() antes de crear instancias.'
  );
}

// ── Statement wrapper ────────────────────────────────────────────────────────

class StatementWrapper {
  /**
   * @param {object} db     - instancia sql.js Database
   * @param {string} sql    - query SQL
   * @param {object} parent - DatabaseWrapper padre (para marcar dirty)
   */
  constructor(db, sql, parent) {
    this._db = db;
    this._sql = sql;
    this._parent = parent;
  }

  /**
   * Ejecuta INSERT/UPDATE/DELETE (no retorna filas).
   * Compatible con better-sqlite3: .run(param1, param2, ...)
   * @returns {{ changes: number, lastInsertRowid: number }}
   */
  run(...params) {
    this._db.run(this._sql, params.length ? params : undefined);
    this._parent._markDirty();
    return {
      changes: this._db.getRowsModified(),
      lastInsertRowid: 0  // sql.js no expone esto fácilmente
    };
  }

  /**
   * Retorna la primera fila como objeto, o undefined si no hay resultados.
   * Compatible con better-sqlite3: .get(param1, param2, ...)
   */
  get(...params) {
    let stmt;
    try {
      stmt = this._db.prepare(this._sql);
      if (params.length) stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      if (stmt) stmt.free();
    }
  }

  /**
   * Retorna todas las filas como array de objetos.
   * Compatible con better-sqlite3: .all(param1, param2, ...)
   */
  all(...params) {
    let stmt;
    try {
      stmt = this._db.prepare(this._sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      if (stmt) stmt.free();
    }
  }
}

// ── Database wrapper ─────────────────────────────────────────────────────────

const SAVE_DELAY_MS = 500; // debounce de auto-save

class DatabaseWrapper {
  /**
   * @param {string} dbPath - ruta al archivo .db, o ':memory:'
   */
  constructor(dbPath) {
    _ensureSQL(); // lanza si no está inicializado

    this._path = dbPath;
    this._inMemory = (dbPath === ':memory:' || !dbPath);
    this._saveTimer = null;
    this._closed = false;

    // Cargar DB existente o crear nueva
    if (!this._inMemory && fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      this._db = new _SQL.Database(buffer);
    } else {
      this._db = new _SQL.Database();
    }
  }

  /**
   * Ejecuta PRAGMA. Compatible con better-sqlite3: db.pragma('journal_mode = WAL')
   * Si es un setter (contiene '='), ejecuta y retorna undefined.
   * Si es un getter, retorna el valor.
   */
  pragma(pragmaStr) {
    if (pragmaStr.includes('=')) {
      // Setter — algunos pragmas (WAL) no aplican en sql.js, ignorar silenciosamente
      try {
        this._db.run(`PRAGMA ${pragmaStr}`);
      } catch (_) { /* ignorar pragmas no soportados */ }
      return undefined;
    }
    // Getter
    let stmt;
    try {
      stmt = this._db.prepare(`PRAGMA ${pragmaStr}`);
      if (stmt.step()) {
        const row = stmt.get();
        return row ? row[0] : undefined;
      }
      return undefined;
    } finally {
      if (stmt) stmt.free();
    }
  }

  /**
   * Ejecuta SQL arbitrario (DDL, multi-statement).
   * Compatible con better-sqlite3: db.exec(sql)
   */
  exec(sql) {
    if (!sql) return this;
    this._db.run(sql);
    this._markDirty();
    return this;
  }

  /**
   * Prepara un statement. Retorna wrapper con .run(), .get(), .all()
   * Compatible con better-sqlite3: db.prepare(sql)
   */
  prepare(sql) {
    return new StatementWrapper(this._db, sql, this);
  }

  /**
   * Cierra la DB y guarda a disco si aplica.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
    this._db.close();
  }

  /**
   * Marca la DB como modificada → programa auto-save debounced.
   */
  _markDirty() {
    if (this._inMemory || this._closed) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveToDisk();
      this._saveTimer = null;
    }, SAVE_DELAY_MS);
  }

  /**
   * Exporta y guarda la DB a disco.
   */
  _saveToDisk() {
    if (this._inMemory || this._closed) return;
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, buffer);
    } catch (err) {
      console.error('[sqlite-wrapper] Error guardando DB:', err.message);
    }
  }
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Inicializa sql.js WASM. Debe llamarse UNA VEZ antes de crear instancias.
 * @returns {Promise<void>}
 */
async function initialize() {
  if (_SQL) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const initSqlJs = require('sql.js');
    _SQL = await initSqlJs();
  })();

  return _initPromise;
}

/**
 * Verifica si sql.js ya fue inicializado.
 */
function isInitialized() {
  return _SQL !== null;
}

// Re-exportar la clase como default (drop-in de better-sqlite3)
// Uso: const Database = require('./sqlite-wrapper');
//      await Database.initialize();
//      const db = new Database('/ruta/db.sqlite');
module.exports = DatabaseWrapper;
module.exports.initialize = initialize;
module.exports.isInitialized = isInitialized;
