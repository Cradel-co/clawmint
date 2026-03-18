'use strict';

const path = require('path');
const fs   = require('fs');

/**
 * DatabaseProvider — inicializa SQLite una sola vez.
 *
 * Permite inyectar la instancia de DB en memory.js vía setDB(),
 * evitando que cada módulo abra su propia conexión.
 */
class DatabaseProvider {
  constructor(dbPath) {
    if (!dbPath) throw new Error('DatabaseProvider: dbPath es requerido');
    this._dbPath = dbPath;
    this._db = null;
  }

  /**
   * Inicializa la DB con el schema dado y devuelve la instancia.
   * @param {string} schema - SQL de CREATE TABLE IF NOT EXISTS …
   * @returns {import('better-sqlite3').Database}
   */
  init(schema) {
    if (this._db) return this._db;

    const Database = require('./sqlite-wrapper');
    if (!Database.isInitialized()) {
      throw new Error('DatabaseProvider: sql.js no inicializado. Llamar await Database.initialize() primero.');
    }
    fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });

    this._db = new Database(this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    if (schema) this._db.exec(schema);

    return this._db;
  }

  /** @returns {import('better-sqlite3').Database | null} */
  getDB() { return this._db; }
}

module.exports = DatabaseProvider;
