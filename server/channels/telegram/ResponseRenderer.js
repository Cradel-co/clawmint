'use strict';

const { cleanPtyOutput, chunkText, tdbg } = require('./utils');
const parseButtons = require('../parseButtons');

/**
 * ResponseRenderer — animación de status y envío de resultados al chat.
 *
 * Extraído de TelegramBot._startDotAnimation y _sendResult.
 */
// Patrones de texto meta/interno que la IA genera pero no deben enviarse al usuario
const NOISE_PATTERNS = [
  /^no\s+response\s+(requested|needed|required)/i,
  /^continue\s+from\s+where\s+you\s+left/i,
  /^waiting\s+for\s+(the\s+)?user/i,
  /^no\s+action\s+(needed|required|necessary)/i,
  /^nothing\s+(else\s+)?to\s+(do|say|add|respond)/i,
  /^the\s+(user\s+)?(was|has\s+been)\s+(notified|informed)/i,
  /^message\s+sent\s+(successfully|to\s+the\s+user)/i,
  /^already\s+(sent|responded|replied)/i,
  /^(i('ve| have)|the\s+)?\s*(response|message|answer)\s+(was\s+)?(already\s+)?sent/i,
];

function isNoiseText(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length > 300) return false;
  return NOISE_PATTERNS.some(rx => rx.test(t));
}

class ResponseRenderer {
  async startDotAnimation(bot, chatId, mode = 'ask') {
    const modeLabels = { ask: 'ask', plan: 'plan-mode', auto: 'auto-accept' };
    const label = modeLabels[mode] || mode;
    let sentMsg = null;
    try { sentMsg = await bot._apiCall('sendMessage', { chat_id: chatId, text: label + '.' }); } catch {}
    if (!sentMsg) return { sentMsg: null, stop: () => {} };

    let dotCount = 1, dotDir = 1, stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      dotCount += dotDir;
      if (dotCount >= 3) { dotCount = 3; dotDir = -1; }
      else if (dotCount <= 1) { dotCount = 1; dotDir = 1; }
      try {
        await bot._apiCall('editMessageText', {
          chat_id: chatId, message_id: sentMsg.message_id,
          text: label + '.'.repeat(dotCount),
        });
      } catch {}
    }, 1000);

    const stop = () => { stopped = true; clearInterval(interval); };
    return { sentMsg, stop };
  }

  async sendResult(bot, chatId, text, sentMsg) {
    const { text: parsedText, buttons } = parseButtons(text || '');

    const finalText = cleanPtyOutput(parsedText).trim();
    tdbg('result', `chatId=${chatId} rawLen=${(text||'').length} cleanLen=${finalText.length} hasSentMsg=${!!sentMsg} hasButtons=${!!buttons}`);
    if (!finalText && !buttons) { tdbg('result', `SKIP — finalText vacío`); return; }
    if (isNoiseText(finalText)) { tdbg('result', `SKIP — noise: "${finalText.slice(0, 60)}"`); return; }

    const chunks = chunkText(finalText, 4096);
    const lastIdx = chunks.length - 1;
    tdbg('result', `${chunks.length} chunk(s), first=${chunks[0]?.slice(0, 80)}`);

    if (sentMsg) {
      if (chunks.length === 1) {
        tdbg('result', `editando msg ${sentMsg.message_id}`);
        try {
          if (buttons) {
            await bot.sendWithButtons(chatId, chunks[0], buttons, sentMsg.message_id);
          } else {
            await bot._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: chunks[0] });
          }
        } catch (e) {
          tdbg('result', `editMsg FAIL: ${e.message}`);
          if (!e.message?.includes('message is not modified')) await bot.sendText(chatId, chunks[0]);
        }
      } else {
        try {
          await bot._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: chunks[0] });
        } catch (e) {
          tdbg('result', `editMsg FAIL: ${e.message}`);
          if (!e.message?.includes('message is not modified')) await bot.sendText(chatId, chunks[0]);
        }
        for (let i = 1; i < lastIdx; i++) await bot.sendText(chatId, chunks[i]);
        if (buttons) {
          await bot.sendWithButtons(chatId, chunks[lastIdx], buttons);
        } else {
          await bot.sendText(chatId, chunks[lastIdx]);
        }
      }
    } else {
      tdbg('result', `enviando ${chunks.length} chunk(s) como mensajes nuevos`);
      if (buttons && chunks.length === 1) {
        await bot.sendWithButtons(chatId, chunks[0], buttons);
      } else {
        for (let i = 0; i < lastIdx; i++) await bot.sendText(chatId, chunks[i]);
        if (buttons) {
          await bot.sendWithButtons(chatId, chunks[lastIdx], buttons);
        } else {
          await bot.sendText(chatId, chunks[lastIdx]);
        }
      }
    }
    tdbg('result', `OK`);
  }
}

module.exports = ResponseRenderer;
