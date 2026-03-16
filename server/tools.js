'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_CWD = process.env.HOME || '/';
const MAX_FILE_SIZE = 50 * 1024; // 50KB

const TOOLS = [
  {
    name: 'bash',
    description: 'Ejecuta un comando bash en el servidor. Retorna stdout y stderr.',
    params: { command: 'string' },
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo. Límite 50KB.',
    params: { path: 'string' },
  },
  {
    name: 'write_file',
    description: 'Escribe contenido en un archivo, creando directorios intermedios si es necesario.',
    params: { path: 'string', content: 'string' },
  },
  {
    name: 'list_dir',
    description: 'Lista el contenido de un directorio mostrando tipo (file/dir) y nombre.',
    params: { path: 'string' },
  },
  {
    name: 'search_files',
    description: 'Busca archivos por patrón glob recursivo. Ej: "**/*.js".',
    params: { pattern: 'string', dir: '?string' },
  },
];

async function executeTool(name, args) {
  try {
    switch (name) {
      case 'bash': {
        const cmd = args.command;
        if (!cmd) return 'Error: parámetro command requerido';
        try {
          const output = execSync(cmd, {
            cwd: DEFAULT_CWD,
            timeout: 30000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return output || '(sin output)';
        } catch (err) {
          const stdout = err.stdout || '';
          const stderr = err.stderr || '';
          return [stdout, stderr].filter(Boolean).join('\n') || `Error: ${err.message}`;
        }
      }

      case 'read_file': {
        const filePath = args.path;
        if (!filePath) return 'Error: parámetro path requerido';
        const resolved = path.resolve(DEFAULT_CWD, filePath);
        if (!fs.existsSync(resolved)) return `Error: archivo no encontrado: ${resolved}`;
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_FILE_SIZE) return `Error: archivo demasiado grande (${stat.size} bytes, límite 50KB)`;
        return fs.readFileSync(resolved, 'utf8');
      }

      case 'write_file': {
        const filePath = args.path;
        const content = args.content;
        if (!filePath) return 'Error: parámetro path requerido';
        if (content === undefined) return 'Error: parámetro content requerido';
        const resolved = path.resolve(DEFAULT_CWD, filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return `Archivo escrito: ${resolved}`;
      }

      case 'list_dir': {
        const dirPath = args.path || DEFAULT_CWD;
        const resolved = path.resolve(DEFAULT_CWD, dirPath);
        if (!fs.existsSync(resolved)) return `Error: directorio no encontrado: ${resolved}`;
        const entries = fs.readdirSync(resolved);
        const items = entries.map(name => {
          try {
            const stat = fs.statSync(path.join(resolved, name));
            return `${stat.isDirectory() ? 'dir' : 'file'}\t${name}`;
          } catch {
            return `file\t${name}`;
          }
        });
        return items.join('\n') || '(directorio vacío)';
      }

      case 'search_files': {
        const pattern = args.pattern;
        const dir = args.dir || DEFAULT_CWD;
        if (!pattern) return 'Error: parámetro pattern requerido';
        // Usar find como fallback simple para glob
        try {
          const resolved = path.resolve(DEFAULT_CWD, dir);
          // Convertir glob básico a find: ** → cualquier profundidad
          const cmd = `find "${resolved}" -name "${pattern.replace('**/', '').replace('**', '*')}" 2>/dev/null | head -50`;
          const output = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
          return output.trim() || '(sin resultados)';
        } catch {
          return '(sin resultados)';
        }
      }

      default:
        return `Error: herramienta desconocida: ${name}`;
    }
  } catch (err) {
    return `Error ejecutando ${name}: ${err.message}`;
  }
}

function toAnthropicFormat() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(t.params).map(([k, v]) => [
          k,
          { type: 'string', description: k },
        ])
      ),
      required: Object.entries(t.params)
        .filter(([, v]) => !v.startsWith('?'))
        .map(([k]) => k),
    },
  }));
}

function toGeminiFormat() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(t.params).map(([k, v]) => [
          k.replace('?', ''),
          { type: 'STRING', description: k },
        ])
      ),
      required: Object.entries(t.params)
        .filter(([, v]) => !v.startsWith('?'))
        .map(([k]) => k),
    },
  }));
}

function toOpenAIFormat() {
  return TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.params).map(([k, v]) => [
            k,
            { type: 'string', description: k },
          ])
        ),
        required: Object.entries(t.params)
          .filter(([, v]) => !v.startsWith('?'))
          .map(([k]) => k),
      },
    },
  }));
}

module.exports = { TOOLS, executeTool, toAnthropicFormat, toGeminiFormat, toOpenAIFormat };
