'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CONFIG_FILES } = require('../paths');

const DEFAULT_MCP_CONFIG = CONFIG_FILES.mcpConfig;

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

  /**
   * @param {string} text
   * @param {Function|null} onChunk  — (fullText) => void, stream parcial
   * @param {Function|null} onStatus — (status, detail) => void
   * @param {Function|null} onEvent  — (event) => void, D4: eventos estructurados
   *   {type:'tool_call', name, args?, id?}
   *   {type:'tool_result', name, tool_use_id, content, isError}
   *   {type:'thinking', text}
   *   {type:'usage', promptTokens, completionTokens, costUsd}
   */
  async sendMessage(text, onChunk = null, onStatus = null, onEvent = null) {
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
      // D4 — emit helper para eventos estructurados (tool_call, tool_result, usage, thinking).
      const emitEvent = (ev) => {
        if (onEvent) {
          try { onEvent(ev); } catch { /* no bloquear por caller */ }
        }
      };

      // D4 — buffer de tool_use blocks por index del stream (input se fragmenta como input_json_delta).
      const pendingToolUses = new Map(); // index → {id, name, inputStr}

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

            // Detectar inicio de tool_use para status + buffer input fragmentado
            if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
              const toolName = inner.content_block.name || 'herramienta';
              const toolId = inner.content_block.id || null;
              if (isCommTool(toolName)) usedMcpTools = true;
              cpdbg('event', `#${eventCount} tool_use start: ${toolName} id=${toolId} isCommTool=${isCommTool(toolName)}`);
              emitStatus('tool_use', toolName);
              // D4 — buffer para acumular input JSON fragmentado por delta
              if (inner.index !== undefined) {
                pendingToolUses.set(inner.index, { id: toolId, name: toolName, inputStr: '' });
              }
            }
            // Detectar inicio de bloque de texto
            else if (inner.type === 'content_block_start' && inner.content_block?.type === 'text') {
              emitStatus('thinking');
            }
            // Detectar inicio de thinking block
            else if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
              cpdbg('event', `#${eventCount} thinking start`);
            }
            // Detectar fin de bloque: si es tool_use, parsear input acumulado y emitir evento
            else if (inner.type === 'content_block_stop') {
              cpdbg('event', `#${eventCount} content_block_stop index=${inner.index}`);
              if (inner.index !== undefined && pendingToolUses.has(inner.index)) {
                const pend = pendingToolUses.get(inner.index);
                let args = null;
                try { args = pend.inputStr ? JSON.parse(pend.inputStr) : {}; } catch { args = { _raw: pend.inputStr }; }
                emitEvent({ type: 'tool_call', name: pend.name, id: pend.id, args });
                pendingToolUses.delete(inner.index);
              }
            }

            // Deltas: text, input_json (tool args fragmentados), thinking
            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              fullText += inner.delta.text;
              cpdbg('delta', `#${eventCount} +${inner.delta.text.length}chars total=${fullText.length}`);
              if (onChunk) onChunk(fullText);
            } else if (inner.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta') {
              // D4 — acumular input fragmentado en el buffer del pendingToolUse
              if (inner.index !== undefined && pendingToolUses.has(inner.index)) {
                pendingToolUses.get(inner.index).inputStr += inner.delta.partial_json || '';
              }
            } else if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') {
              // D4 — emitir thinking delta si hay buffer
              emitEvent({ type: 'thinking', text: inner.delta.thinking || '' });
            } else if (inner.type !== 'content_block_delta') {
              cpdbg('event', `#${eventCount} stream_event inner.type=${inner.type}`);
            }

            // D4 — message_delta trae usage + stop_reason
            if (inner.type === 'message_delta' && inner.usage) {
              // Nota: en stream-json del CLI, el usage final llega agregado.
              // Lo emitimos al finalizar en el event 'result' que ya trae cost.
            }
          }
          else if (event.type === 'assistant') {
            const content = event.message?.content;
            const usage = event.message?.usage;
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
              // D4 — si stream_event no emitió tool_calls (versiones viejas del CLI),
              // emitirlos ahora desde el content bundle.
              for (const b of content) {
                if (b.type === 'tool_use' && !pendingToolUses.has(b.index)) {
                  emitEvent({ type: 'tool_call', name: b.name, id: b.id, args: b.input || {} });
                }
              }
            }
            // D4 — emit usage incremental por turn (el CLI agrega por assistant message)
            if (usage) {
              emitEvent({
                type: 'usage',
                promptTokens: usage.input_tokens || 0,
                completionTokens: usage.output_tokens || 0,
                cacheCreation: usage.cache_creation_input_tokens || 0,
                cacheRead: usage.cache_read_input_tokens || 0,
              });
            }
          }
          // D4 — user events traen tool_results tras ejecución del CLI
          else if (event.type === 'user') {
            const content = event.message?.content;
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b.type === 'tool_result') {
                  const preview = typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 500);
                  emitEvent({
                    type: 'tool_result',
                    tool_use_id: b.tool_use_id,
                    content: preview,
                    isError: b.is_error === true,
                  });
                }
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
            // D4 — emit usage agregado al final con cost real
            if (event.usage || event.total_cost_usd != null) {
              emitEvent({
                type: 'usage',
                promptTokens: event.usage?.input_tokens || 0,
                completionTokens: event.usage?.output_tokens || 0,
                cacheCreation: event.usage?.cache_creation_input_tokens || 0,
                cacheRead: event.usage?.cache_read_input_tokens || 0,
                costUsd: this.lastCostUsd || 0,
              });
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
