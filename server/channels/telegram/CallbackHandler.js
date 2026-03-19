'use strict';

const ClaudePrintSession   = require('../../core/ClaudePrintSession');
const os                   = require('os');
const { getSystemStats }   = require('../../core/systemStats');

/**
 * CallbackHandler — maneja _handleCallbackQuery y el motor de menús declarativo.
 *
 * Deps inyectadas:
 *   agents, skills, memory, reminders, mcps, consolidator,
 *   providers, providerConfig, chatSettings, voiceProviders, ttsConfig, logger
 */
class CallbackHandler {
  constructor({
    agents,
    skills,
    memory         = null,
    reminders      = null,
    mcps           = null,
    consolidator   = null,
    providers      = null,
    providerConfig = null,
    chatSettings   = null,
    transcriber    = null,
    tts            = null,
    voiceProviders = null,
    ttsConfig      = null,
    logger         = console,
  }) {
    this.agents         = agents;
    this.skills         = skills;
    this.memory         = memory;
    this.reminders      = reminders;
    this.mcps           = mcps;
    this.consolidator   = consolidator;
    this.providers      = providers;
    this.providerConfig = providerConfig;
    this.chatSettings   = chatSettings;
    this.transcriber    = transcriber;
    this.tts            = tts;
    this.voiceProviders = voiceProviders;
    this.ttsConfig      = ttsConfig;
    this.logger         = logger;
  }

  _getSystemStats() { return getSystemStats(); }

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

  _buildVoiceUI() {
    const ttsConfig = this.ttsConfig;
    const voiceProviders = this.voiceProviders;
    if (!ttsConfig || !voiceProviders) {
      return { text: '🔊 *Voz* — módulo no disponible', buttons: [] };
    }

    const cfg     = ttsConfig.getConfig();
    const enabled = cfg.enabled;
    const current = cfg.default;
    const provList = voiceProviders.list();
    const currentProv = voiceProviders.get(current);
    const provCfg = cfg.providers[current] || {};

    let text =
      `🔊 *Voz — Voice Providers*\n\n` +
      `• Estado: ${enabled ? '✅ Activado' : '❌ Desactivado'}\n` +
      `• Provider: \`${currentProv.label}\`\n` +
      `• Voz: \`${provCfg.voice || currentProv.defaultVoice || 'default'}\`\n` +
      `• Modelo: \`${provCfg.model || currentProv.defaultModel}\``;

    if (current === 'speecht5') {
      const dtype = voiceProviders.get('speecht5').getLoadedDtype?.();
      if (dtype) text += ` (${dtype})`;
    }

    const buttons = [];

    // Toggle
    buttons.push([{
      text: enabled ? '🔇 Desactivar' : '🔊 Activar',
      callback_data: 'voice:toggle',
    }]);

    // Lista de providers
    const provButtons = provList.map(p => ({
      text: `${current === p.name ? '✅ ' : ''}${p.label}`,
      callback_data: `voice:provider:${p.name}`,
    }));
    // De a 2 por fila
    for (let i = 0; i < provButtons.length; i += 2) {
      buttons.push(provButtons.slice(i, i + 2));
    }

    buttons.push([{ text: '← Config', callback_data: 'menu:config' }]);
    return { text, buttons };
  }

  // ── Motor de menús declarativo ──────────────────────────────────────────────

  _resolveButtons(rawRows, back = null) {
    const rows = (rawRows || []).map(row =>
      row.map(btn => ({ text: btn.text, callback_data: btn.id }))
    );
    if (back) rows.push([{ text: '← Atrás', callback_data: back }]);
    return rows;
  }

  getMenuDef(id, { bot } = {}) {
    const providers    = this.providers;
    const providerConfig = this.providerConfig;
    const mcps         = this.mcps;
    const skills       = this.skills;
    const agents       = this.agents;

    const defs = {

      // ── Raíz ──────────────────────────────────────────────────────────────
      'menu': {
        text: '🤖 *Menú principal*\n\nElegí una sección:',
        buttons: (chat) => {
          const isClaudeCode = !chat?.provider || chat.provider === 'claude-code';
          const rows = [
            [{ text: '💬 Sesión',   id: 'menu:sesion'  },
             { text: '🔌 MCPs',     id: 'menu:mcps'    }],
            [{ text: '🔧 Skills',   id: 'menu:skills'  },
             { text: '🎭 Agentes',  id: 'menu:agentes' }],
            [{ text: '🖥️ Monitor',  id: 'menu:monitor' },
             { text: '⚙️ Config',   id: 'menu:config'  }],
          ];
          if (isClaudeCode) {
            rows.push([{ text: '🔐 Permisos', id: 'menu:config:permisos' }]);
          }
          return rows;
        },
      },

      // ── Sesión ────────────────────────────────────────────────────────────
      'menu:sesion': {
        text: (chat) => {
          const cs = chat?.claudeSession;
          return `💬 *Sesión*\nAgente: \`${bot?.defaultAgent || '—'}\` | Modo: \`${chat?.claudeMode||'ask'}\`` +
            (cs ? `\nMensajes: ${cs.messageCount} | Costo: $${cs.totalCostUsd.toFixed(4)}` : '');
        },
        buttons: () => [
          [{ text: '💬 Nueva conv.',  id: 'nueva'               },
           { text: '📊 Estado',       id: 'menu:sesion:estado'  }],
          [{ text: '💰 Costo',        id: 'menu:sesion:costo'   },
           { text: '🔁 Compact',      id: 'compact_action'      }],
          [{ text: '← Menú',          id: 'menu'                }],
        ],
      },
      'menu:sesion:estado': {
        action: async ({ chatId, msgId, chat, bot: b }) => {
          const cs = chat.claudeSession;
          const uptime = cs ? Math.round((Date.now() - cs.createdAt) / 1000) : 0;
          const text = cs
            ? `📊 *Estado de sesión*\n\nID: \`${cs.id.slice(0,8)}…\`\n` +
              `Agente: ${b.defaultAgent}\nModelo: \`${cs.model||'default'}\`\n` +
              `Modo permisos: \`${chat.claudeMode||'ask'}\`\nMensajes: ${cs.messageCount}\n` +
              `Uptime: ${Math.floor(uptime/60)}m ${uptime%60}s\n` +
              `Costo: $${cs.totalCostUsd.toFixed(4)} USD`
            : '📊 Sin sesión activa.';
          await b.sendWithButtons(chatId, text,
            [[{ text: '← Sesión', callback_data: 'menu:sesion' }]], msgId);
        },
      },
      'menu:sesion:costo': {
        action: async ({ chatId, msgId, chat, bot: b }) => {
          const cs = chat.claudeSession;
          const text = cs
            ? `💰 *Costo de sesión*\n\nÚltimo: $${cs.lastCostUsd.toFixed(4)} USD\n` +
              `Total: $${cs.totalCostUsd.toFixed(4)} USD\nMensajes: ${cs.messageCount}`
            : '💰 Sin sesión activa.';
          await b.sendWithButtons(chatId, text,
            [[{ text: '← Sesión', callback_data: 'menu:sesion' }]], msgId);
        },
      },

      // ── MCPs ──────────────────────────────────────────────────────────────
      'menu:mcps': {
        text: () => {
          let count = 0;
          try { count = mcps ? mcps.list().length : 0; } catch {}
          return `🔌 *MCPs* — ${count} configurado${count !== 1 ? 's' : ''}`;
        },
        buttons: () => [
          [{ text: '📋 Listar',  id: 'menu:mcps:list'   },
           { text: '🔍 Buscar',  id: 'menu:mcps:buscar' }],
          [{ text: '← Menú',     id: 'menu'             }],
        ],
      },
      'menu:mcps:list': {
        action: async ({ chatId, msgId, bot: b }) => {
          let list = [];
          try { list = mcps ? mcps.list() : []; } catch {}
          const text = list.length
            ? `🔌 *MCPs (${list.length})*\n\n` + list.map(m =>
                `${m.enabled ? '✅' : '⏸'} \`${m.name}\` ${m.type==='http'?'🌐':'📦'}\n` +
                `  _${(m.description||m.url||m.command||'').slice(0,50)}_`
              ).join('\n')
            : '🔌 No hay MCPs configurados.';
          await b.sendWithButtons(chatId, text,
            [[{ text: '🔍 Buscar', callback_data: 'menu:mcps:buscar' },
              { text: '← MCPs',   callback_data: 'menu:mcps' }]], msgId);
        },
      },
      'menu:mcps:buscar': {
        action: async ({ chatId, chat, bot: b }) => {
          chat.pendingAction = { type: 'mcp-search' };
          await b.sendText(chatId,
            '🔌 *Buscar MCP en Smithery*\n\n¿Qué tipo de MCP necesitás?\n' +
            '_Ejemplos: "github", "postgres", "búsqueda web"_\n\nUsá /cancelar para cancelar.'
          );
        },
      },

      // ── Skills ────────────────────────────────────────────────────────────
      'menu:skills': {
        text: () => {
          const count = skills ? skills.listSkills().length : 0;
          return `🔧 *Skills* — ${count} instalado${count !== 1 ? 's' : ''}`;
        },
        buttons: () => [
          [{ text: '📋 Listar',  id: 'menu:skills:list'   },
           { text: '🔍 Buscar',  id: 'menu:skills:buscar' }],
          [{ text: '← Menú',     id: 'menu'               }],
        ],
      },
      'menu:skills:list': {
        action: async ({ chatId, msgId, bot: b }) => {
          const list = skills ? skills.listSkills() : [];
          const text = list.length
            ? `🔧 *Skills (${list.length})*\n\n` + list.map(s =>
                `• \`${s.slug}\` — ${s.name}\n  _${(s.description||'').slice(0,60)}_`
              ).join('\n')
            : '🔧 No hay skills instalados.';
          await b.sendWithButtons(chatId, text,
            [[{ text: '🔍 Buscar', callback_data: 'menu:skills:buscar' },
              { text: '← Skills',  callback_data: 'menu:skills' }]], msgId);
        },
      },
      'menu:skills:buscar': {
        action: async ({ chatId, chat, bot: b }) => {
          chat.pendingAction = { type: 'skill-search' };
          await b.sendText(chatId,
            '🔍 *Buscar skill en ClawHub*\n\n¿Para qué necesitás el skill?\n' +
            '_Ejemplos: "crear PDFs", "enviar emails"_\n\nUsá /cancelar para cancelar.'
          );
        },
      },

      // ── Agentes ───────────────────────────────────────────────────────────
      'menu:agentes': {
        text: (chat) => `🎭 *Agentes de rol*${chat?.activeAgent ? `\nActivo: \`${chat.activeAgent.key}\`` : ''}`,
        buttons: (chat) => {
          const roleAgents = agents ? agents.list().filter(a => a.prompt) : [];
          if (!roleAgents.length) return [[{ text: '← Menú', id: 'menu' }]];
          const agentRows = roleAgents.map(a => [{
            text: (chat?.activeAgent?.key === a.key ? '✅ ' : '') + a.key,
            id: `agent:${a.key}`,
          }]);
          const navRow = [];
          if (chat?.activeAgent) navRow.push({ text: '🚫 Basta', id: 'basta_action' });
          navRow.push({ text: '← Menú', id: 'menu' });
          return [...agentRows, navRow];
        },
      },

      // ── Monitor ───────────────────────────────────────────────────────────
      'menu:monitor': {
        text: (chat) => `🖥️ *Monitor*\nDirectorio: \`${chat?.monitorCwd || process.env.HOME}\``,
        buttons: () => {
          const listCmd = process.platform === 'win32' ? 'dir' : 'ls';
          return [
            [{ text: `📁 ${listCmd}`,   id: 'menu:monitor:ls'      },
             { text: '🖥️ Consola',       id: 'menu:monitor:consola' }],
            [{ text: '📊 Status',        id: 'status_vps'           },
             { text: '← Menú',           id: 'menu'                 }],
          ];
        },
      },
      'menu:monitor:consola': {
        action: async ({ chatId, chat, bot: b }) => {
          chat.consoleMode = true;
          await b._sendConsolePrompt(chatId,
            `🖥️ *Modo consola activado*\n\nEscribí comandos directamente.\n\`exit\` o /consola para salir.`,
            chat);
        },
      },

      // ── Configuración ─────────────────────────────────────────────────────
      'menu:config': {
        text: (chat) => {
          const provider = chat?.provider || 'claude-code';
          const model = provider === 'claude-code'
            ? (chat?.claudeSession?.model || 'default')
            : (chat?.model || providers?.get(provider)?.defaultModel || 'default');
          return `⚙️ *Configuración*\nProvider: \`${provider}\` | Modelo: \`${model}\``;
        },
        buttons: () => [
          [{ text: '🤖 Provider',  id: 'menu:config:provider'   },
           { text: '🧠 Modelo',    id: 'menu:config:modelo'     }],
          [{ text: '🔊 Voz',       id: 'menu:config:voz'        },
           { text: '👥 Whitelist', id: 'menu:config:whitelist'  }],
          [{ text: '← Menú',       id: 'menu'                   }],
        ],
      },
      'menu:config:provider': {
        action: async ({ chatId, msgId, chat, bot: b }) => {
          if (!providers) {
            await b.sendText(chatId, '❌ Módulo providers no disponible.'); return;
          }
          const current = chat.provider || 'claude-code';
          const providerButtons = providers.list().map(p => [{
            text: `${current === p.name ? '✅ ' : ''}${p.label}`,
            callback_data: `provider:${p.name}`,
          }]);
          providerButtons.push([{ text: '← Config', callback_data: 'menu:config' }]);
          await b.sendWithButtons(chatId,
            `🤖 *Provider actual*: \`${current}\`\nElegí uno:`,
            providerButtons, msgId);
        },
      },
      'menu:config:permisos': {
        action: async ({ chatId, msgId, chat, bot: b }) => {
          const current = chat.claudeMode || 'ask';
          await b.sendWithButtons(chatId,
            `🔐 *Modo de permisos*: \`${current}\`\n\n• \`ask\` — describe sin ejecutar\n• \`auto\` — ejecuta todo\n• \`plan\` — solo planifica`,
            [[
              { text: current==='ask'  ? '✅ ask'  : 'ask',   callback_data: 'claudemode:ask'  },
              { text: current==='auto' ? '✅ auto' : 'auto',  callback_data: 'claudemode:auto' },
              { text: current==='plan' ? '✅ plan' : 'plan',  callback_data: 'claudemode:plan' },
            ],
            [{ text: '← Config', callback_data: 'menu:config' }]],
            msgId);
        },
      },
      'menu:config:modelo': {
        action: async ({ chatId, msgId, chat, bot: b }) => {
          const provider = chat?.provider || 'claude-code';
          if (provider === 'claude-code') {
            const current = chat.claudeSession?.model || 'default';
            await b.sendWithButtons(chatId,
              `🧠 *Modelo actual*: \`${current}\`\nElegí uno:`,
              [
                [{ text: current==='claude-opus-4-6'           ? '✅ opus-4-6'   : 'opus-4-6',   callback_data: 'setmodel:claude-opus-4-6' },
                 { text: current==='claude-sonnet-4-6'         ? '✅ sonnet-4-6' : 'sonnet-4-6', callback_data: 'setmodel:claude-sonnet-4-6' }],
                [{ text: current==='claude-haiku-4-5-20251001' ? '✅ haiku-4-5'  : 'haiku-4-5',  callback_data: 'setmodel:claude-haiku-4-5-20251001' },
                 { text: current==='default'                   ? '✅ default'    : 'default',     callback_data: 'setmodel:default' }],
                [{ text: '← Config', callback_data: 'menu:config' }],
              ], msgId);
          } else {
            if (!providers) {
              await b.sendText(chatId, '❌ Módulo providers no disponible.'); return;
            }
            const provObj = providers.get(provider);
            const current = chat.model || provObj.defaultModel;
            const modelButtons = provObj.models.map(m => [{
              text: `${current === m ? '✅ ' : ''}${m}`,
              callback_data: `setmodel:${m}`,
            }]);
            modelButtons.push([{ text: '← Config', callback_data: 'menu:config' }]);
            await b.sendWithButtons(chatId,
              `🧠 *Modelo actual* (${provObj.label}): \`${current}\`\nElegí uno:`,
              modelButtons, msgId);
          }
        },
      },

      // ── Voz (Voice Providers) ─────────────────────────────────────────────
      'menu:config:voz': {
        action: async ({ chatId, msgId, bot: b }) => {
          const ui = this._buildVoiceUI();
          await b.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
        },
      },

      // ── Whitelist ──────────────────────────────────────────────────────────
      'menu:config:whitelist': {
        action: async ({ chatId, msgId, bot: b }) => {
          const list = b.whitelist;
          let text = `👥 *Lista blanca* (${list.length === 0 ? 'abierta a todos' : list.length + ' ID(s)'})\n\n`;
          if (list.length > 0) {
            text += list.map(id => `• \`${id}\``).join('\n') + '\n\n';
          }
          text += '_ID vacía = cualquiera puede usar el bot_';
          const buttons = [];
          if (list.length > 0) {
            list.forEach(id => buttons.push([{
              text: `❌ Eliminar ${id}`,
              callback_data: `whitelist:remove:${id}`,
            }]));
          }
          buttons.push([
            { text: '➕ Agregar ID', callback_data: 'whitelist:add' },
            { text: '← Config',     callback_data: 'menu:config'   },
          ]);
          await b.sendWithButtons(chatId, text, buttons, msgId);
        },
      },

    }; // fin defs

    return defs[id] || null;
  }

  /**
   * Manejar un callback_query completo.
   * @param {object} bot - instancia de TelegramBot
   * @param {object} cbq - callback_query de Telegram
   */
  async handle(bot, cbq) {
    const chatId = cbq.message?.chat?.id;
    if (!chatId) return;
    const msgId = cbq.message?.message_id;

    const chatType = cbq.message?.chat?.type;
    if (!bot._isAllowed(chatId, chatType)) {
      await bot._answerCallback(cbq.id, '⛔ Sin acceso');
      return;
    }

    // Inicializar chat si no existe
    let chat = bot.chats.get(chatId);
    if (!chat) {
      const saved = this.chatSettings ? this.chatSettings.load(bot.key, chatId) : null;
      chat = {
        chatId,
        username: cbq.from?.username || null,
        firstName: cbq.from?.first_name || 'Usuario',
        sessionId: null,
        claudeSession: null,
        activeAgent: null,
        pendingAction: null,
        lastMessageAt: Date.now(),
        lastPreview: '',
        rateLimited: false,
        rateLimitedUntil: 0,
        monitorCwd: process.env.HOME,
        busy: false,
        provider: saved?.provider || 'claude-code',
        model: saved?.model || null,
        aiHistory: [],
        claudeMode: 'ask',
        consoleMode: false,
      };
      bot.chats.set(chatId, chat);
    }

    await bot._answerCallback(cbq.id);
    const data = cbq.data || '';

    // Whitelist: agregar / eliminar
    if (data === 'whitelist:add') {
      chat.pendingAction = { type: 'whitelist-add' };
      await bot.sendText(chatId,
        '➕ *Agregar a la lista blanca*\n\n' +
        'Enviá el chat ID (número) del usuario o grupo a autorizar.\n' +
        '_Tip: pedile que te mande /id en el bot._\n\n' +
        'Usá /cancelar para cancelar.'
      );
      return;
    }

    if (data.startsWith('whitelist:remove:')) {
      const idToRemove = parseInt(data.slice(17), 10);
      bot.whitelist = bot.whitelist.filter(id => id !== idToRemove);
      bot._onOffsetSave();
      const def = this.getMenuDef('menu:config:whitelist', { bot });
      await def.action({ chatId, msgId, chat, bot });
      return;
    }

    // Botones post-respuesta
    if (data.startsWith('postreply:')) {
      const action = data.slice(10);
      if (action === 'continue') {
        await bot._sendToSession(chatId, 'continúa', chat);
      } else if (action === 'new') {
        if (bot._isClaudeBased()) {
          chat.claudeSession = new ClaudePrintSession(bot._claudeSessionOpts(chat));
          await bot.sendText(chatId, '✅ Nueva conversación iniciada.');
        } else {
          chat.aiHistory = [];
          await bot.sendText(chatId, '✅ Historial limpiado.');
        }
      } else if (action === 'save') {
        const lastReply = cbq.message?.text;
        if (lastReply && this.memory) {
          const agentKey  = chat.activeAgent?.key || bot.defaultAgent;
          const filename  = `telegram_${Date.now()}.md`;
          this.memory.write(agentKey, filename, lastReply);
          await bot.sendText(chatId, `💾 Guardado en memoria de *${agentKey}* → \`${filename}\``);
        } else {
          await bot.sendText(chatId, '❌ No hay texto para guardar.');
        }
      }
      return;
    }

    // Callbacks de consola
    if (data.startsWith('console:')) {
      const command = data.slice(8);
      chat.consoleMode = true;
      await bot._handleConsoleInput(chatId, command, chat);
      return;
    }

    // Motor de menús declarativo
    if (data.startsWith('menu:')) {
      const def = this.getMenuDef(data, { bot });
      if (!def) return;
      if (def.action) {
        await def.action({ chatId, msgId, chat, bot });
      } else {
        const text    = typeof def.text    === 'function' ? def.text(chat)    : def.text;
        const rawRows = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
        const buttons = this._resolveButtons(rawRows, def.back);
        await bot.sendWithButtons(chatId, text, buttons, msgId);
      }
      return;
    }

    if (data.startsWith('setmodel:')) {
      const newModel   = data.slice(9);
      const provider   = chat.provider || 'claude-code';
      if (provider === 'claude-code') {
        const model = newModel === 'default' ? null : newModel;
        chat.claudeSession = new ClaudePrintSession({ ...bot._claudeSessionOpts(chat), model });
        await bot.sendText(chatId, `✅ Modelo: \`${newModel}\`\n_Nueva sesión iniciada._`);
      } else {
        chat.model = newModel;
        if (this.chatSettings) this.chatSettings.save(bot.key, chatId, { provider, model: newModel });
        const label = this.providers?.get(provider)?.label || provider;
        await bot.sendText(chatId, `✅ Modelo de *${label}* → \`${newModel}\``);
      }
      return;
    }

    if (data.startsWith('claudemode:')) {
      const newMode = data.slice(11);
      if (['auto', 'ask', 'plan'].includes(newMode)) {
        chat.claudeMode = newMode;
        if (chat.claudeSession) chat.claudeSession.permissionMode = newMode;
        const labels = { auto: '⚡ auto-accept', ask: '❓ ask', plan: '📋 plan' };
        await bot.sendText(chatId, `✅ Modo cambiado a *${labels[newMode]}*\n_Contexto preservado._`);
      }
      return;
    }

    if (data.startsWith('provider:') && this.providers) {
      const newProvider = data.slice(9);
      const available = this.providers.list().map(p => p.name);
      if (available.includes(newProvider)) {
        chat.provider = newProvider;
        chat.model    = null;
        if (newProvider === 'claude-code') {
          chat.claudeSession = null;
        } else {
          chat.aiHistory = [];
        }
        if (this.chatSettings) this.chatSettings.save(bot.key, chatId, { provider: newProvider, model: null });

        if (newProvider === 'claude-code') {
          await bot.sendText(chatId, `✅ Provider cambiado a *Claude Code*`);
        } else {
          const provObj = this.providers.get(newProvider);
          const defaultModel = provObj.defaultModel;
          const modelButtons = provObj.models.map(m => [{
            text: `${defaultModel === m ? '✅ ' : ''}${m}`,
            callback_data: `setmodel:${m}`,
          }]);
          await bot.sendWithButtons(chatId,
            `✅ Provider: *${provObj.label}*\n🧠 Elegí un modelo:`,
            modelButtons);
        }
      }
      return;
    }

    if (data.startsWith('whisper:') && this.transcriber) {
      const model = data.slice(8);
      this.transcriber.setModel(model);
      const ui = this._buildWhisperUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data.startsWith('whisperlang:') && this.transcriber) {
      const lang = data.slice(12);
      this.transcriber.setLanguage(lang);
      const ui = this._buildWhisperUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data === 'tts:toggle' && this.tts) {
      if (this.tts.isEnabled()) { this.tts.disable(); } else { this.tts.enable(); }
      const ui = this._buildVoiceUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data === 'voice:toggle' && this.ttsConfig) {
      if (this.ttsConfig.isEnabled()) { this.ttsConfig.disable(); } else { this.ttsConfig.enable(); }
      const ui = this._buildVoiceUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data.startsWith('voice:provider:') && this.ttsConfig && this.voiceProviders) {
      const name = data.slice(15);
      this.ttsConfig.setDefault(name);
      const prov = this.voiceProviders.get(name);
      // Si tiene voices, mostrar selector
      if (prov.voices && prov.voices.length > 0) {
        const cfg = this.ttsConfig.getConfig();
        const currentVoice = cfg.providers[name]?.voice || prov.defaultVoice;
        const voiceButtons = [];
        for (let i = 0; i < prov.voices.length; i += 3) {
          voiceButtons.push(prov.voices.slice(i, i + 3).map(v => ({
            text: `${currentVoice === v ? '✅ ' : ''}${v}`,
            callback_data: `voice:${name}:voice:${v}`,
          })));
        }
        // Modelos
        if (prov.models && prov.models.length > 1) {
          const currentModel = cfg.providers[name]?.model || prov.defaultModel;
          voiceButtons.push(prov.models.map(m => ({
            text: `${currentModel === m ? '✅ ' : ''}${m}`,
            callback_data: `voice:${name}:model:${m}`,
          })));
        }
        voiceButtons.push([{ text: '← Voz', callback_data: 'menu:config:voz' }]);
        await bot.sendWithButtons(chatId,
          `🔊 *${prov.label}*\nElegí una voz:`,
          voiceButtons, msgId);
      } else {
        const ui = this._buildVoiceUI();
        await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      }
      return;
    }

    if (data.match(/^voice:[^:]+:voice:/) && this.ttsConfig) {
      const parts = data.split(':');
      // voice:<provider>:voice:<voiceName>
      const provName = parts[1];
      const voiceName = parts.slice(3).join(':');
      this.ttsConfig.setProvider(provName, { voice: voiceName });
      const ui = this._buildVoiceUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data.match(/^voice:[^:]+:model:/) && this.ttsConfig) {
      const parts = data.split(':');
      // voice:<provider>:model:<modelName>
      const provName = parts[1];
      const modelName = parts.slice(3).join(':');
      this.ttsConfig.setProvider(provName, { model: modelName });
      const ui = this._buildVoiceUI();
      await bot.sendWithButtons(chatId, ui.text, ui.buttons, msgId);
      return;
    }

    if (data.startsWith('mem:')) {
      const memSub      = data.slice(4);
      const memAgentKey = chat.activeAgent?.key || bot.defaultAgent;
      if (memSub === 'test') {
        await bot.sendText(chatId,
          `🔍 *Test de señales*\n\nUsá el comando:\n\`/mem test <texto de prueba>\``
        );
      } else if (memSub === 'ver' || memSub === 'config') {
        await bot._handleCommand({ chat: { id: chatId } }, 'mem', ['ver'], chat);
      } else if (memSub === 'notas') {
        await bot._handleCommand({ chat: { id: chatId } }, 'mem', ['notas'], chat);
      } else if (memSub === 'reset') {
        if (this.memory) {
          const ok = this.memory.resetPreferences(memAgentKey);
          await bot.sendText(chatId,
            ok
              ? `✅ Preferencias de \`${memAgentKey}\` reiniciadas.`
              : `ℹ️ Ya usa los valores globales.`
          );
        }
      }
      return;
    }

    if (data.startsWith('topic:')) {
      const parts2      = data.split(':');
      const topicAction = parts2[1];
      const topicName   = parts2[2] || '';
      const topicAgent  = parts2[3] || (chat.activeAgent?.key || bot.defaultAgent);

      if (topicAction === 'add' && topicName && this.consolidator) {
        const added = this.consolidator.addTopic(topicAgent, topicName);
        await bot.sendText(chatId,
          added
            ? `✅ Tópico *${topicName.replace(/_/g, ' ')}* agregado a las preferencias de \`${topicAgent}\`.`
            : `ℹ️ El tópico *${topicName.replace(/_/g, ' ')}* ya estaba en las preferencias.`
        );
      } else if (topicAction === 'skip') {
        await bot.sendText(chatId, `⏭️ Tópico ignorado.`);
      }
      return;
    }

    if (data.startsWith('agent:')) {
      const agentKey = data.slice(6);
      const agentDef = this.agents ? this.agents.get(agentKey) : null;
      if (agentDef?.prompt) {
        chat.claudeSession = new ClaudePrintSession(bot._claudeSessionOpts(chat));
        chat.activeAgent = { key: agentDef.key, prompt: agentDef.prompt };
        const fullPrompt = this.skills ? this.skills.buildAgentPrompt(agentDef) : agentDef.prompt;
        await bot._sendToSession(chatId, fullPrompt, chat);
      } else {
        await bot.sendText(chatId, `❌ Agente "${agentKey}" no encontrado o sin prompt.`);
      }
      return;
    }

    // Recordatorios
    if (data.startsWith('reminder_cancel:')) {
      if (!this.reminders) return;
      const reminderId = data.slice(16);
      const ok = this.reminders.remove(reminderId);
      await bot.sendText(chatId, ok ? '✅ Recordatorio cancelado.' : '❌ Recordatorio no encontrado.');
      return;
    }

    if (data === 'reminders_list') {
      if (!this.reminders) return;
      const list = this.reminders.listForChat(chatId);
      if (!list.length) {
        await bot.sendText(chatId, '📭 No tenés recordatorios pendientes.');
      } else {
        const lines = list.map((r, i) => {
          const remaining = this.reminders.formatRemaining(r.triggerAt - Date.now());
          return `${i + 1}. 📝 _${r.text}_\n   ⏰ En *${remaining}*`;
        }).join('\n\n');
        const buttons = list.map(r => [{ text: `❌ ${r.text.slice(0, 20)}`, callback_data: `reminder_cancel:${r.id}` }]);
        await bot.sendWithButtons(chatId, `⏰ *Recordatorios pendientes* (${list.length})\n\n${lines}`, buttons);
      }
      return;
    }

    // Switch de casos simples
    switch (data) {
      case 'status_vps': {
        try {
          const s = this._getSystemStats();
          await bot.sendWithButtons(chatId,
            `📊 *Estado del VPS*\n\n🖥️ CPU: ${s.cpu}\n🧠 RAM: ${s.ram}\n💾 Disco: ${s.disk}\n⏱️ Uptime: ${s.uptime}`,
            [[{ text: '🔄 Actualizar', callback_data: 'status_vps' }]],
            msgId
          );
        } catch (err) {
          await bot.sendText(chatId, `❌ Error: ${err.message}`);
        }
        break;
      }

      case 'nueva':
      case 'reset': {
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

      case 'skills': {
        const list = this.skills ? this.skills.listSkills() : [];
        if (!list.length) {
          await bot.sendText(chatId, '🔧 *Skills instalados*\n\nNo hay skills instalados.\nInstalá uno desde el panel web o la API.');
        } else {
          const lines = list.map(s => `• \`${s.slug}\` — ${s.name}${s.description ? `\n  _${s.description.slice(0, 80)}_` : ''}`).join('\n');
          await bot.sendText(chatId, `🔧 *Skills instalados* (${list.length})\n\n${lines}`);
        }
        break;
      }

      case 'agentes': {
        const roleAgents = this.agents ? this.agents.list().filter(a => a.prompt) : [];
        if (roleAgents.length === 0) {
          await bot.sendText(chatId,
            `🎭 *Agentes de rol disponibles*\n\nNo hay agentes con prompt configurado.\nCreá uno desde el panel web (botón 🎭) y usalo aquí.`
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

      case 'ayuda': {
        await bot.sendText(chatId,
          `🤖 *Comandos disponibles*\n\n` +
          `*Sesión:*\n/start — saludo e inicio\n/nueva — nueva conversación\n` +
          `/reset — reiniciar sesión\n/compact — compactar contexto\n/bash — nueva sesión bash\n\n` +
          `*Claude Code:*\n/modelo [nombre] — ver/cambiar modelo\n` +
          `/permisos [modo] — ver/cambiar modo (auto/ask/plan)\n` +
          `/costo — costo de la sesión\n/estado — estado detallado\n` +
          `/memoria — ver archivos de memoria\n/dir — directorio de trabajo\n\n` +
          `*Agentes de rol:*\n/agentes — listar\n/<key> — activar\n/basta — desactivar\n\n` +
          `*Skills:*\n/skills — instalados\n/buscar-skill — buscar en ClawHub\n` +
          `/mcps — MCPs configurados\n/buscar-mcp — buscar en Smithery\n\n` +
          `*Recordatorios:*\n/recordar <tiempo> <msg>\n/recordatorios — ver pendientes\n\n` +
          `*Audio:*\n/whisper [modelo|idioma] — ver/cambiar modelo Whisper\n\n` +
          `*Monitor:*\n/consola — modo consola\n/status-vps — CPU, RAM y disco\n\n` +
          `*Bot:*\n/agente [key] — ver/cambiar agente\n/ayuda — esta ayuda`
        );
        break;
      }

      case 'menu': {
        await bot._sendMenu(chatId, msgId);
        break;
      }

      case 'basta_action': {
        chat.activeAgent = null;
        chat.claudeSession = new ClaudePrintSession({ ...bot._claudeSessionOpts(chat), model: null });
        const def = this.getMenuDef('menu:agentes', { bot });
        const text    = typeof def.text    === 'function' ? def.text(chat)    : def.text;
        const rawRows = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
        await bot.sendWithButtons(chatId, text, this._resolveButtons(rawRows, def.back), msgId);
        break;
      }

      case 'compact_action': {
        if (chat.claudeSession) await bot._sendToSession(chatId, '/compact', chat);
        break;
      }

      case 'consolidate_now': {
        if (!this.consolidator) {
          await bot.sendText(chatId, '❌ Consolidador no disponible.');
          break;
        }
        await bot.sendText(chatId, `⚡ Procesando cola… Te aviso cuando termine.`);
        this.consolidator.processQueue().then(() => {
          bot.sendText(chatId, `✅ Cola de consolidación procesada.`).catch(() => {});
        }).catch(err => {
          bot.sendText(chatId, `❌ Error en consolidación: ${err.message}`).catch(() => {});
        });
        break;
      }

      case 'noop':
        break;
    }
  }
}

module.exports = CallbackHandler;
