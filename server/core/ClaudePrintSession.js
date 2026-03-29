'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_MCP_CONFIG = path.join(__dirname, '..', 'mcp-config.json');

function _cpDbg() { return process.env.DEBUG_TELEGRAM === '1'; }
function cpdbg(scope, ...args) { if (_cpDbg()) console.log(`[CPS:DBG:${scope}]`, ...args); }

/**
 * ClaudePrintSession — modo no-interactivo via `claude -p`.
 * Extraído de telegram.js para reutilización por cualquier canal (Telegram, Discord, HTTP).
 */
class ClaudePrintSession {
  constructor({ model = null, permissionMode = 'ask', cwd = null, claudeSessionId = null, messageCount = 0, mcpConfig = null, appendSystemPrompt = null } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = Date.now();
    this.active = true;
    this.messageCount = messageCount;
    this.title = 'claude';
    this.model = model;                    // modelo explícito (null = default)
    this.permissionMode = permissionMode;  // 'auto' | 'ask' | 'plan'
    this.totalCostUsd = 0;        // costo acumulado de la sesión
    this.lastCostUsd = 0;         // costo del último mensaje
    this.claudeSessionId = claudeSessionId;  // session_id interno de claude (persistible)
    this.cwd = cwd || process.env.HOME;  // directorio de trabajo de la sesión
    this.mcpConfig = mcpConfig || DEFAULT_MCP_CONFIG;  // ruta a mcp-config.json
    this.appendSystemPrompt = appendSystemPrompt || null;  // prompt adicional de sistema
  }

  async sendMessage(text, onChunk = null, onStatus = null) {
    const isWin = process.platform === 'win32';
    // En Windows: texto por stdin (cmd.exe rompe args largos con saltos de línea)
    // En Linux:   texto como argumento -p (comportamiento original, probado)
    const claudeArgs = isWin
      ? ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
      : ['-p', text, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

    if (this.permissionMode === 'auto') {
      claudeArgs.unshift('--dangerously-skip-permissions');
    } else {
      const modeMap = { ask: 'default', plan: 'plan' };
      claudeArgs.unshift('--permission-mode', modeMap[this.permissionMode] || 'default');
    }
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.mcpConfig && fs.existsSync(this.mcpConfig)) claudeArgs.push('--mcp-config', this.mcpConfig);
    if (this.appendSystemPrompt) claudeArgs.push('--append-system-prompt', this.appendSystemPrompt);
    if (this.messageCount > 0 && this.claudeSessionId) {
      claudeArgs.push('--resume', this.claudeSessionId);
    } else if (this.messageCount > 0) {
      claudeArgs.push('--continue');
    }

    cpdbg('spawn', `args=[${claudeArgs.join(' ')}] mode=${this.permissionMode} model=${this.model} msgCount=${this.messageCount}`);
    cpdbg('spawn', `text="${text.slice(0, 120)}${text.length > 120 ? '...' : ''}" (${text.length} chars ${isWin ? 'via stdin' : 'via arg'})`);

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const child = spawn('claude', claudeArgs, {
        cwd: this.cwd,
        env,
        stdio: [isWin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: isWin,
        windowsHide: true,
      });

      // En Windows: enviar prompt por stdin y cerrar
      if (isWin) {
        child.stdin.write(text);
        child.stdin.end();
      }

      cpdbg('spawn', `PID=${child.pid || 'unknown'}${isWin ? ' stdin written' : ''}`);

      let stderrData = '';
      if (child.stderr) {
        child.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });
      }

      let lineBuffer = '';
      let fullText = '';
      let killed = false;
      let exited = false;
      let eventCount = 0;
      let usedMcpTools = false;
      const COMM_TOOLS = [
        'telegram_send_message', 'telegram_send_photo', 'telegram_send_document',
        'telegram_send_voice', 'telegram_send_video', 'telegram_edit_message',
        'webchat_send_message', 'webchat_send_photo', 'webchat_send_document',
        'webchat_send_voice', 'webchat_send_video', 'webchat_edit_message',
      ];
      // MCP tools llegan prefijadas (ej: mcp__clawmint__telegram_send_message)
      const isCommTool = (name) => COMM_TOOLS.some(t => name === t || name.endsWith('__' + t));

      const emitStatus = (status, detail = null) => {
        if (onStatus) onStatus(status, detail);
      };

      emitStatus('thinking');

      const killTimer = setTimeout(() => {
        killed = true;
        cpdbg('timeout', '18min timeout — killing');
        try { child.kill('SIGTERM'); } catch {}
      }, 1080000);

      const processLine = (line) => {
        const jsonStr = line.trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        try {
          const event = JSON.parse(jsonStr);
          eventCount++;

          if (event.type === 'stream_event' && event.event) {
            const raw = event.event;
            const inner = typeof raw === 'string' ? JSON.parse(raw) : raw;

            // Detectar inicio de tool_use para status
            if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
              const toolName = inner.content_block.name || 'herramienta';
              if (isCommTool(toolName)) usedMcpTools = true;
              cpdbg('event', `#${eventCount} tool_use start: ${toolName} isCommTool=${isCommTool(toolName)}`);
              emitStatus('tool_use', toolName);
            }
            // Detectar inicio de bloque de texto
            else if (inner.type === 'content_block_start' && inner.content_block?.type === 'text') {
              emitStatus('thinking');
            }
            // Detectar fin de tool_use
            else if (inner.type === 'content_block_stop') {
              cpdbg('event', `#${eventCount} content_block_stop`);
            }

            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              fullText += inner.delta.text;
              cpdbg('delta', `#${eventCount} +${inner.delta.text.length}chars total=${fullText.length}`);
              if (onChunk) onChunk(fullText);
            } else {
              cpdbg('event', `#${eventCount} stream_event inner.type=${inner.type}`);
            }
          }
          else if (event.type === 'assistant') {
            const content = event.message?.content;
            cpdbg('event', `#${eventCount} assistant content=${Array.isArray(content) ? content.length + ' blocks' : 'none'} fullText=${fullText.length}`);
            if (Array.isArray(content)) {
              // Detectar tool_use de telegram en bloques de assistant
              const hasTelegramTool = content.some(b => b.type === 'tool_use' && isCommTool(b.name));
              if (hasTelegramTool) usedMcpTools = true;

              const textBlock = content.find(b => b.type === 'text');
              if (textBlock?.text && !fullText) {
                fullText = textBlock.text;
                cpdbg('event', `#${eventCount} assistant fallback text=${fullText.length} chars`);
                if (onChunk) onChunk(fullText);
              }
            }
          }
          else if (event.type === 'system') {
            cpdbg('event', `#${eventCount} system model=${event.model} cwd=${event.cwd}`);
            if (event.model) this.model = this.model || event.model;
            if (event.cwd) this.cwd = event.cwd;
          }
          else if (event.type === 'result') {
            cpdbg('event', `#${eventCount} result len=${(event.result||'').length} session=${event.session_id} cost=${event.total_cost_usd} fullText=${fullText.length}`);
            if (event.result && !fullText) fullText = event.result;
            if (event.session_id) this.claudeSessionId = event.session_id;
            if (event.cwd) this.cwd = event.cwd;
            if (event.total_cost_usd != null) {
              this.lastCostUsd = event.total_cost_usd - this.totalCostUsd;
              this.totalCostUsd = event.total_cost_usd;
            }
            emitStatus('done');
          } else {
            cpdbg('event', `#${eventCount} type=${event.type}`);
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
        cpdbg('error', `spawn error: ${err.message}`);
        reject(new Error(`No se pudo ejecutar claude: ${err.message}`));
      });

      child.on('close', (exitCode) => {
        if (exited) return;
        exited = true;
        clearTimeout(killTimer);
        if (lineBuffer.trim()) processLine(lineBuffer);
        cpdbg('close', `exitCode=${exitCode} killed=${killed} fullText=${fullText.length} events=${eventCount}`);
        if (killed) return reject(new Error('Timeout: claude -p no respondió en 18 min'));
        if (exitCode !== 0 && !fullText) {
          const stderrMsg = stderrData.trim().split('\n').pop() || '';
          console.error(`[ClaudePrintSession] exitCode: ${exitCode}${stderrMsg ? ' stderr: ' + stderrMsg : ''}`);
          return reject(new Error(`claude salió con código ${exitCode}${stderrMsg ? ': ' + stderrMsg : ''}`));
        }
        this.messageCount++;
        cpdbg('close', `OK msgCount=${this.messageCount} text="${fullText.slice(0, 100)}" usedMcpTools=${usedMcpTools}`);
        resolve({ text: fullText.trim(), usedMcpTools });
      });
    });
  }
}

module.exports = ClaudePrintSession;
