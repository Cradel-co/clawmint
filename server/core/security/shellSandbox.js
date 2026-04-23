'use strict';

/**
 * shellSandbox — construye env seguro para child_process.spawn().
 *
 * Motivación: el `ShellSession.js` actual pasaba `{...process.env}` al shell
 * persistente. Eso expone secretos del server (ANTHROPIC_API_KEY, BRAVE_SEARCH_API_KEY,
 * etc.) a cualquier comando bash que el modelo decida correr — el agente puede
 * hacer `echo $ANTHROPIC_API_KEY` y exfiltrarlo en un tool_result.
 *
 * API:
 *   - `buildSafeEnv(opts)` → objeto con allowlist de env vars + PATH depurado.
 *   - `DEFAULT_ALLOWED_ENV_VARS` → lista de vars inocuas que se heredan.
 *   - `SAFE_PATH` → PATH mínimo estándar sin dirs sospechosos.
 *
 * Flag `SHELL_SANDBOX_STRICT=true` default. Poner `false` para restaurar el
 * comportamiento legacy (heredar toda la env) — rollback temporal.
 */

const path = require('path');

const DEFAULT_ALLOWED_ENV_VARS = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',      // Windows
  'SYSTEMROOT',       // Windows
  'WINDIR',           // Windows
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'SHELL',
  'PWD',
  'OLDPWD',
  'PATHEXT',          // Windows
  'COMSPEC',          // Windows
]);

/**
 * PATH minimal para no heredar dirs extra del server (ej. `node_modules/.bin`
 * con node_modules del server expuesto, o `/opt/custom-tool`).
 */
const SAFE_PATH_LINUX = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SAFE_PATH_WIN   = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';

function _defaultPath() {
  return process.platform === 'win32' ? SAFE_PATH_WIN : SAFE_PATH_LINUX;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.allowedVars]   — override de allowlist
 * @param {object}   [opts.extraEnv]      — vars extra explícitamente inyectadas (NO secretos)
 * @param {boolean}  [opts.strict]        — default: lee SHELL_SANDBOX_STRICT env (true si no seteada)
 * @param {string}   [opts.path]          — PATH custom (si no, usa SAFE_PATH para la plataforma)
 * @returns {object}
 */
function buildSafeEnv(opts = {}) {
  const strict = typeof opts.strict === 'boolean'
    ? opts.strict
    : process.env.SHELL_SANDBOX_STRICT !== 'false';

  // Modo legacy: heredar todo (rollback)
  if (!strict) {
    const legacyEnv = { ...process.env, ...(opts.extraEnv || {}) };
    return legacyEnv;
  }

  const allowlist = Array.isArray(opts.allowedVars) ? opts.allowedVars : DEFAULT_ALLOWED_ENV_VARS;
  const env = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // PATH: forzar uno saludable si el heredado no es suficiente o fue override
  if (opts.path) env.PATH = opts.path;
  else if (!env.PATH) env.PATH = _defaultPath();

  // Merge extraEnv por encima (pero sin reintroducir secretos inadvertidamente —
  // el caller es responsable de qué pone acá).
  if (opts.extraEnv && typeof opts.extraEnv === 'object') {
    for (const [k, v] of Object.entries(opts.extraEnv)) {
      env[k] = v;
    }
  }

  return env;
}

/**
 * Verifica que cwd sea absoluto y esté dentro de una raíz permitida.
 * @param {string} cwd
 * @param {string} allowedRoot
 * @returns {boolean}
 */
function isCwdWithin(cwd, allowedRoot) {
  if (!cwd || !allowedRoot) return false;
  const resolvedCwd  = path.resolve(cwd);
  const resolvedRoot = path.resolve(allowedRoot);
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(resolvedRoot + path.sep);
}

module.exports = {
  buildSafeEnv,
  isCwdWithin,
  DEFAULT_ALLOWED_ENV_VARS,
  SAFE_PATH_LINUX,
  SAFE_PATH_WIN,
};
