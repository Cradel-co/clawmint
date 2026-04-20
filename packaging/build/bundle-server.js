#!/usr/bin/env node
'use strict';

/**
 * bundle-server.js — prepara `packaging/tauri/resources/` con todo lo que Tauri
 * va a bundlear: Node runtime + server/ (con node_modules rebuild para el target
 * arch) + client/dist/.
 *
 * Uso:
 *   node packaging/build/bundle-server.js --target=win32-x64
 *   node packaging/build/bundle-server.js --target=linux-x64
 *
 * Targets soportados: win32-x64, linux-x64, darwin-x64, darwin-arm64.
 *
 * Pre-requisitos:
 *   - Node 22 instalado en el sistema (se copia el binario al bundle).
 *   - npm disponible.
 *   - Para rebuild de native deps (sharp, node-pty, node-datachannel): build tools
 *     del target OS. Cross-compile no soportado en v1 — buildear en el OS target.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_SRC = path.join(REPO_ROOT, 'server');
const CLIENT_SRC = path.join(REPO_ROOT, 'client');
const RESOURCES_DIR = path.join(REPO_ROOT, 'packaging', 'tauri', 'resources');

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [k, v] = arg.replace(/^--/, '').split('=');
  acc[k] = v === undefined ? true : v;
  return acc;
}, {});

const rawTarget = args.target || `${process.platform}-${process.arch}`;
const [targetPlatform, targetArch] = rawTarget.split('-');

function log(...xs) { console.log('[bundle]', ...xs); }

function sh(cmd, opts = {}) {
  log('$', cmd);
  execSync(cmd, { stdio: 'inherit', shell: true, ...opts });
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function copyDir(src, dst, ignore = []) {
  const ignoreSet = new Set(ignore);
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignoreSet.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, ignore);
    else fs.copyFileSync(s, d);
  }
}

// ── 1. Build client ─────────────────────────────────────────────────────────
function buildClient() {
  log('building client...');
  sh('npm ci', { cwd: CLIENT_SRC });
  sh('npm run build', { cwd: CLIENT_SRC });
  const dist = path.join(CLIENT_SRC, 'dist');
  if (!fs.existsSync(dist)) throw new Error('client/dist no se generó');
  const dstClient = path.join(RESOURCES_DIR, 'client', 'dist');
  rmrf(dstClient);
  copyDir(dist, dstClient);
  log('client copied →', dstClient);
}

// ── 2. Copy server source (sin node_modules, logs, DB runtime) ──────────────
function copyServer() {
  log('copying server source...');
  const dstServer = path.join(RESOURCES_DIR, 'server');
  rmrf(dstServer);
  copyDir(SERVER_SRC, dstServer, [
    'node_modules',
    'memory',
    'memory-test',
    'memory-cache',
    'models-cache',
    'logs',
    '.env',
    'server.log',
    'logs.json',
    'bots.json',
    'bots.json.migrated',
    'agents.json',
    'mcp-config.json',
    'mcp-config.json.migrated',
    'provider-config.json',
    'tts-config.json',
    'reminders.json',
    'whisper-config.json',
    '.token-master.key',
    'test',
  ]);
  log('server copied →', dstServer);
}

// ── 3. Install production deps con rebuild de nativos ──────────────────────
function installProdDeps() {
  const dstServer = path.join(RESOURCES_DIR, 'server');
  log('installing production deps (omit dev)...');
  sh('npm install --omit=dev --no-audit --no-fund', { cwd: dstServer });
  // Rebuild específico de native deps contra el target.
  // En cross-compile real habría que usar --target_platform / --target_arch;
  // en build nativo (mismo OS) basta con el rebuild.
  if (targetPlatform === process.platform && targetArch === process.arch) {
    log('rebuilding native modules for local arch...');
    sh('npm rebuild node-pty sharp node-datachannel || echo "(algun nativo falló, continuando)"', {
      cwd: dstServer,
    });
  } else {
    log('⚠ cross-compile detectado (target !== host). Los .node nativos pueden no funcionar.');
    log('  Recomendación: buildear en el OS target directamente.');
  }
}

// ── 4. Copy Node runtime ────────────────────────────────────────────────────
function copyNodeRuntime() {
  // Tauri espera sidecar en `resources/node` o `resources/node.exe`.
  const nodeExe = process.execPath;
  const dstBin = path.join(RESOURCES_DIR, targetPlatform === 'win32' ? 'node.exe' : 'node');
  log(`copying node runtime: ${nodeExe} → ${dstBin}`);
  fs.copyFileSync(nodeExe, dstBin);
  if (targetPlatform !== 'win32') {
    try { fs.chmodSync(dstBin, 0o755); } catch {}
  }
}

// ── 5. Size report ──────────────────────────────────────────────────────────
function sizeReport() {
  function du(p) {
    let total = 0;
    if (!fs.existsSync(p)) return 0;
    const stat = fs.statSync(p);
    if (stat.isFile()) return stat.size;
    for (const entry of fs.readdirSync(p)) total += du(path.join(p, entry));
    return total;
  }
  function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }
  const server = du(path.join(RESOURCES_DIR, 'server'));
  const client = du(path.join(RESOURCES_DIR, 'client'));
  const nodeBin = du(path.join(RESOURCES_DIR, targetPlatform === 'win32' ? 'node.exe' : 'node'));
  log('--- bundle size report ---');
  log(`server:  ${mb(server)}`);
  log(`client:  ${mb(client)}`);
  log(`node:    ${mb(nodeBin)}`);
  log(`TOTAL:   ${mb(server + client + nodeBin)}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
(async function main() {
  log(`target: ${targetPlatform}-${targetArch}`);
  log(`resources dir: ${RESOURCES_DIR}`);
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });

  if (!args['skip-client']) buildClient();
  copyServer();
  installProdDeps();
  copyNodeRuntime();
  sizeReport();

  log('✓ bundle listo. Next: cd packaging/tauri && cargo tauri build');
})().catch(err => {
  console.error('[bundle] FATAL:', err.message);
  process.exit(1);
});
