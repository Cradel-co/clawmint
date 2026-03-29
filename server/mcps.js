'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MCPS_DIR = path.join(__dirname, 'mcps');

// Asegurar directorio
if (!fs.existsSync(MCPS_DIR)) fs.mkdirSync(MCPS_DIR, { recursive: true });

function _resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const wrapper = path.join(__dirname, 'run-claude.sh');
  if (fs.existsSync(wrapper)) return wrapper;
  const nvm = '/home/kheiron/.nvm/versions/node/v22.21.1/bin/claude';
  if (fs.existsSync(nvm)) return nvm;
  return 'claude';
}

const CLAUDE_BIN = _resolveClaude();

// Env limpio para llamadas CLI (sin variables que pongan a Claude en modo servidor)
function _claudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function _filePath(name) {
  return path.join(MCPS_DIR, `${name}.json`);
}

function _read(name) {
  const p = _filePath(name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function _write(mcp) {
  fs.writeFileSync(_filePath(mcp.name), JSON.stringify(mcp, null, 2), 'utf8');
}

// ─── API pública ──────────────────────────────────────────────────────────────

function list() {
  if (!fs.existsSync(MCPS_DIR)) return [];
  return fs.readdirSync(MCPS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(MCPS_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

function get(name) {
  return _read(name);
}

function add({ name, type = 'stdio', command = '', args = [], env = {}, url = '', headers = {}, description = '' }) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name))
    throw new Error('name inválido (solo letras, números, _ y -)');
  if (_filePath(name) && fs.existsSync(_filePath(name)))
    throw new Error(`MCP "${name}" ya existe`);

  const mcp = {
    name,
    type,
    command,
    args: Array.isArray(args) ? args : [],
    env: env || {},
    url: url || '',
    headers: headers || {},
    description: description || '',
    enabled: false,
    createdAt: new Date().toISOString(),
    syncedAt: null,
  };
  _write(mcp);
  return mcp;
}

function update(name, changes) {
  const mcp = _read(name);
  if (!mcp) throw new Error(`MCP "${name}" no encontrado`);

  // Campos editables (no name, no enabled)
  const allowed = ['type', 'command', 'args', 'env', 'url', 'headers', 'description'];
  for (const k of allowed) {
    if (changes[k] !== undefined) mcp[k] = changes[k];
  }
  _write(mcp);
  return mcp;
}

function remove(name) {
  const mcp = _read(name);
  if (!mcp) return false;
  if (mcp.enabled) {
    try { unsync(name); } catch { /* ignorar si falla el unsync */ }
  }
  fs.unlinkSync(_filePath(name));
  return true;
}

// Lazy-load del pool de clientes MCP
let _pool = null;
function _getPool() {
  if (!_pool) try { _pool = require('./mcp-client-pool'); } catch {}
  return _pool;
}

async function sync(name) {
  const mcp = _read(name);
  if (!mcp) throw new Error(`MCP "${name}" no encontrado`);

  // Construir config para add-json
  const mcpConfig = { type: mcp.type };
  if (mcp.type === 'stdio') {
    mcpConfig.command = mcp.command;
    mcpConfig.args = mcp.args || [];
    if (mcp.env && Object.keys(mcp.env).length > 0) mcpConfig.env = mcp.env;
  } else {
    mcpConfig.url = mcp.url;
    if (mcp.headers && Object.keys(mcp.headers).length > 0) mcpConfig.headers = mcp.headers;
  }

  // Registrar en Claude CLI (para Claude Code) — remove + add para idempotencia
  try {
    try { execFileSync(CLAUDE_BIN, ['mcp', 'remove', name], { env: _claudeEnv(), stdio: 'pipe', timeout: 10000 }); } catch {}
    execFileSync(CLAUDE_BIN, ['mcp', 'add-json', name, JSON.stringify(mcpConfig)], {
      env: _claudeEnv(),
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (err) {
    process.stderr.write(`[mcps] Claude CLI sync falló para "${name}": ${err.message}\n`);
  }

  // Conectar al pool de clientes MCP (para providers API)
  const pool = _getPool();
  if (pool) {
    try { await pool.connectMcp(name); } catch (err) {
      process.stderr.write(`[mcps] Pool connect falló para "${name}": ${err.message}\n`);
    }
  }

  mcp.enabled = true;
  mcp.syncedAt = new Date().toISOString();
  _write(mcp);
  try { generateConfigFile(); } catch {}
  return mcp;
}

async function unsync(name) {
  const mcp = _read(name);
  if (!mcp) throw new Error(`MCP "${name}" no encontrado`);

  // Desregistrar de Claude CLI
  try {
    execFileSync(CLAUDE_BIN, ['mcp', 'remove', name], {
      env: _claudeEnv(),
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (err) {
    process.stderr.write(`[mcps] Claude CLI unsync falló para "${name}": ${err.message}\n`);
  }

  // Desconectar del pool
  const pool = _getPool();
  if (pool) {
    try { await pool.disconnectMcp(name); } catch {}
  }

  mcp.enabled = false;
  mcp.syncedAt = new Date().toISOString();
  _write(mcp);
  try { generateConfigFile(); } catch {}
  return mcp;
}

async function syncAll() {
  const all = list().filter(m => m.enabled);
  let count = 0;
  for (const mcp of all) {
    try {
      await sync(mcp.name);
      count++;
    } catch (err) {
      // No interrumpir el startup por un MCP que falla
      process.stderr.write(`[mcps] syncAll: fallo en "${mcp.name}": ${err.message}\n`);
    }
  }
  process.stdout.write(`[mcps] MCPs sincronizados: ${count}/${all.length}\n`);
}

// ─── Smithery Registry (búsqueda e instalación automática) ────────────────────

const SMITHERY_API = 'https://registry.smithery.ai/servers';

/**
 * Busca MCPs en smithery.ai registry.
 * Devuelve hasta `limit` resultados con info básica.
 */
async function searchSmithery(query, limit = 8) {
  const url = `${SMITHERY_API}?q=${encodeURIComponent(query)}&pageSize=${limit}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'terminal-live/1.0' },
  });
  if (!res.ok) throw new Error(`Smithery respondió ${res.status}`);
  const data = await res.json();
  return (data.servers || []).map(s => ({
    qualifiedName: s.qualifiedName,
    displayName:   s.displayName || s.qualifiedName,
    description:   s.description || '',
    remote:        s.remote !== false, // true = HTTP, false = stdio local
    isDeployed:    s.isDeployed !== false,
    homepage:      s.homepage || `https://smithery.ai/servers/${s.qualifiedName}`,
  }));
}

/**
 * Obtiene el detalle de un MCP en smithery, incluyendo la URL de conexión
 * (para remotos) o el bundle (para locales).
 */
async function getSmitheryDetail(qualifiedName) {
  const url = `${SMITHERY_API}/${encodeURIComponent(qualifiedName)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'terminal-live/1.0' },
  });
  if (!res.ok) throw new Error(`MCP "${qualifiedName}" no encontrado en Smithery`);
  return res.json();
}

/**
 * Instala un MCP desde smithery:
 * - Remotos (HTTP): agrega con type='http' y la deploymentUrl
 * - Locales (stdio con bundleUrl): instala con smithery runner
 * - Locales sin bundle estándar: intenta como npx @qualifiedName
 *
 * Devuelve { mcp, envVarsRequired } donde envVarsRequired es array de strings
 * con las vars de entorno que el usuario necesita configurar.
 */
async function installFromRegistry(qualifiedName, nameSafe = null) {
  const detail = await getSmitheryDetail(qualifiedName);
  const name = nameSafe || qualifiedName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);

  if (_read(name)) throw new Error(`Ya existe un MCP con nombre "${name}"`);

  const connections = detail.connections || [];
  const envVarsRequired = [];

  // Recopilar vars de entorno de todos los configSchemas
  for (const conn of connections) {
    const props = conn.configSchema?.properties || {};
    const required = conn.configSchema?.required || [];
    for (const key of required) {
      if (!envVarsRequired.includes(key)) envVarsRequired.push(key);
    }
  }

  let mcp;

  // MCPs remotos: buscar conexión HTTP/SSE
  const httpConn = connections.find(c => c.type === 'http' || c.type === 'sse');
  if (httpConn && httpConn.deploymentUrl) {
    mcp = add({
      name,
      type: httpConn.type === 'sse' ? 'sse' : 'http',
      url: httpConn.deploymentUrl,
      description: detail.description || '',
    });
    sync(name);
    return { mcp, envVarsRequired };
  }

  // MCPs locales stdio con bundleUrl de smithery
  const stdioConn = connections.find(c => c.type === 'stdio');
  if (stdioConn?.bundleUrl) {
    // Usar smithery runner: npx -y @smithery/cli run qualifiedName
    mcp = add({
      name,
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@smithery/cli', 'run', qualifiedName],
      description: detail.description || '',
    });
    sync(name);
    return { mcp, envVarsRequired };
  }

  // Fallback: intentar instalar como paquete npm si el nombre sugiere un scope
  const npmPkg = qualifiedName.includes('/') ? `@${qualifiedName}` : qualifiedName;
  mcp = add({
    name,
    type: 'stdio',
    command: 'npx',
    args: ['-y', npmPkg],
    description: detail.description || '',
  });
  sync(name);
  return { mcp, envVarsRequired };
}

/**
 * Genera mcp-config.json desde los MCPs habilitados.
 * Retorna la ruta al archivo generado.
 */
function generateConfigFile() {
  const enabled = list().filter(m => m.enabled);
  const config = { mcpServers: {} };
  for (const mcp of enabled) {
    const entry = { type: mcp.type };
    if (mcp.type === 'stdio') {
      entry.command = mcp.command;
      entry.args = mcp.args || [];
      if (mcp.env && Object.keys(mcp.env).length > 0) entry.env = mcp.env;
    } else {
      entry.url = mcp.url;
      if (mcp.headers && Object.keys(mcp.headers).length > 0) entry.headers = mcp.headers;
    }
    config.mcpServers[mcp.name] = entry;
  }
  // Siempre incluir clawmint (MCP interno)
  const port = process.env.PORT || 3001;
  config.mcpServers.clawmint = { type: 'http', url: `http://localhost:${port}/mcp` };

  const configPath = path.join(__dirname, 'mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

module.exports = { list, get, add, update, remove, sync, unsync, syncAll, generateConfigFile, MCPS_DIR, searchSmithery, installFromRegistry };
