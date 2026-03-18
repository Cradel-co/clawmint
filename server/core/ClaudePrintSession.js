'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

/**
 * ClaudePrintSession — modo no-interactivo via `claude -p`.
 * Extraído de telegram.js para reutilización por cualquier canal (Telegram, Discord, HTTP).
 */
class ClaudePrintSession {
  constructor({ model = null, permissionMode = 'ask' } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = 0;
    this.title = 'claude';
    this.model = model;                    // modelo explícito (null = default)
    this.permissionMode = permissionMode;  // 'auto' | 'ask' | 'plan'
    this.totalCostUsd = 0;        // costo acumulado de la sesión
    this.lastCostUsd = 0;         // costo del último mensaje
    this.claudeSessionId = null;  // session_id interno de claude
    this.cwd = process.env.HOME;  // directorio de trabajo de la sesión
  }

  async sendMessage(text, onChunk = null) {
    const claudeArgs = [
      '-p', text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this.permissionMode === 'auto') {
      claudeArgs.unshift('--dangerously-skip-permissions');
    } else {
      const modeMap = { ask: 'default', plan: 'plan' };
      claudeArgs.unshift('--permission-mode', modeMap[this.permissionMode] || 'default');
    }
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.messageCount > 0) claudeArgs.push('--continue');

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      // Usar spawn con stdin: 'ignore' para evitar hang y crash de node-pty en WSL2
      const child = spawn('claude', claudeArgs, {
        cwd: process.env.HOME,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      });

      let lineBuffer = '';
      let fullText = '';
      let killed = false;
      let exited = false;

      const killTimer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGTERM'); } catch {}
      }, 1080000); // 18 minutos

      const processLine = (line) => {
        const jsonStr = line.trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        try {
          const event = JSON.parse(jsonStr);

          // stream_event envuelve los eventos reales de la API (content_block_delta, etc.)
          if (event.type === 'stream_event' && event.event) {
            const raw = event.event;
            const inner = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              fullText += inner.delta.text;
              if (onChunk) onChunk(fullText);
            }
          }
          // assistant event con texto acumulado (fallback solo si streaming no dio nada)
          else if (event.type === 'assistant') {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              const textBlock = content.find(b => b.type === 'text');
              // Solo usar si los deltas no produjeron nada (evita mezclar turnos anteriores)
              if (textBlock?.text && !fullText) {
                fullText = textBlock.text;
                if (onChunk) onChunk(fullText);
              }
            }
          }
          // system event: capturar modelo activo y cwd
          else if (event.type === 'system') {
            if (event.model) this.model = this.model || event.model;
            if (event.cwd) this.cwd = event.cwd;
          }
          // result event: texto final definitivo + metadatos
          else if (event.type === 'result') {
            // Solo usar como fallback; el streaming acumulado es más confiable
            if (event.result && !fullText) fullText = event.result;
            if (event.session_id) this.claudeSessionId = event.session_id;
            if (event.cwd) this.cwd = event.cwd;
            if (event.total_cost_usd != null) {
              this.lastCostUsd = event.total_cost_usd - this.totalCostUsd;
              this.totalCostUsd = event.total_cost_usd;
            }
          }
        } catch { /* ignorar líneas no-JSON */ }
      };

      child.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) processLine(line);
      });

      child.on('error', (err) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        reject(new Error(`No se pudo ejecutar claude: ${err.message}`));
      });

      child.on('close', (exitCode) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        // Procesar cualquier dato residual en el buffer
        if (lineBuffer.trim()) processLine(lineBuffer);
        if (killed) return reject(new Error('Timeout: claude -p no respondió en 18 min'));
        if (exitCode !== 0 && !fullText) {
          console.error('[ClaudePrintSession] exitCode:', exitCode);
          return reject(new Error(`claude salió con código ${exitCode}`));
        }
        this.messageCount++;
        resolve(fullText.trim());
      });
    });
  }
}

module.exports = ClaudePrintSession;
