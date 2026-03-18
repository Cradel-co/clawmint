'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_CWD  = process.env.HOME || '/';
const MAX_FILE_SIZE = 50 * 1024; // 50 KB

const READ_FILE = {
  name: 'read_file',
  description: 'Lee el contenido de un archivo. Límite 50 KB.',
  params: { path: 'string' },

  execute({ path: filePath } = {}) {
    if (!filePath) return 'Error: parámetro path requerido';
    const resolved = path.resolve(DEFAULT_CWD, filePath);
    if (!fs.existsSync(resolved)) return `Error: archivo no encontrado: ${resolved}`;
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE)
      return `Error: archivo demasiado grande (${stat.size} bytes, límite 50 KB)`;
    return fs.readFileSync(resolved, 'utf8');
  },
};

const WRITE_FILE = {
  name: 'write_file',
  description: 'Escribe contenido en un archivo, creando directorios intermedios si es necesario.',
  params: { path: 'string', content: 'string' },

  execute({ path: filePath, content } = {}) {
    if (!filePath)           return 'Error: parámetro path requerido';
    if (content === undefined) return 'Error: parámetro content requerido';
    const resolved = path.resolve(DEFAULT_CWD, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    return `Archivo escrito: ${resolved}`;
  },
};

const LIST_DIR = {
  name: 'list_dir',
  description: 'Lista el contenido de un directorio mostrando tipo (file/dir) y nombre.',
  params: { path: '?string' },

  execute({ path: dirPath } = {}) {
    const resolved = path.resolve(DEFAULT_CWD, dirPath || DEFAULT_CWD);
    if (!fs.existsSync(resolved)) return `Error: directorio no encontrado: ${resolved}`;
    const entries = fs.readdirSync(resolved);
    const items   = entries.map(name => {
      try {
        const stat = fs.statSync(path.join(resolved, name));
        return `${stat.isDirectory() ? 'dir' : 'file'}\t${name}`;
      } catch {
        return `file\t${name}`;
      }
    });
    return items.join('\n') || '(directorio vacío)';
  },
};

const SEARCH_FILES = {
  name: 'search_files',
  description: 'Busca archivos por patrón glob recursivo. Ej: "**/*.js".',
  params: { pattern: 'string', dir: '?string' },

  execute({ pattern, dir } = {}) {
    if (!pattern) return 'Error: parámetro pattern requerido';
    try {
      const resolved = path.resolve(DEFAULT_CWD, dir || DEFAULT_CWD);
      // Convertir glob simple a RegExp (cross-platform, sin depender de `find`)
      const globStr = pattern.replace('**/', '').replace('**', '*');
      const escaped = globStr.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp('^' + escaped + '$', 'i');

      const results = [];
      const MAX = 50;
      function walk(dirPath) {
        if (results.length >= MAX) return;
        let entries;
        try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (results.length >= MAX) return;
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (re.test(entry.name)) {
            results.push(full);
          }
        }
      }
      walk(resolved);
      return results.join('\n') || '(sin resultados)';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

module.exports = [READ_FILE, WRITE_FILE, LIST_DIR, SEARCH_FILES];
