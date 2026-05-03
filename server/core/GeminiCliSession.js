'use strict';

const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const isWin = process.platform === 'win32';

// En Windows, gemini es un .ps1/.cmd que llama a node internamente.
// Invocamos node directamente para evitar los problemas de quoting de cmd.exe
// con textos multilinea. La ruta se resuelve una sola vez al cargar el módulo.
function resolveGeminiEntry() {
  if (!isWin) return null;
  try {
    const { execSync } = require('child_process');
    const geminiCmd = execSync('where gemini', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    const basedir = path.dirname(geminiCmd);
    const entry = path.join(basedir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    require('fs').accessSync(entry);
    return entry;
  } catch {
    return null;
  }
}

const GEMINI_ENTRY = resolveGeminiEntry();

// Líneas de stderr que gemini CLI imprime en operación normal — no son errores.
const STDERR_NOISE_PATTERNS = [
  /^YOLO mode is enabled/i,
  /^Ripgrep is not available/i,
  /^MCP issues detected/i,
  /^Loaded cached credentials/i,
  /^Data collection/i,
  /^\s*$/,
];

function isNoiseLine(line) {
  return STDERR_NOISE_PATTERNS.some((rx) => rx.test(line));
}

/**
 * Convierte el stderr de gemini -p en un mensaje de error legible.
 * Filtra ruido (YOLO, Ripgrep, MCP) y detecta errores conocidos como quota exhausted.
 */
function summarizeStderr(stderrBuf, exitCode) {
  const cleaned = stderrBuf.replace(/\x1B\[[0-9;]*m/g, '').trim();
  if (!cleaned) return `gemini salió con código ${exitCode}`;

  // Detectar quota exhausted
  const quotaMatch = cleaned.match(/quota will reset after\s+([0-9hms]+)/i);
  if (/QUOTA_EXHAUSTED|TerminalQuotaError|exhausted your capacity/i.test(cleaned)) {
    const reset = quotaMatch ? ` Resetea en ${quotaMatch[1]}.` : '';
    return `Gemini quota agotada para este modelo.${reset} Probá otro modelo (ej: /modelo gemini-2.5-flash) o esperá al reset.`;
  }

  // Detectar 429 / rate limit
  if (/\bcode:\s*429\b|RATE_LIMIT|rate.?limit/i.test(cleaned)) {
    return 'Gemini rate limit. Esperá unos segundos y reintentá.';
  }

  // Detectar fallas de auth
  if (/UNAUTHENTICATED|invalid.?api.?key|401/i.test(cleaned)) {
    return 'Gemini: credenciales inválidas o expiradas. Reautenticá con `gemini` en una terminal.';
  }

  // Modelo no encontrado / no disponible para esta cuenta
  if (/ModelNotFoundError|Requested entity was not found|model.*not.*found|404/i.test(cleaned)) {
    return 'Gemini: el modelo solicitado no existe o no está disponible en tu cuenta. Probá con /modelo gemini-2.5-flash o /modelo gemini-2.5-pro.';
  }

  // Caso genérico: filtrar ruido y devolver primeras líneas significativas
  const lines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l && !isNoiseLine(l));
  if (lines.length === 0) return `gemini salió con código ${exitCode}`;
  const summary = lines.slice(0, 4).join('\n');
  return summary.length > 600 ? summary.slice(0, 600) + '…' : summary;
}

/**
 * GeminiCliSession — modo no-interactivo via `gemini -p`.
 * Análogo a ClaudePrintSession pero para Gemini CLI.
 *
 * Modos:
 *   permissionMode 'auto'  → --yolo
 *   permissionMode 'ask'   → --approval-mode default
 *   permissionMode 'plan'  → --approval-mode plan
 */
class GeminiCliSession {
  constructor({
    model           = null,
    permissionMode  = 'auto',
    cwd             = null,
    geminiSessionId = null,
    messageCount    = 0,
  } = {}) {
    this.id             = crypto.randomUUID();
    this.createdAt      = Date.now();
    this.active         = true;
    this.messageCount   = messageCount;
    this.title          = 'gemini';
    this.model          = model;
    this.permissionMode = permissionMode;
    this.geminiSessionId = geminiSessionId;
    this.cwd            = cwd || process.env.HOME;
    this.totalInputTokens  = 0;
    this.totalOutputTokens = 0;
  }

  async sendMessage(text, onChunk = null, onStatus = null) {
    // En Windows, gemini .ps1 llama a `node gemini.js`. Spawneamos node directamente
    // para evitar problemas de quoting de cmd.exe con textos multilinea.
    // El texto se envía por stdin; -p necesita un valor no-vacío para modo headless.
    let spawnCmd, args, useStdin;
    if (isWin && GEMINI_ENTRY) {
      spawnCmd  = process.execPath;  // node.exe actual
      args      = [GEMINI_ENTRY, '-p', '.', '--output-format', 'stream-json'];
      useStdin  = true;
    } else {
      spawnCmd  = 'gemini';
      args      = ['-p', text, '--output-format', 'stream-json'];
      useStdin  = false;
    }

    // Modo de permisos
    if (this.permissionMode === 'auto') {
      args.push('--yolo');
    } else if (this.permissionMode === 'plan') {
      args.push('--approval-mode', 'plan');
    }
    // 'ask' → approval-mode default (es el comportamiento por omisión, no hace falta flag)

    if (this.model) args.push('--model', this.model);

    // Reanudar sesión previa
    if (this.messageCount > 0 && this.geminiSessionId) {
      args.push('--resume', this.geminiSessionId);
    }

    const emitStatus = (status, detail = null) => {
      if (onStatus) onStatus(status, detail);
    };

    emitStatus('thinking');

    return new Promise((resolve, reject) => {
      const child = spawn(spawnCmd, args, {
        cwd:  this.cwd,
        env:  { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      if (useStdin) {
        child.stdin.write(text);
        child.stdin.end();
      }

      let lineBuffer  = '';
      let stderrBuf   = '';
      let fullText    = '';
      let exited      = false;
      let initSessionId = null;

      const killTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error('Timeout: gemini -p no respondió en 10 min'));
      }, 600000);

      const processLine = (line) => {
        const jsonStr = line.trim();
        // Omitir líneas no-JSON (ej: warnings MCP "MCP issues detected…")
        if (!jsonStr || !jsonStr.startsWith('{')) return;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === 'init') {
            initSessionId = event.session_id || null;
            if (event.model && !this.model) this.model = event.model;
          }
          else if (event.type === 'message' && event.role === 'assistant') {
            const chunk = event.content || '';
            if (event.delta === true) {
              // Chunk incremental de streaming
              fullText += chunk;
              if (onChunk) onChunk(fullText);
            } else if (!fullText && chunk) {
              // Mensaje completo (no-streaming)
              fullText = chunk;
              if (onChunk) onChunk(fullText);
            }
            if (chunk) emitStatus('thinking');
          }
          else if (event.type === 'result') {
            if (initSessionId) this.geminiSessionId = initSessionId;
            const stats = event.stats || {};
            this.totalInputTokens  += stats.input_tokens  || 0;
            this.totalOutputTokens += stats.output_tokens || 0;
            emitStatus('done');
          }
        } catch { /* ignorar líneas no-JSON */ }
      };

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer  = lines.pop();
        for (const line of lines) processLine(line);
      });

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
      });

      child.on('error', (err) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        reject(new Error(`No se pudo ejecutar gemini: ${err.message}`));
      });

      child.on('close', (exitCode) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        if (lineBuffer.trim()) processLine(lineBuffer);
        if (exitCode !== 0 && !fullText) {
          return reject(new Error(summarizeStderr(stderrBuf, exitCode)));
        }
        this.messageCount++;
        resolve({ text: fullText.trim(), usedMcpTools: false });
      });
    });
  }
}

module.exports = GeminiCliSession;
