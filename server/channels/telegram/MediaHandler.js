'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const os   = require('os');

const { tdbg } = require('./utils');

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c',
  'cpp', 'h', 'hpp', 'cs', 'swift', 'php', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'bat', 'cmd', 'sql', 'r', 'lua', 'vim', 'el', 'clj', 'ex', 'exs', 'erl', 'hs',
  'scala', 'dart', 'v', 'zig', 'nim', 'cr', 'ml', 'mli', 'f90', 'jl',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'env', 'gitignore', 'editorconfig',
]);

const MAX_DOC_SIZE = 20 * 1024 * 1024; // 20MB (límite Telegram Bot API)
const MAX_TEXT_READ = 100 * 1024;       // 100KB de texto leído

/**
 * MediaHandler — procesa mensajes de voz/audio, fotos y documentos de Telegram.
 *
 * Patrón: recibe `bot` como primer parámetro (igual que CommandHandler).
 * Después de procesar el media, delega a bot._handleMessage(msg).
 */
class MediaHandler {
  constructor({ transcriber = null, logger = console } = {}) {
    this._transcriber = transcriber;
    this._logger      = logger;
  }

  async handleVoice(bot, msg) {
    const chatId = msg.chat.id;
    if (!bot._isAllowed(chatId, msg.chat.type)) {
      await bot.sendText(chatId, '⛔ No tenés acceso a este bot.', msg.message_id);
      return;
    }
    const fileId   = msg.voice?.file_id || msg.audio?.file_id;
    const duration = msg.voice?.duration || msg.audio?.duration || 0;
    if (duration > 300) {
      await bot.sendText(chatId, '⚠️ El audio es muy largo (máx 5 min).');
      return;
    }
    if (!this._transcriber) {
      await bot.sendText(chatId, '❌ Módulo de transcripción no disponible.');
      return;
    }
    try {
      const fileInfo = await bot._apiCall('getFile', { file_id: fileId });
      const fileUrl  = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
      const tmpFile  = path.join(os.tmpdir(), `clawmint_voice_${Date.now()}.ogg`);
      await this._transcriber.httpsDownload(fileUrl, tmpFile);
      let statusMsg = null;
      try { statusMsg = await bot._apiCall('sendMessage', { chat_id: chatId, text: '🎙️ Transcribiendo audio...' }); } catch {}
      const text = await this._transcriber.transcribe(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (!text || !text.trim()) {
        if (statusMsg) {
          try { await bot._apiCall('editMessageText', { chat_id: chatId, message_id: statusMsg.message_id, text: '⚠️ No se pudo extraer texto del audio.' }); } catch {}
        } else {
          await bot.sendText(chatId, '⚠️ No se pudo extraer texto del audio.');
        }
        return;
      }
      console.log(`[Telegram:${bot.key}] Audio transcrito de ${chatId}: ${text.slice(0, 60)}`);
      if (statusMsg) {
        const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
        try { await bot._apiCall('editMessageText', { chat_id: chatId, message_id: statusMsg.message_id, text: `🎙️ ${preview}` }); } catch {}
      }
      msg.text = text;
      await bot._handleMessage(msg);
    } catch (err) {
      console.error(`[Telegram:${bot.key}] Error procesando audio:`, err.message);
      await bot.sendText(chatId, `❌ Error al procesar audio: ${err.message}`);
    }
  }

  async handlePhoto(bot, msg) {
    const chatId = msg.chat.id;
    if (!bot._isAllowed(chatId, msg.chat.type)) {
      await bot.sendText(chatId, '⛔ No tenés acceso a este bot.', msg.message_id);
      return;
    }
    try {
      const photo    = msg.photo[msg.photo.length - 1];
      const fileInfo = await bot._apiCall('getFile', { file_id: photo.file_id });
      const fileUrl  = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

      const buffer = await new Promise((resolve, reject) => {
        https.get(fileUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, (r2) => {
              const chunks = []; r2.on('data', c => chunks.push(c)); r2.on('end', () => resolve(Buffer.concat(chunks))); r2.on('error', reject);
            }).on('error', reject);
            return;
          }
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
        }).on('error', reject);
      });

      const ext = path.extname(fileInfo.file_path || '').replace('.', '') || 'jpg';
      const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const base64 = buffer.toString('base64');

      console.log(`[Telegram:${bot.key}] Foto recibida de ${chatId}: ${photo.width}x${photo.height}, ${Math.round(buffer.length / 1024)}KB`);

      msg.text = msg.caption || 'Describe esta imagen';
      msg._images = [{ base64, mediaType }];
      await bot._handleMessage(msg);
    } catch (err) {
      const errDetail = err?.message || err?.stack || (err ? JSON.stringify(err) : 'error desconocido');
      console.error(`[Telegram:${bot.key}] Error procesando foto:`, errDetail);
      if (err?.stack) console.error(`[Telegram:${bot.key}] Stack:`, err.stack);
      await bot.sendText(chatId, `❌ Error al procesar la foto: ${errDetail.slice(0, 200)}`);
    }
  }
  async handleDocument(bot, msg) {
    const chatId = msg.chat.id;
    if (!bot._isAllowed(chatId, msg.chat.type)) {
      await bot.sendText(chatId, '⛔ No tenés acceso a este bot.', msg.message_id);
      return;
    }
    const doc = msg.document;
    if (!doc) return;

    if (doc.file_size > MAX_DOC_SIZE) {
      await bot.sendText(chatId, '⚠️ El archivo es demasiado grande (máx 20MB).');
      return;
    }

    const fileName = doc.file_name || 'archivo';
    const ext = path.extname(fileName).replace('.', '').toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
    const isText = TEXT_EXTENSIONS.has(ext) || (doc.mime_type || '').startsWith('text/');

    try {
      const fileInfo = await bot._apiCall('getFile', { file_id: doc.file_id });
      const fileUrl  = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

      const buffer = await new Promise((resolve, reject) => {
        https.get(fileUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, (r2) => {
              const chunks = []; r2.on('data', c => chunks.push(c)); r2.on('end', () => resolve(Buffer.concat(chunks))); r2.on('error', reject);
            }).on('error', reject);
            return;
          }
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
        }).on('error', reject);
      });

      console.log(`[Telegram:${bot.key}] Documento recibido de ${chatId}: ${fileName} (${Math.round(buffer.length / 1024)}KB)`);

      if (isImage) {
        const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        msg.text = msg.caption || 'Describe esta imagen';
        msg._images = [{ base64: buffer.toString('base64'), mediaType }];
        await bot._handleMessage(msg);
        return;
      }

      if (isText) {
        let content = buffer.toString('utf-8');
        const truncated = content.length > MAX_TEXT_READ;
        if (truncated) content = content.slice(0, MAX_TEXT_READ);

        const caption = msg.caption || '';
        const truncNote = truncated ? `\n(archivo truncado a ${Math.round(MAX_TEXT_READ / 1024)}KB)` : '';
        msg.text = `${caption}\n\n📄 Archivo: ${fileName}${truncNote}\n\`\`\`\n${content}\n\`\`\``.trim();
        await bot._handleMessage(msg);
        return;
      }

      // Archivo binario no soportado para lectura directa
      const tmpFile = path.join(os.tmpdir(), `clawmint_doc_${Date.now()}_${fileName}`);
      fs.writeFileSync(tmpFile, buffer);
      msg.text = msg.caption || `Recibí el archivo "${fileName}" (${Math.round(buffer.length / 1024)}KB, tipo: ${doc.mime_type || ext || 'desconocido'}).`;
      msg._files = [{ path: tmpFile, name: fileName, mime: doc.mime_type || 'application/octet-stream', size: buffer.length }];
      await bot._handleMessage(msg);
    } catch (err) {
      console.error(`[Telegram:${bot.key}] Error procesando documento:`, err.message);
      await bot.sendText(chatId, `❌ Error al procesar documento: ${err.message}`);
    }
  }
}

module.exports = MediaHandler;
