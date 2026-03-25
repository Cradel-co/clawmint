'use strict';

const ConsoleSession = require('../../core/ConsoleSession');

// ── ConsoleHandler (métodos estáticos de modo consola) ───────────────────────

const ConsoleHandler = {

  getSession(chat) {
    if (!chat._consoleSession) {
      chat._consoleSession = new ConsoleSession(chat.monitorCwd);
    }
    return chat._consoleSession;
  },

  async sendPrompt(bot, chatId, output, chat) {
    const session  = ConsoleHandler.getSession(chat);
    const cwdShort = session.getCwdShort();
    const text     = `${output ? output + '\n\n' : ''}📁 \`${cwdShort}\``;
    const rawBtns  = session.getPromptButtons();
    const buttons  = rawBtns.map(row =>
      row.map(b => ({ text: b.text, callback_data: `console:${b.command}` }))
    );
    await bot.sendWithButtons(chatId, text.slice(0, 4090), buttons);
  },

  async handle(bot, chatId, command, chat) {
    const trimmed = (command || '').trim();
    if (!trimmed) return;

    const session = ConsoleHandler.getSession(chat);

    if (session.isExitCommand(trimmed)) {
      chat.consoleMode = false;
      chat._consoleSession = null;
      await bot.sendWithButtons(chatId, '🖥️ Modo consola *desactivado*.',
        [[{ text: '🖥️ Monitor', callback_data: 'menu:monitor' },
          { text: '🤖 Menú',    callback_data: 'menu' }]]);
      return;
    }

    if (session.isCdCommand(trimmed)) {
      const target = trimmed.slice(2).trim();
      const result = session.changeDirectory(target);
      chat.monitorCwd = session.cwd;
      if (chat.claudeSession) chat.claudeSession.cwd = session.cwd;
      if (bot._chatSettings) bot._chatSettings.saveCwd(bot.key, chatId, session.cwd);
      const msg = result.ok ? '' : `❌ cd: ${result.error}`;
      await ConsoleHandler.sendPrompt(bot, chatId, msg, chat);
      return;
    }

    try {
      const { stdout, stderr, code } = await session.executeCommand(trimmed);
      const out = session.formatOutput(trimmed, stdout, stderr, code);
      await ConsoleHandler.sendPrompt(bot, chatId, out, chat);
    } catch (err) {
      await ConsoleHandler.sendPrompt(bot, chatId, `❌ Error: ${err.message}`, chat);
    }
  },
};

module.exports = ConsoleHandler;
