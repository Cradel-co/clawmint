'use strict';

const fs = require('fs');
const path = require('path');

// Lee .env y lo convierte a objeto
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}

const sharedEnv = loadEnv();

/**
 * Dos perfiles:
 *  - `clawmint` (dev)  → watch activo + client-dev (vite HMR).
 *  - `clawmint-prod`   → sin watch, NODE_ENV=production, cluster-like. Sirve
 *    el build estático del client desde `server/index.js` via express.static.
 *
 * Uso:
 *   Dev:  pm2 start ecosystem.config.js --only clawmint,clawmint-client-dev
 *   Prod: pm2 start ecosystem.config.js --only clawmint-prod
 */
module.exports = {
  apps: [
    // ── DEV — watch + vite HMR ────────────────────────────────────────────
    {
      name: 'clawmint',
      script: 'index.js',
      node_args: '--stack-size=65536',
      env: sharedEnv,
      watch: [
        'index.js',
        'bootstrap.js',
        'agents.js',
        'memory.js',
        'mcps.js',
        'providers',
        'services',
        'routes',
        'storage',
        'core',
        'channels',
        'middleware',
        'mcp',
        'ws',
        'hooks',
        'utils',
        'mcp-oauth-providers',
      ],
      ignore_watch: [
        'node_modules',
        'test',
        'memory',
        'memory-test',
        'models-cache',
        'logs',
        'server.log',
        'logs.json',
        '.env',
        '*.json.migrated',
        'bots.json',
        'agents.json',
        'mcp-config.json',
        'provider-config.json',
        'tts-config.json',
        'reminders.json',
        '.token-master.key',
      ],
      watch_delay: 1000,
    },

    // ── DEV — vite client con HMR ─────────────────────────────────────────
    {
      name: 'clawmint-client-dev',
      script: 'node_modules/vite/bin/vite.js',
      cwd: path.join(__dirname, '..', 'client'),
      args: 'dev --host 0.0.0.0 --port 5173',
      autorestart: true,
    },

    // ── PROD — server serving client/dist ─────────────────────────────────
    {
      name: 'clawmint-prod',
      script: 'index.js',
      node_args: '--stack-size=65536',
      env: {
        ...sharedEnv,
        NODE_ENV: 'production',
      },
      watch: false,                      // nunca watch en prod
      autorestart: true,                 // pm2 respawnea si crashea
      max_memory_restart: '1G',          // restart si excede 1GB RAM
      min_uptime: '10s',                 // considera "arrancado" después de 10s
      max_restarts: 5,                   // más de 5 restarts en 1min → stop
      restart_delay: 2000,               // 2s entre restarts
      kill_timeout: 5000,                // 5s para graceful shutdown
      wait_ready: false,                 // el server no emite ready signal
      listen_timeout: 20000,             // 20s para arrancar y escuchar
      error_file:   './logs/prod-err.log',
      out_file:     './logs/prod-out.log',
      merge_logs:   true,
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ',
    },
  ],
};
