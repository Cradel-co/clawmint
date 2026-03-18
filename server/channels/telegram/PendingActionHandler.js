'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * PendingActionHandler — maneja flujos multi-paso pendientes en un chat.
 *
 * Depende de:
 *   - skills: para búsqueda e instalación de skills (ClawHub)
 *   - mcps: para búsqueda e instalación de MCPs (Smithery); puede ser null
 *   - logger: opcional
 */
class PendingActionHandler {
  constructor({ skills, mcps = null, logger = console }) {
    this.skills = skills;
    this.mcps   = mcps;
    this.logger = logger;
  }

  /**
   * @param {object} bot      - instancia de TelegramBot (para sendText)
   * @param {object} msg      - mensaje de Telegram
   * @param {string} text     - texto del mensaje (ya procesado)
   * @param {object} chat     - estado del chat
   */
  async handle(bot, msg, text, chat) {
    const chatId = msg.chat.id;
    const action = chat.pendingAction;

    // Whitelist: agregar ID
    if (action.type === 'whitelist-add') {
      const newId = parseInt(text.trim(), 10);
      if (isNaN(newId)) {
        await bot.sendText(chatId, '❌ ID inválido. Tiene que ser un número. Usá /cancelar para cancelar.');
        return;
      }
      chat.pendingAction = null;
      if (!bot.whitelist.includes(newId)) {
        bot.whitelist.push(newId);
        bot._onOffsetSave();
        await bot.sendText(chatId, `✅ \`${newId}\` agregado a la lista blanca.`);
      } else {
        await bot.sendText(chatId, `ℹ️ \`${newId}\` ya estaba en la lista blanca.`);
      }
      return;
    }

    // Paso 1: usuario describió su necesidad → buscar en ClawHub
    if (action.type === 'skill-search') {
      chat.pendingAction = null;
      await bot.sendText(chatId, '🔍 Buscando en ClawHub...');
      try {
        const results = await this.skills.searchClawHub(text);
        if (!results.length) {
          await bot.sendText(chatId,
            `😕 No encontré skills para "${text}".\n\nProbá con otras palabras o visitá clawhub.ai`
          );
          return;
        }
        const lines = results.map((r, i) =>
          `${i + 1}. \`${r.slug}\` — *${r.name}*\n   _${r.description.slice(0, 90)}_`
        ).join('\n\n');
        await bot.sendText(chatId,
          `🔍 *Encontré ${results.length} skill(s) para "${text}":*\n\n${lines}\n\n` +
          `Respondé con el *número* para instalar, o /cancelar.`
        );
        chat.pendingAction = { type: 'skill-select', results };
      } catch (err) {
        await bot.sendText(chatId, `⚠️ Error buscando en ClawHub: ${err.message}`);
      }
      return;
    }

    // Paso 2: usuario eligió un número → instalar skill
    if (action.type === 'skill-select') {
      const n = parseInt(text.trim(), 10);
      const results = action.results || [];
      if (isNaN(n) || n < 1 || n > results.length) {
        await bot.sendText(chatId,
          `❌ Número inválido. Respondé entre 1 y ${results.length}, o usá /cancelar.`
        );
        return;
      }
      const chosen = results[n - 1];
      chat.pendingAction = null;
      await bot.sendText(chatId, `📦 Instalando \`${chosen.slug}\`...`);
      try {
        const dir = path.join(this.skills.SKILLS_DIR, chosen.slug);
        const resp = await fetch(
          `https://clawhub.ai/api/v1/skills/${chosen.slug}/file?path=SKILL.md`
        );
        if (!resp.ok) throw new Error(`ClawHub respondió ${resp.status}`);
        const content = await resp.text();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
        await bot.sendText(chatId,
          `✅ Skill *${chosen.name}* instalado correctamente.\n` +
          `Slug: \`${chosen.slug}\`\n\n` +
          `Se inyectará en todos los agentes. Usá /skills para ver los instalados.`
        );
      } catch (err) {
        await bot.sendText(chatId, `⚠️ Error instalando \`${chosen.slug}\`: ${err.message}`);
      }
      return;
    }

    // ── MCP: paso 1 → buscar en smithery
    if (action.type === 'mcp-search') {
      chat.pendingAction = null;
      if (!this.mcps) {
        await bot.sendText(chatId, '❌ Módulo MCPs no disponible.'); return;
      }
      await bot.sendText(chatId, `🔍 Buscando MCPs para "${text}"...`);
      try {
        const results = await this.mcps.searchSmithery(text);
        if (!results.length) {
          await bot.sendText(chatId,
            `😕 No encontré MCPs para "${text}".\n\nProbá con otras palabras o visitá smithery.ai`
          );
          return;
        }
        const lines = results.map((r, i) =>
          `${i + 1}. \`${r.qualifiedName}\` — *${r.displayName}*\n   _${r.description.slice(0, 90)}_\n   ${r.remote ? '🌐 HTTP/remoto' : '📦 local (stdio)'}`
        ).join('\n\n');
        await bot.sendText(chatId,
          `🔌 *Encontré ${results.length} MCP(s) para "${text}":*\n\n${lines}\n\n` +
          `Respondé con el *número* para instalar, o /cancelar.`
        );
        chat.pendingAction = { type: 'mcp-select', results };
      } catch (err) {
        await bot.sendText(chatId, `⚠️ Error buscando en Smithery: ${err.message}`);
      }
      return;
    }

    // ── MCP: paso 2 → instalar el elegido
    if (action.type === 'mcp-select') {
      const n = parseInt(text.trim(), 10);
      const results = action.results || [];
      if (isNaN(n) || n < 1 || n > results.length) {
        await bot.sendText(chatId,
          `❌ Número inválido. Respondé entre 1 y ${results.length}, o usá /cancelar.`
        );
        return;
      }
      if (!this.mcps) {
        await bot.sendText(chatId, '❌ Módulo MCPs no disponible.'); return;
      }
      const chosen = results[n - 1];
      chat.pendingAction = null;
      await bot.sendText(chatId, `🔌 Instalando *${chosen.displayName}* (\`${chosen.qualifiedName}\`)...`);
      try {
        const { mcp, envVarsRequired } = await this.mcps.installFromRegistry(chosen.qualifiedName);
        let msgText = `✅ *${chosen.displayName}* instalado y activado.\n` +
          `Nombre: \`${mcp.name}\`\n` +
          `Tipo: \`${mcp.type}\`\n`;
        if (mcp.url) msgText += `URL: \`${mcp.url.slice(0, 60)}\`\n`;
        if (envVarsRequired.length) {
          msgText += `\n⚠️ *Variables de entorno necesarias:*\n` +
            envVarsRequired.map(v => `• \`${v}\``).join('\n') +
            `\n\nConfiguralas en el MCP desde el panel web.`;
        }
        msgText += `\n\nUsá /mcps para ver los MCPs instalados.`;
        await bot.sendText(chatId, msgText);
      } catch (err) {
        await bot.sendText(chatId, `⚠️ Error instalando \`${chosen.qualifiedName}\`: ${err.message}`);
      }
      return;
    }
  }
}

module.exports = PendingActionHandler;
