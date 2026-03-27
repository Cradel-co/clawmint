'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

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
    const args = ['-p', text, '--output-format', 'stream-json'];

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
      const child = spawn('gemini', args, {
        cwd:  this.cwd,
        env:  process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let lineBuffer  = '';
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
          return reject(new Error(`gemini salió con código ${exitCode}`));
        }
        this.messageCount++;
        resolve({ text: fullText.trim(), usedMcpTools: false });
      });
    });
  }
}

module.exports = GeminiCliSession;
