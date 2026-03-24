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

const EDIT_FILE = {
  name: 'edit_file',
  description: 'Edita un archivo reemplazando texto exacto. Más seguro que write_file para cambios parciales.',
  inputSchema: {
    type: 'object',
    properties: {
      path:        { type: 'string', description: 'Ruta del archivo a editar' },
      old_string:  { type: 'string', description: 'Texto exacto a buscar en el archivo' },
      new_string:  { type: 'string', description: 'Texto de reemplazo' },
      replace_all: { type: 'string', description: 'Si es "true", reemplaza todas las ocurrencias. Default: solo la primera (debe ser única).' },
    },
    required: ['path', 'old_string', 'new_string'],
  },

  execute({ path: filePath, old_string, new_string, replace_all } = {}) {
    if (!filePath)                return 'Error: parámetro path requerido';
    if (old_string === undefined) return 'Error: parámetro old_string requerido';
    if (new_string === undefined) return 'Error: parámetro new_string requerido';

    const resolved = path.resolve(DEFAULT_CWD, filePath);
    if (!fs.existsSync(resolved)) return `Error: archivo no encontrado: ${resolved}`;

    const content = fs.readFileSync(resolved, 'utf8');

    if (!content.includes(old_string)) {
      return `Error: old_string no encontrado en ${resolved}. Verificá que el texto sea exacto (incluyendo espacios e indentación).`;
    }

    const doAll = replace_all === 'true' || replace_all === true;

    if (!doAll) {
      // Verificar unicidad
      const firstIdx = content.indexOf(old_string);
      const secondIdx = content.indexOf(old_string, firstIdx + 1);
      if (secondIdx !== -1) {
        const count = content.split(old_string).length - 1;
        return `Error: old_string aparece ${count} veces en el archivo. Usá replace_all:"true" o proporcioná más contexto para que sea único.`;
      }
    }

    const updated = doAll
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);

    fs.writeFileSync(resolved, updated, 'utf8');
    const replacements = doAll ? content.split(old_string).length - 1 : 1;
    return `OK: ${replacements} reemplazo(s) en ${resolved}`;
  },
};

module.exports = [READ_FILE, WRITE_FILE, EDIT_FILE, LIST_DIR, SEARCH_FILES];
