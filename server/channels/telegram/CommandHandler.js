'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ClaudePrintSession   = require('../../core/ClaudePrintSession');
const { getSystemStats }   = require('../../core/systemStats');

/**
 * CommandHandler — maneja todos los comandos `/cmd` de Telegram.
 *
 * Deps inyectadas (todas opcionales salvo agents, skills):
 *   agents, skills, memory, reminders, mcps, consolidator,
 *   sessionManager, providers, providerConfig, logger
 */
class CommandHandler {
  constructor({
    agents,
    skills,
    memory       = null,
    reminders    = null,
    mcps         = null,
    consolidator = null,
    sessionManager = null,
    providers    = null,
    providerConfig = null,
    transcriber  = null,
    chatSettings = null,
    logger       = console,
  }) {
    this.agents        = agents;
    this.skills        = skills;
    this.memory        = memory;
    this.reminders     = reminders;
    this.mcps          = mcps;
    this.consolidator  = consolidator;
    this.sessionManager = sessionManager;
    this.providers     = providers;
    this.providerConfig = providerConfig;
    this.transcriber   = transcriber;
    this.chatSettings  = chatSettings;
    this.logger        = logger;
  }

  _persistCwd(botKey, chatId, cwd) {
    if (this.chatSettings) this.chatSettings.saveCwd(String(botKey), String(chatId), cwd);
  }

  _getSystemStats() { return getSystemStats(); }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  _buildLsText(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines   = entries.map(e => {
      const name = e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`;
      try {
        const stat = fs.statSync(path.join(dir, e.name));
        const size = e.isDirectory() ? '' : ` (${this._formatBytes(stat.size)})`;
        return `${name}${size}`;
      } catch { return name; }
    });
    return `📁 *${dir.replace(process.env.HOME, '~')}*\n\n${lines.join('\n') || '_vacío_'}`;
  }

  _buildWhisperUI() {
    const { getConfig, VALID_MODELS, VALID_LANGUAGES } = this.transcriber;
    const cfg = getConfig();
    const currentModel = cfg.model.replace('Xenova/whisper-', '');
    const currentLang  = cfg.language;

    const text =
      `🎙️ *Whisper — Transcripción de audio*\n\n` +
      `• Modelo: \`${currentModel}\`\n` +
      `• Idioma: \`${currentLang}\`\n\n` +
      `Modelos: ${VALID_MODELS.map(m => `\`${m}\``).join(', ')}`;

    const modelButtons = VALID_MODELS.map(m => ({
      text: m === currentModel ? `✓ ${m}` : m,
      callback_data: `whisper:${m}`,
    }));

    const langRows = [];
    for (let i = 0; i < VALID_LANGUAGES.length; i += 5) {
      langRows.push(VALID_LANGUAGES.slice(i, i + 5).map(l => ({
        text: l === currentLang ? `✓ ${l}` : l,
        callback_data: `whisperlang:${l}`,
      })));
    }

    return { text, buttons: [modelButtons, ...langRows] };
  }

  /**
   * Punto de entrada principal.
   * @param {object} bot  - instancia de TelegramBot
   * @param {object} msg  - mensaje de Telegram
   * @param {string} cmd  - comando sin /
   * @param {string[]} args - argumentos
   * @param {object} chat - estado del chat
   */
  async handle(bot, msg, cmd, args, chat) {
    const chatId = msg.chat.id;

    switch (cmd) {

      // ── Sesión ────────────────────────────────────────────────────────────
      case 'start': {
        const name = chat.firstName || 'usuario';
        if (!bot._isClaudeBased()) await bot.getOrCreateSession(chatId, chat);
        await bot.sendText(chatId, `Hola ${name}! 👋 Soy @${bot.botInfo?.username}.`);
        await bot._sendMenu(chatId);
        break;
      }

      case 'nueva':
      case 'reset':
      case 'clear': {
        if (bot._isClaudeBased()) {
          chat.claudeSession = new ClaudePrintSession(bot._claudeSessionOpts(chat));
          await bot.sendWithButtons(chatId,
            `✅ Nueva conversación *${bot.defaultAgent}* iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        } else {
          const s = await bot.getOrCreateSession(chatId, chat, true);
          await bot.sendWithButtons(chatId,
            `✅ Nueva sesión *${s.title}* creada (\`${s.id.slice(0,8)}…\`)`,
            [[{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        }
        break;
      }

      case 'compact': {
        const compactAgentKey = chat.activeAgent?.key || bot.defaultAgent;

        if (args.length > 0) {
          const topicRaw = args.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');
          if (!topicRaw) { await bot.sendText(chatId, '❌ Nombre de tópico inválido.'); break; }

          if (this.memory) {
            const prefs  = this.memory.getPreferences(compactAgentKey);
            const exists = (prefs.topics || []).some(t => t.name.toLowerCase() === topicRaw);
            if (exists) {
              await bot.sendText(chatId, `ℹ️ El tópico *${topicRaw.replace(/_/g, ' ')}* ya está en las preferencias.`);
            } else {
              await bot.sendWithButtons(chatId,
                `💡 El tópico *${topicRaw.replace(/_/g, ' ')}* no está en las preferencias de \`${compactAgentKey}\`.\n\n¿Agregar y memorizar?`,
                [[
                  { text: '✅ Sí, agregar y memorizar', callback_data: `topic:add:${topicRaw}:${compactAgentKey}` },
                  { text: '❌ Solo memorizar',          callback_data: 'compact_action' },
                  { text: '⏭️ Cancelar',               callback_data: 'noop' },
                ]]
              );
            }
          }
          break;
        }

        const queueStats = this.consolidator ? this.consolidator.getStats(compactAgentKey) : null;
        const statsText = queueStats
          ? `\n📊 *Cola de consolidación* (\`${compactAgentKey}\`):\n` +
            `• Pendientes: ${queueStats.pending}\n` +
            `• Procesados: ${queueStats.done}\n` +
            `• Errores: ${queueStats.error}`
          : '';

        if (bot._isClaudeBased() && chat.claudeSession) {
          await bot.sendWithButtons(chatId,
            `🗜️ *Compact*${statsText}\n\n¿Qué querés hacer?`,
            [[
              { text: '🗜️ /compact Claude Code', callback_data: 'compact_action' },
              ...(this.consolidator && (queueStats?.pending || 0) > 0
                ? [{ text: `⚡ Procesar ${queueStats.pending} pending`, callback_data: 'consolidate_now' }]
                : []),
            ]]
          );
        } else {
          if (!statsText) { await bot.sendText(chatId, '❌ Sin sesión Claude activa.'); break; }
          await bot.sendWithButtons(chatId,
            `📊 *Estado de memoria*${statsText}`,
            [[
              ...(this.consolidator && (queueStats?.pending || 0) > 0
                ? [{ text: `⚡ Procesar ${queueStats.pending} pending`, callback_data: 'consolidate_now' }]
                : []),
              { text: '📝 Ver notas', callback_data: 'mem:notas' },
            ]]
          );
        }
        break;
      }

      case 'bash': {
        const s = await bot.getOrCreateSession(chatId, chat, true, 'bash');
        await bot.sendText(chatId, `✅ Sesión *bash* creada (\`${s.id.slice(0,8)}…\`)`);
        break;
      }

      // ── Modelo ────────────────────────────────────────────────────────────
      case 'modelo':
      case 'model': {
        if (!bot._isClaudeBased()) {
          await bot.sendText(chatId, '❌ Solo disponible en agentes Claude.');
          return;
        }
        if (args.length === 0) {
          const modelo = chat.claudeSession?.model || '(default)';
          await bot.sendText(chatId,
            `🧠 *Modelo actual*: \`${modelo}\`\n\n` +
            `Modelos disponibles:\n` +
            `• \`claude-opus-4-6\` — más potente\n` +
            `• \`claude-sonnet-4-6\` — balanceado (default)\n` +
            `• \`claude-haiku-4-5-20251001\` — más rápido\n\n` +
            `Usá /modelo <nombre> para cambiar.\n_Nota: crea nueva sesión._`
          );
        } else {
          const nuevoModelo = args[0];
          chat.claudeSession = new ClaudePrintSession({ ...bot._claudeSessionOpts(chat), model: nuevoModelo });
          await bot.sendText(chatId, `✅ Modelo cambiado a \`${nuevoModelo}\`\nNueva sesión iniciada (\`${chat.claudeSession.id.slice(0,8)}…\`).`);
        }
        break;
      }

      // ── Costo ─────────────────────────────────────────────────────────────
      case 'costo':
      case 'cost': {
        if (!bot._isClaudeBased() || !chat.claudeSession) {
          await bot.sendText(chatId, '❌ Sin sesión Claude activa.');
          return;
        }
        const cs = chat.claudeSession;
        const total  = cs.totalCostUsd.toFixed(4);
        const ultimo = cs.lastCostUsd.toFixed(4);
        await bot.sendText(chatId,
          `💰 *Costo de sesión*\n\n` +
          `Último mensaje: $${ultimo} USD\n` +
          `Total sesión: $${total} USD\n` +
          `Mensajes: ${cs.messageCount}`
        );
        break;
      }

      // ── Estado ────────────────────────────────────────────────────────────
      case 'estado':
      case 'status':
      case 'sesion': {
        if (bot._isClaudeBased()) {
          if (!chat.claudeSession) {
            await bot.sendText(chatId, `❌ Sin sesión *${bot.defaultAgent}* activa. Enviá un mensaje para iniciar una.`);
            return;
          }
          const cs = chat.claudeSession;
          const uptime = Math.round((Date.now() - cs.createdAt) / 1000);
          await bot.sendText(chatId,
            `📊 *Estado de sesión*\n\n` +
            `ID: \`${cs.id.slice(0,8)}…\`\n` +
            `Agente: ${bot.defaultAgent}\n` +
            `Agente activo: ${chat.activeAgent?.key || 'ninguno'}\n` +
            `Modelo: \`${cs.model || 'default'}\`\n` +
            `Modo permisos: \`${chat.claudeMode || 'ask'}\`\n` +
            `Mensajes: ${cs.messageCount}\n` +
            `Uptime: ${Math.floor(uptime/60)}m ${uptime%60}s\n` +
            `Costo total: $${cs.totalCostUsd.toFixed(4)} USD\n` +
            `Session ID Claude: \`${cs.claudeSessionId ? cs.claudeSessionId.slice(0,12) + '…' : 'pendiente'}\``
          );
          return;
        }
        if (!chat.sessionId) {
          await bot.sendText(chatId, '❌ Sin sesión activa. Usá /start para crear una.');
          return;
        }
        const session = this.sessionManager?.get(chat.sessionId);
        if (!session) {
          chat.sessionId = null;
          await bot.sendText(chatId, '❌ La sesión expiró. Usá /start para crear una nueva.');
          return;
        }
        const uptime2 = Math.round((Date.now() - session.createdAt) / 1000);
        await bot.sendText(chatId,
          `📊 *Sesión actual*\nID: \`${session.id.slice(0,8)}…\`\nAgente: ${session.title}\n` +
          `Activa: ${session.active ? 'Sí' : 'No'}\nUptime: ${Math.floor(uptime2/60)}m ${uptime2%60}s`
        );
        break;
      }

      // ── Memoria ───────────────────────────────────────────────────────────
      case 'mem':
      case 'memoria':
      case 'memory': {
        if (!this.memory) { await bot.sendText(chatId, '❌ Módulo de memoria no disponible.'); break; }
        const memAgentKey = chat.activeAgent?.key || bot.defaultAgent;
        const sub = args[0]?.toLowerCase();

        if (sub === 'test' && args.length > 1) {
          const testText = args.slice(1).join(' ');
          const { maxWeight, signals: sigs, shouldNudge: sn } = this.memory.detectSignals(memAgentKey, testText);
          if (!sigs.length) {
            await bot.sendText(chatId,
              `🔍 *Test de señales*\n\nTexto: _"${testText}"_\n\n` +
              `No se detectaron señales. El LLM decidirá por sí mismo si guardar.`
            );
          } else {
            const lines = sigs.map(s =>
              `• \`${s.type}\` (peso ${s.weight}/10) — _${s.description || '—'}_`
            );
            await bot.sendText(chatId,
              `🔍 *Test de señales*\n\nTexto: _"${testText}"_\n\n` +
              `${lines.join('\n')}\n\n` +
              `Peso máximo: ${maxWeight}/10\n` +
              `Nudge automático: ${sn ? '✅ activo' : '❌ bajo umbral (< nudgeMinWeight)'}`
            );
          }
          break;
        }

        if (sub === 'ver' || sub === 'config') {
          const prefs  = this.memory.getPreferences(memAgentKey);
          const active = prefs.signals.filter(s => s.enabled !== false);
          const sigLines = active.map(s =>
            `• \`${s.type}\` (${s.weight}/10): _${s.description || s.pattern.slice(0, 50)}_`
          );
          const hasAgentPrefs = fs.existsSync(
            path.join(this.memory.MEMORY_DIR, memAgentKey, 'preferences.json')
          );
          await bot.sendText(chatId,
            `⚙️ *Preferencias de memoria* — agente \`${memAgentKey}\`\n` +
            `_${hasAgentPrefs ? 'Config personalizada' : 'Usando defaults globales'}_\n\n` +
            `*Señales activas (${active.length}):*\n${sigLines.join('\n')}\n\n` +
            `*Config:*\n` +
            `• Nudge: ${prefs.settings.nudgeEnabled !== false ? '✅' : '❌'} ` +
            `(umbral ≥${prefs.settings.nudgeMinWeight ?? 7}/10)\n` +
            `• Token budget: ${prefs.settings.tokenBudget || 800}\n` +
            `• Fallback top-N: ${prefs.settings.fallbackTopN || 3} notas\n\n` +
            `_El agente puede actualizar con \`<save_memory file="preferences.json">\`_`
          );
          break;
        }

        if (sub === 'reset') {
          const ok = this.memory.resetPreferences(memAgentKey);
          await bot.sendText(chatId,
            ok
              ? `✅ Preferencias de \`${memAgentKey}\` reiniciadas a valores globales.`
              : `ℹ️ \`${memAgentKey}\` ya usa los valores globales.`
          );
          break;
        }

        if (sub === 'notas' || sub === 'ls') {
          const graph = this.memory.buildGraph(memAgentKey);
          if (!graph.nodes.length) {
            await bot.sendText(chatId, `📭 Sin notas indexadas para \`${memAgentKey}\`.`);
          } else {
            const lines = graph.nodes
              .sort((a, b) => b.accessCount - a.accessCount)
              .map(n =>
                `• \`${n.filename}\` — _${n.title}_ ` +
                `[${n.tags.join(', ') || '—'}] imp:${n.importance} acc:${n.accessCount}`
              );
            await bot.sendText(chatId,
              `📝 *Notas* — \`${memAgentKey}\`\n\n${lines.join('\n')}`
            );
          }
          break;
        }

        // Default: panel de estadísticas
        const graph   = this.memory.buildGraph(memAgentKey);
        const notes   = graph.nodes;
        const pending = this.consolidator ? (this.consolidator.getStats(memAgentKey)?.pending || 0) : 0;
        const allTags = [...new Set(notes.flatMap(n => n.tags))];
        const topNotes = [...notes]
          .sort((a, b) => b.accessCount - a.accessCount)
          .slice(0, 3)
          .map(n => `• _"${n.title}"_ [${n.tags.slice(0,2).join(', ')||'—'}] acc:${n.accessCount}`)
          .join('\n') || '_ninguna_';

        await bot.sendWithButtons(chatId,
          `🧠 *Memoria* — agente \`${memAgentKey}\`\n\n` +
          `📝 Notas indexadas: *${notes.length}*\n` +
          `🔗 Conexiones: *${graph.links.length}* ` +
          `(${graph.links.filter(l => l.type === 'learned').length} aprendidas)\n` +
          `🏷️ Tags únicos: *${allTags.length}*\n` +
          `⏳ Pendientes de guardar: *${pending}*\n\n` +
          `*Top accedidas:*\n${topNotes}\n\n` +
          `_/mem test <texto>_ · _/mem ver_ · _/mem notas_ · _/mem reset_`,
          [[
            { text: '🔍 Test señales', callback_data: 'mem:test' },
            { text: '⚙️ Config',       callback_data: 'mem:ver'  },
          ], [
            { text: '📝 Notas',        callback_data: 'mem:notas' },
            { text: '🔄 Reset config', callback_data: 'mem:reset' },
          ]]
        );
        break;
      }

      // ── Directorio ────────────────────────────────────────────────────────
      case 'cd': {
        const target = args.join(' ').trim() || process.env.HOME;
        const resolved = target === '~' ? process.env.HOME
          : target.startsWith('/') ? target
          : path.resolve(chat.monitorCwd || process.env.HOME, target);
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) throw new Error('no es un directorio');
          chat.monitorCwd = resolved;
          this._persistCwd(bot.key, chatId, resolved);
          const short = resolved.replace(process.env.HOME, '~');
          await bot.sendText(chatId, `📁 Directorio cambiado a \`${short}\``);
        } catch (err) {
          await bot.sendText(chatId, `❌ cd: ${err.message}`);
        }
        break;
      }

      case 'dir':
      case 'pwd':
      case 'cwd':
      case 'directorio': {
        const monitorCwd = chat.monitorCwd || process.env.HOME;
        const short = monitorCwd.replace(process.env.HOME, '~');
        let lines = `📁 *Directorio de trabajo*: \`${short}\``;
        if (bot._isClaudeBased() && chat.claudeSession && chat.claudeSession.cwd !== monitorCwd) {
          const sesShort = chat.claudeSession.cwd.replace(process.env.HOME, '~');
          lines += `\n⚠️ Sesión Claude usa \`${sesShort}\` (se actualizará al resetear)`;
        }
        await bot.sendText(chatId, lines);
        break;
      }

      // ── Agentes con prompt (roles) ────────────────────────────────────────
      case 'agentes': {
        const roleAgents = this.agents.list().filter(a => a.prompt);
        if (roleAgents.length === 0) {
          await bot.sendText(chatId,
            `🎭 *Agentes de rol disponibles*\n\n` +
            `No hay agentes con prompt configurado.\n` +
            `Creá uno desde el panel web (botón 🎭) y usalo aquí.`
          );
        } else {
          const lines = roleAgents.map(a =>
            `• /${a.key} — ${a.description || a.key}` +
            (a.prompt ? `\n  _"${a.prompt.slice(0, 60)}${a.prompt.length > 60 ? '…' : ''}"_` : '')
          ).join('\n');
          const agentButtons = roleAgents.map(a => [{ text: `🎭 ${a.key}`, callback_data: `agent:${a.key}` }]);
          await bot.sendWithButtons(chatId,
            `🎭 *Agentes de rol disponibles*\n\n${lines}\n\nActivá un agente tocando el botón:`,
            agentButtons
          );
        }
        break;
      }

      case 'basta': {
        const prevKey = chat.activeAgent?.key;
        chat.activeAgent = null;
        chat.claudeSession = new ClaudePrintSession({ ...bot._claudeSessionOpts(chat), model: null });
        await bot.sendText(chatId, prevKey
          ? `✅ Agente *${prevKey}* desactivado. Claude normal restaurado.`
          : 'No había agente activo.');
        break;
      }

      case 'agente': {
        if (args.length === 0) {
          const available = this.agents.list().map(a => `• ${a.key} — ${a.description || a.command || 'bash'}`).join('\n');
          await bot.sendText(chatId,
            `⚙️ *Agente actual*: ${bot.defaultAgent}\n\n*Disponibles:*\n${available}\n\n` +
            `Usá /agente <key> para cambiar.`
          );
        } else {
          const agentKey = args[0].toLowerCase();
          const agent = this.agents.get(agentKey);
          if (!agent) {
            await bot.sendText(chatId, `❌ Agente "${agentKey}" no encontrado. Usá /agente para ver la lista.`);
          } else {
            bot.defaultAgent = agentKey;
            await bot.sendText(chatId, `✅ Agente cambiado a *${agentKey}* (${agent.description || agent.command || 'bash'})`);
          }
        }
        break;
      }

      // ── Ayuda ─────────────────────────────────────────────────────────────
      case 'ayuda':
      case 'help':
        await bot.sendText(chatId,
          `🤖 *Comandos disponibles*\n\n` +
          `*Sesión:*\n` +
          `/start — saludo e inicio\n` +
          `/nueva — nueva conversación\n` +
          `/reset — reiniciar sesión\n` +
          `/compact — compactar contexto\n` +
          `/bash — nueva sesión bash\n\n` +
          `*Claude Code:*\n` +
          `/modo [ask|auto|plan] — ver/cambiar modo de permisos\n` +
          `/modelo [nombre] — ver/cambiar modelo\n` +
          `/costo — costo de la sesión\n` +
          `/estado — estado detallado\n` +
          `/memoria — ver archivos de memoria\n` +
          `/dir — directorio de trabajo (alias: /pwd)\n\n` +
          `*Agentes de rol:*\n` +
          `/agentes — listar agentes con prompt\n` +
          `/<key> — activar agente de rol\n` +
          `/basta — desactivar agente de rol\n\n` +
          `*Skills:*\n` +
          `/skills — ver skills instalados\n` +
          `/buscar-skill — buscar e instalar skills de ClawHub\n` +
          `/mcps — ver MCPs configurados\n` +
          `/buscar-mcp [query] — buscar e instalar MCPs de Smithery\n\n` +
          `*Recordatorios:*\n` +
          `/recordar <tiempo> <msg> — crear alarma\n` +
          `/recordatorios — ver pendientes\n\n` +
          `*Monitor:*\n` +
          `/consola — modo consola (toggle)\n` +
          `/status-vps — CPU, RAM y disco\n\n` +
          `*Audio:*\n` +
          `/whisper [modelo|idioma] — ver/cambiar modelo Whisper\n` +
          `🎙️ Enviá un audio de voz y se transcribe automáticamente\n\n` +
          `*Bot:*\n` +
          `/agente [key] — ver/cambiar agente\n` +
          `/provider [nombre] — ver/cambiar provider de IA\n` +
          `/ayuda — esta ayuda`
        );
        break;

      case 'buscar-skill': {
        chat.pendingAction = { type: 'skill-search' };
        await bot.sendText(chatId,
          '🔍 *Buscar skill en ClawHub*\n\n' +
          '¿Para qué necesitás el skill? Describí tu necesidad en pocas palabras.\n' +
          '_Ejemplos: "crear PDFs", "buscar en Google", "enviar emails"_\n\n' +
          'Usá /cancelar para cancelar.'
        );
        break;
      }

      // ── MCPs ──────────────────────────────────────────────────────────────
      case 'mcps': {
        if (!this.mcps) { await bot.sendText(chatId, '❌ Módulo MCPs no disponible.'); break; }
        const mcpList = this.mcps.list();
        if (!mcpList.length) {
          await bot.sendText(chatId, '🔌 *MCPs configurados*\n\nNo hay MCPs configurados.\nUsá /buscar-mcp para buscar en el registry.');
          break;
        }
        const mcpLines = mcpList.map(m =>
          `• \`${m.name}\` — ${m.type === 'http' ? '🌐' : '📦'} ${m.description ? m.description.slice(0, 60) : m.command || m.url || ''} ${m.enabled ? '✅' : '⏸'}`
        ).join('\n');
        await bot.sendText(chatId, `🔌 *MCPs configurados* (${mcpList.length})\n\n${mcpLines}`);
        break;
      }

      case 'buscar-mcp': {
        if (!this.mcps) { await bot.sendText(chatId, '❌ Módulo MCPs no disponible.'); break; }
        if (args.length > 0) {
          const query = args.join(' ');
          await bot.sendText(chatId, `🔍 Buscando MCPs para "${query}"...`);
          try {
            const results = await this.mcps.searchSmithery(query);
            if (!results.length) {
              await bot.sendText(chatId, `😕 No encontré MCPs para "${query}".\n\nProbá con otras palabras o visitá smithery.ai`);
              break;
            }
            const lines = results.map((r, i) =>
              `${i + 1}. \`${r.qualifiedName}\` — *${r.displayName}*\n   _${r.description.slice(0, 80)}_\n   ${r.remote ? '🌐 HTTP' : '📦 local'}`
            ).join('\n\n');
            await bot.sendText(chatId,
              `🔍 *Encontré ${results.length} MCP(s) para "${query}":*\n\n${lines}\n\n` +
              `Respondé con el *número* para instalar, o /cancelar.`
            );
            chat.pendingAction = { type: 'mcp-select', results };
          } catch (err) {
            await bot.sendText(chatId, `⚠️ Error buscando en Smithery: ${err.message}`);
          }
        } else {
          chat.pendingAction = { type: 'mcp-search' };
          await bot.sendText(chatId,
            '🔌 *Buscar MCP en Smithery Registry*\n\n' +
            '¿Qué tipo de MCP necesitás? Describí la integración en pocas palabras.\n' +
            '_Ejemplos: "github", "base de datos postgres", "búsqueda web", "memoria"_\n\n' +
            'Usá /cancelar para cancelar.'
          );
        }
        break;
      }

      case 'consola': {
        if (chat.consoleMode) {
          chat.consoleMode = false;
          await bot.sendWithButtons(chatId, '🖥️ Modo consola *desactivado*.',
            [[{ text: '🖥️ Monitor', callback_data: 'menu:monitor' },
              { text: '🤖 Menú',    callback_data: 'menu' }]]);
        } else {
          chat.consoleMode = true;
          await bot._sendConsolePrompt(chatId,
            `🖥️ *Modo consola activado*\n\nEscribí comandos directamente.\n\`exit\` o /consola para salir.`,
            chat);
        }
        break;
      }

      case 'cancelar': {
        if (chat.pendingAction) {
          chat.pendingAction = null;
          await bot.sendText(chatId, '✅ Búsqueda cancelada.');
        } else {
          await bot.sendText(chatId, 'No había ninguna acción pendiente.');
        }
        break;
      }

      case 'skills': {
        const list = this.skills.listSkills();
        if (!list.length) {
          await bot.sendText(chatId, '🔧 *Skills instalados*\n\nNo hay skills instalados.\nInstalá uno desde el panel web o la API.');
          return;
        }
        const lines = list.map(s => `• \`${s.slug}\` — ${s.name}${s.description ? `\n  _${s.description.slice(0, 80)}_` : ''}`).join('\n');
        await bot.sendText(chatId, `🔧 *Skills instalados* (${list.length})\n\n${lines}`);
        break;
      }

      // ── Monitor ───────────────────────────────────────────────────────────
      case 'monitor': {
        const cwd = chat.monitorCwd || process.env.HOME;
        await bot.sendText(chatId,
          `🖥️ *Monitor VPS*\n\n` +
          `Directorio: \`${cwd}\`\n\n` +
          `*Navegación:*\n` +
          `/ls — listar directorio actual\n` +
          `/dir — ver ruta actual (alias: /pwd)\n` +
          `/cat archivo — ver contenido\n` +
          `/mkdir nombre — crear carpeta\n\n` +
          `*Sistema:*\n` +
          `/status-vps — CPU, RAM y disco`
        );
        break;
      }

      case 'ls': {
        let dir = chat.monitorCwd || process.env.HOME;
        if (args.length > 0) dir = path.resolve(dir, args.join(' '));
        try {
          const stat = fs.statSync(dir);
          if (!stat.isDirectory()) {
            let content;
            try { content = fs.readFileSync(dir, 'utf8'); }
            catch { await bot.sendText(chatId, `⚠️ Archivo binario o sin permisos: ${path.basename(dir)}`); break; }
            const note = content.length > 3500 ? `\n[...truncado, ${content.length} chars total]` : '';
            await bot.sendText(chatId, `📄 ${path.basename(dir)}\n\n${content.slice(0, 3500)}${note}`);
          } else {
            chat.monitorCwd = dir;
            this._persistCwd(bot.key, chatId, dir);
            await bot.sendText(chatId, this._buildLsText(dir));
          }
        } catch (err) {
          await bot.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'cat': {
        const filename = args.join(' ');
        if (!filename) { await bot.sendText(chatId, '❌ Usá /cat <nombre-archivo>'); break; }
        const base     = chat.monitorCwd || process.env.HOME;
        const filePath = path.resolve(base, filename);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            chat.monitorCwd = filePath;
            this._persistCwd(bot.key, chatId, filePath);
            await bot.sendText(chatId, this._buildLsText(filePath));
          } else {
            let content;
            try { content = fs.readFileSync(filePath, 'utf8'); }
            catch { await bot.sendText(chatId, `⚠️ Archivo binario o sin permisos: ${filename}`); break; }
            const note = content.length > 3500 ? `\n[...truncado, ${content.length} chars total]` : '';
            await bot.sendText(chatId, `📄 ${filename}\n\n${content.slice(0, 3500)}${note}`);
          }
        } catch (err) {
          await bot.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'mkdir': {
        const dirname = args.join(' ');
        if (!dirname) { await bot.sendText(chatId, '❌ Usá /mkdir <nombre>'); break; }
        const base    = chat.monitorCwd || process.env.HOME;
        const newPath = path.resolve(base, dirname);
        try {
          fs.mkdirSync(newPath, { recursive: true });
          await bot.sendText(chatId, `✅ Carpeta creada: \`${newPath}\``);
        } catch (err) {
          await bot.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'status-vps': {
        try {
          const s = this._getSystemStats();
          await bot.sendWithButtons(chatId,
            `📊 *Estado del VPS*\n\n` +
            `🖥️ CPU: ${s.cpu}\n` +
            `🧠 RAM: ${s.ram}\n` +
            `💾 Disco: ${s.disk}\n` +
            `⏱️ Uptime: ${s.uptime}`,
            [[{ text: '🔄 Actualizar', callback_data: 'status_vps' }]]
          );
        } catch (err) {
          await bot.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      // ── Modo / Provider ───────────────────────────────────────────────────
      case 'modo':
      case 'mode': {
        if (!bot._isClaudeBased(chat.provider)) {
          await bot.sendText(chatId, '❌ Solo disponible con Claude Code.');
          break;
        }
        if (args.length === 0) {
          const current = chat.claudeMode || 'ask';
          await bot.sendWithButtons(chatId,
            `🔐 *Modo de permisos actual*: \`${current}\`\n\n` +
            `• \`ask\` — describe herramientas sin ejecutarlas (por defecto)\n` +
            `• \`auto\` — ejecuta todo sin pedir (rápido, puede ser peligroso)\n` +
            `• \`plan\` — solo planifica, no ejecuta nada`,
            [[
              { text: current === 'ask'  ? '✅ ask'  : 'ask',   callback_data: 'claudemode:ask'  },
              { text: current === 'auto' ? '✅ auto' : 'auto',  callback_data: 'claudemode:auto' },
              { text: current === 'plan' ? '✅ plan' : 'plan',  callback_data: 'claudemode:plan' },
            ],
            [{ text: '🤖 Menú', callback_data: 'menu' }]]
          );
        } else {
          const modo = args[0].toLowerCase();
          if (!['ask', 'auto', 'plan'].includes(modo)) {
            await bot.sendText(chatId, `❌ Modo inválido. Usá: \`ask\`, \`auto\` o \`plan\``);
            break;
          }
          chat.claudeMode = modo;
          if (chat.claudeSession) chat.claudeSession.permissionMode = modo;
          await bot.sendText(chatId, `✅ Modo de permisos cambiado a \`${modo}\``);
        }
        break;
      }

      case 'provider': {
        if (!this.providers) {
          await bot.sendText(chatId, '❌ Módulo de providers no disponible.');
          break;
        }
        if (args.length === 0) {
          const current = chat.provider || 'claude-code';
          const list = this.providers.list();
          const buttons = list.map(p => [{
            text: `${current === p.name ? '✅ ' : ''}${p.label}`,
            callback_data: `provider:${p.name}`,
          }]);
          await bot.sendWithButtons(chatId,
            `🤖 *Provider actual*: \`${current}\`\n\nElegí un provider:`,
            buttons
          );
        } else {
          const newProvider = args[0].toLowerCase();
          const available = this.providers.list().map(p => p.name);
          if (!available.includes(newProvider)) {
            await bot.sendText(chatId,
              `❌ Provider desconocido: \`${newProvider}\`\n\nDisponibles: ${available.join(', ')}`
            );
            break;
          }
          chat.provider = newProvider;
          if (newProvider === 'claude-code') {
            chat.claudeSession = null;
          } else {
            chat.aiHistory = [];
          }
          const label = this.providers.get(newProvider).label;
          await bot.sendText(chatId, `✅ Provider cambiado a *${label}*`);
        }
        break;
      }

      case 'permisos':
      case 'modo-permisos': {
        if (!bot._isClaudeBased(chat.provider)) {
          await bot.sendText(chatId, '❌ Solo disponible con Claude Code.');
          break;
        }
        if (args.length === 0) {
          const current = chat.claudeMode || 'ask';
          await bot.sendWithButtons(chatId,
            `🔐 *Modo de permisos actual*: \`${current}\`\n\n` +
            `• \`ask\` — describe herramientas sin ejecutarlas (por defecto)\n` +
            `• \`auto\` — ejecuta todo sin pedir (rápido, puede ser peligroso)\n` +
            `• \`plan\` — solo planifica, no ejecuta nada`,
            [[
              { text: current === 'ask'  ? '✅ ask'  : 'ask',   callback_data: 'claudemode:ask'  },
              { text: current === 'auto' ? '✅ auto' : 'auto',  callback_data: 'claudemode:auto' },
              { text: current === 'plan' ? '✅ plan' : 'plan',  callback_data: 'claudemode:plan' },
            ]]
          );
        } else {
          const newMode = args[0].toLowerCase();
          if (!['auto', 'ask', 'plan'].includes(newMode)) {
            await bot.sendText(chatId, '❌ Modo inválido. Opciones: `ask`, `auto`, `plan`');
            break;
          }
          chat.claudeMode = newMode;
          if (chat.claudeSession) chat.claudeSession.permissionMode = newMode;
          const labels = { auto: '⚡ auto-accept', ask: '❓ ask', plan: '📋 plan' };
          await bot.sendText(chatId,
            `✅ Modo cambiado a *${labels[newMode]}*\n` +
            `_El contexto de conversación se mantiene._`
          );
        }
        break;
      }

      // ── Recordatorios ─────────────────────────────────────────────────────
      case 'recordar':
      case 'alarma':
      case 'reminder': {
        if (!this.reminders) { await bot.sendText(chatId, '❌ Módulo de recordatorios no disponible.'); break; }
        const raw = args.join(' ');
        if (!raw) {
          await bot.sendText(chatId,
            `⏰ *Recordatorio*\n\n` +
            `Usá: /recordar <tiempo> <mensaje>\n\n` +
            `Ejemplos:\n` +
            `• \`/recordar 10m revisar el deploy\`\n` +
            `• \`/recordar 2h llamar al cliente\`\n` +
            `• \`/recordar 1d renovar dominio\`\n` +
            `• \`/recordar 1h30m sacar la comida\`\n\n` +
            `Unidades: \`s\` seg, \`m\` min, \`h\` horas, \`d\` días`
          );
          break;
        }
        const durationMatch = raw.match(/^([\d]+\s*(?:s|seg|min|m|h|hs|d|dias?)\s*)+/i);
        if (!durationMatch) {
          await bot.sendText(chatId, '❌ No pude entender la duración. Ejemplo: `/recordar 10m mensaje`');
          break;
        }
        const durationStr = durationMatch[0];
        const durationMs  = this.reminders.parseDuration(durationStr);
        if (!durationMs) {
          await bot.sendText(chatId, '❌ Duración inválida. Unidades: `s`, `m`, `h`, `d`');
          break;
        }
        const reminderText = raw.slice(durationStr.length).trim() || '⏰ ¡Recordatorio!';
        const reminder     = this.reminders.add(chatId, bot.key, reminderText, durationMs);
        const remaining    = this.reminders.formatRemaining(durationMs);
        await bot.sendWithButtons(chatId,
          `✅ Recordatorio creado\n\n📝 _${reminderText}_\n⏰ En *${remaining}*`,
          [[{ text: '❌ Cancelar', callback_data: `reminder_cancel:${reminder.id}` },
            { text: '📋 Ver todos', callback_data: 'reminders_list' }]]
        );
        break;
      }

      case 'recordatorios':
      case 'reminders':
      case 'alarmas': {
        if (!this.reminders) { await bot.sendText(chatId, '❌ Módulo de recordatorios no disponible.'); break; }
        const list = this.reminders.listForChat(chatId);
        if (!list.length) {
          await bot.sendText(chatId, '📭 No tenés recordatorios pendientes.');
          break;
        }
        const lines = list.map((r, i) => {
          const remaining = this.reminders.formatRemaining(r.triggerAt - Date.now());
          return `${i + 1}. 📝 _${r.text}_\n   ⏰ En *${remaining}* — \`${r.id}\``;
        }).join('\n\n');
        const buttons = list.map(r => [{ text: `❌ ${r.text.slice(0, 20)}`, callback_data: `reminder_cancel:${r.id}` }]);
        await bot.sendWithButtons(chatId,
          `⏰ *Recordatorios pendientes* (${list.length})\n\n${lines}`,
          buttons
        );
        break;
      }

      // ── Whisper ──────────────────────────────────────────────────────────
      case 'whisper': {
        if (!this.transcriber) { await bot.sendText(chatId, '❌ Módulo de transcripción no disponible.'); break; }
        const { getConfig, setModel, setLanguage, VALID_MODELS, VALID_LANGUAGES } = this.transcriber;

        if (args.length === 0) {
          const { text, buttons } = this._buildWhisperUI();
          await bot.sendWithButtons(chatId, text, buttons);
        } else {
          const val = args[0].toLowerCase();
          if (VALID_MODELS.includes(val)) {
            setModel(val);
            await bot.sendText(chatId, `✅ Modelo Whisper cambiado a \`${val}\``);
          } else if (VALID_LANGUAGES.includes(val)) {
            setLanguage(val);
            await bot.sendText(chatId, `✅ Idioma Whisper cambiado a \`${val}\``);
          } else {
            await bot.sendText(chatId,
              `❌ Valor inválido: \`${val}\`\n\n` +
              `Modelos: ${VALID_MODELS.map(m => `\`${m}\``).join(', ')}\n` +
              `Idiomas: ${VALID_LANGUAGES.map(l => `\`${l}\``).join(', ')}`
            );
          }
        }
        break;
      }

      default: {
        // Detectar /{key} de agente con prompt de rol
        const agentDef = this.agents.get(cmd);
        if (agentDef?.prompt) {
          chat.claudeSession = new ClaudePrintSession(bot._claudeSessionOpts(chat));
          chat.activeAgent = { key: agentDef.key, prompt: agentDef.prompt };
          const fullPrompt = this.skills.buildAgentPrompt(agentDef);
          await bot._sendToSession(chatId, fullPrompt, chat);
          return;
        }
        await bot.sendText(chatId, `❓ Comando desconocido: /${cmd}\nUsá /ayuda o /agentes.`);
        break;
      }
    }
  }
}

module.exports = CommandHandler;
