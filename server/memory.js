'use strict';

const fs   = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, 'memory');

// ─── Helpers internos ────────────────────────────────────────────────────────

function _agentDir(agentKey) {
  return path.join(MEMORY_DIR, agentKey);
}

function _ensureDir(agentKey) {
  const dir = _agentDir(agentKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Valida que el filename no tenga path traversal */
function _safeName(filename) {
  const base = path.basename(filename);
  if (!base || base.startsWith('.')) throw new Error('Nombre de archivo inválido');
  return base;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

function listFiles(agentKey) {
  const dir = _agentDir(agentKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(md|json|txt)$/.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, updatedAt: stat.mtimeMs };
    });
}

function read(agentKey, filename) {
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, 'utf8');
}

function write(agentKey, filename, content) {
  _ensureDir(agentKey);
  fs.writeFileSync(path.join(_agentDir(agentKey), _safeName(filename)), content, 'utf8');
}

function append(agentKey, filename, content) {
  _ensureDir(agentKey);
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  const separator = fs.existsSync(filepath) ? '\n' : '';
  fs.appendFileSync(filepath, separator + content, 'utf8');
}

function remove(agentKey, filename) {
  const filepath = path.join(_agentDir(agentKey), _safeName(filename));
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

// ─── Inyección en system prompt ──────────────────────────────────────────────

/**
 * Construye el bloque de memoria para inyectar en el system prompt.
 * @param {string}   agentKey
 * @param {string[]} memoryFiles — lista de filenames definidos en el agente
 */
function buildMemoryContext(agentKey, memoryFiles = []) {
  if (!agentKey || !memoryFiles.length) return '';

  const parts = [];
  for (const filename of memoryFiles) {
    try {
      const content = read(agentKey, filename);
      if (content && content.trim()) {
        parts.push(`### ${filename}\n${content.trim()}`);
      }
    } catch { /* ignorar archivos no legibles */ }
  }

  if (!parts.length) return '';
  return `## Memoria persistente del agente\n\n${parts.join('\n\n---\n\n')}`;
}

// ─── Instrucciones de la herramienta ─────────────────────────────────────────

const TOOL_INSTRUCTIONS = `
## Herramienta de memoria

Podés guardar y actualizar tu memoria persistente usando estas etiquetas en tu respuesta.
El sistema las procesará y NO las mostrará al usuario.

Reemplazar archivo completo:
<save_memory file="nombre.md">
Contenido nuevo completo del archivo
</save_memory>

Agregar al final de un archivo:
<append_memory file="nombre.md">
Línea o bloque a agregar
</append_memory>

Cuándo usarla:
- El usuario menciona preferencias o estilos que debés recordar
- Se toman decisiones importantes sobre el proyecto
- Se resuelve un error con una técnica específica
- El usuario corrige algo que hacías mal
`.trim();

// ─── Extracción de operaciones de memoria del output del LLM ─────────────────

/**
 * Extrae las operaciones de memoria del texto generado por el LLM.
 * Retorna el texto limpio (sin etiquetas) y la lista de operaciones a ejecutar.
 *
 * @param {string} text — respuesta completa del LLM
 * @returns {{ clean: string, ops: Array<{file, content, mode: 'write'|'append'}> }}
 */
function extractMemoryOps(text) {
  const ops = [];

  let clean = text.replace(
    /<save_memory\s+file="([^"]+)">([\s\S]*?)<\/save_memory>/g,
    (_, file, content) => {
      ops.push({ file: path.basename(file), content: content.trim(), mode: 'write' });
      return '';
    }
  );

  clean = clean.replace(
    /<append_memory\s+file="([^"]+)">([\s\S]*?)<\/append_memory>/g,
    (_, file, content) => {
      ops.push({ file: path.basename(file), content: content.trim(), mode: 'append' });
      return '';
    }
  );

  // Limpiar líneas vacías extra que dejan las etiquetas removidas
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();

  return { clean, ops };
}

/**
 * Aplica una lista de operaciones de memoria para un agente.
 * @param {string} agentKey
 * @param {Array}  ops — resultado de extractMemoryOps
 * @returns {string[]} filenames afectados
 */
function applyOps(agentKey, ops) {
  const affected = [];
  for (const op of ops) {
    try {
      if (op.mode === 'write') write(agentKey, op.file, op.content);
      else append(agentKey, op.file, op.content);
      affected.push(op.file);
      console.log(`[Memory:${agentKey}] ${op.mode} → ${op.file}`);
    } catch (err) {
      console.error(`[Memory:${agentKey}] Error en ${op.mode} ${op.file}:`, err.message);
    }
  }
  return affected;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  MEMORY_DIR,
  listFiles,
  read,
  write,
  append,
  remove,
  buildMemoryContext,
  TOOL_INSTRUCTIONS,
  extractMemoryOps,
  applyOps,
};
