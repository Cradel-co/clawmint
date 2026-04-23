'use strict';

const http = require('http');
const fs   = require('fs');

const API_BASE = `http://localhost:${process.env.PORT || 3002}`;

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
function _isNoiseText(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length > 300) return false;
  return NOISE_PATTERNS.some(rx => rx.test(t));
}

// Token interno para bypass de auth en requests localhost
let _internalToken = null;
function getInternalToken() {
  if (!_internalToken) {
    _internalToken = require('../../middleware/authMiddleware').INTERNAL_TOKEN;
  }
  return _internalToken;
}

// Helper: HTTP request a la API local
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${path}`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'X-Internal-Token': getInternalToken() },
    };
    http.get(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    }).on('error', reject);
  });
}

function apiPost(path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${path}`);
    const isJson = contentType === 'application/json';
    const data = isJson ? JSON.stringify(body) : body;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(data),
        'X-Internal-Token': getInternalToken(),
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const { isAdmin } = require('./user-sandbox');

/**
 * Verifica que un non-admin solo opere sobre su propio chat.
 * Retorna string de error si no está permitido, o null si OK.
 */
function _checkChatAccess(chatId, ctx) {
  if (isAdmin(ctx)) return null;
  if (!ctx.chatId) return 'Error: no se pudo identificar tu chat. Acceso denegado.';
  if (String(chatId) !== String(ctx.chatId)) {
    return 'Error: solo podés enviar mensajes a tu propio chat.';
  }
  return null;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const telegramListBots = {
  name: 'telegram_list_bots',
  description: 'Lista los bots de Telegram configurados con sus chats activos.',
  params: {},

  async execute() {
    const bots = await apiGet('/api/telegram/bots');
    if (!Array.isArray(bots)) return 'No hay bots configurados.';
    const lines = bots.map(b => {
      const status = b.running ? '🟢' : '🔴';
      const chats = (b.chats || []).map(c =>
        `    chat ${c.chatId} (${c.firstName || c.username || 'sin nombre'})`
      ).join('\n');
      return `${status} ${b.key} (${b.botInfo?.username || '?'})\n${chats || '    (sin chats)'}`;
    });
    return lines.join('\n\n');
  },
};

const telegramSendMessage = {
  name: 'telegram_send_message',
  description: 'Enviar un mensaje de texto a un chat de Telegram. Soporta botones inline con callbacks dinámicos.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat destino',
    text: 'string — texto del mensaje',
    'parse_mode?': '?string — HTML, Markdown o MarkdownV2 (opcional)',
    'reply_markup?': '?object — Telegram reply_markup (inline_keyboard, etc.)',
    'callbacks?': '?object — Callbacks dinámicos: { "callback_data": { type: "message"|"command"|"prompt", ...params, ttl?, once? } }. ' +
      'type "message": { text, parse_mode? } responde con texto. ' +
      'type "command": { cmd, timeout? } ejecuta bash y envía output. ' +
      'type "prompt": { text } envía como prompt al AI activo. ' +
      'ttl: ms de vida (default 300000=5min). once: true para single-use.',
  },

  async execute({ bot, chat_id, text, parse_mode, reply_markup, callbacks }, ctx = {}) {
    if (!bot || !chat_id || !text) return 'Error: bot, chat_id y text son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;
    if (_isNoiseText(text)) return 'Mensaje filtrado (meta-text interno).';
    const bots = await apiGet('/api/telegram/bots');
    const botInfo = Array.isArray(bots) && bots.find(b => b.key === bot);
    if (!botInfo) return `Error: bot "${bot}" no encontrado.`;

    // MCP envía todos los params como strings — parsear JSON si es necesario
    const parseIfString = (v) => {
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    };

    const body = { text, parse_mode };
    if (reply_markup) body.reply_markup = parseIfString(reply_markup);
    if (callbacks) body.callbacks = parseIfString(callbacks);
    const result = await apiPost(`/api/telegram/bots/${bot}/chats/${chat_id}/message`, body);
    if (result.error) return `Error: ${result.error}`;
    return `Mensaje enviado (message_id: ${result.message_id})`;
  },
};

const telegramSendPhoto = {
  name: 'telegram_send_photo',
  description: 'Enviar una imagen a un chat de Telegram. La imagen debe existir en disco.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat destino',
    file_path: 'string — ruta absoluta de la imagen en disco',
    'caption?': '?string — texto debajo de la imagen (opcional)',
  },

  async execute({ bot, chat_id, file_path, caption }, ctx = {}) {
    if (!bot || !chat_id || !file_path) return 'Error: bot, chat_id y file_path son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const ext = file_path.split('.').pop().toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const contentType = mimeMap[ext] || 'image/png';
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/telegram/bots/${bot}/chats/${chat_id}/photo?${qs.toString()}`,
      buffer,
      contentType
    );
    if (result.error) return `Error: ${result.error}`;
    return `Foto enviada (message_id: ${result.message_id})`;
  },
};

const telegramSendDocument = {
  name: 'telegram_send_document',
  description: 'Enviar un archivo/documento a un chat de Telegram.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat destino',
    file_path: 'string — ruta absoluta del archivo en disco',
    'caption?': '?string — texto debajo del archivo (opcional)',
  },

  async execute({ bot, chat_id, file_path, caption }, ctx = {}) {
    if (!bot || !chat_id || !file_path) return 'Error: bot, chat_id y file_path son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/telegram/bots/${bot}/chats/${chat_id}/document?${qs.toString()}`,
      buffer,
      'application/octet-stream'
    );
    if (result.error) return `Error: ${result.error}`;
    return `Documento enviado (message_id: ${result.message_id})`;
  },
};

const telegramSendVoice = {
  name: 'telegram_send_voice',
  description: 'Enviar un audio/voz a un chat de Telegram. El archivo debe existir en disco.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat destino',
    file_path: 'string — ruta absoluta del archivo de audio en disco',
  },

  async execute({ bot, chat_id, file_path }, ctx = {}) {
    if (!bot || !chat_id || !file_path) return 'Error: bot, chat_id y file_path son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);

    const result = await apiPost(
      `/api/telegram/bots/${bot}/chats/${chat_id}/voice`,
      buffer,
      'audio/ogg'
    );
    if (result.error) return `Error: ${result.error}`;
    return `Audio enviado (message_id: ${result.message_id})`;
  },
};

const telegramSendVideo = {
  name: 'telegram_send_video',
  description: 'Enviar un video a un chat de Telegram. El archivo debe existir en disco.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat destino',
    file_path: 'string — ruta absoluta del video en disco',
    'caption?': '?string — texto debajo del video (opcional)',
  },

  async execute({ bot, chat_id, file_path, caption }, ctx = {}) {
    if (!bot || !chat_id || !file_path) return 'Error: bot, chat_id y file_path son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/telegram/bots/${bot}/chats/${chat_id}/video?${qs.toString()}`,
      buffer,
      'video/mp4'
    );
    if (result.error) return `Error: ${result.error}`;
    return `Video enviado (message_id: ${result.message_id})`;
  },
};

const telegramEditMessage = {
  name: 'telegram_edit_message',
  description: 'Editar el texto de un mensaje ya enviado en Telegram.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat',
    message_id: 'string — ID del mensaje a editar',
    text: 'string — nuevo texto del mensaje',
    'parse_mode?': '?string — HTML, Markdown o MarkdownV2 (opcional)',
  },

  async execute({ bot, chat_id, message_id, text, parse_mode }, ctx = {}) {
    if (!bot || !chat_id || !message_id || !text) return 'Error: bot, chat_id, message_id y text son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    const body = { message_id: Number(message_id), text };
    if (parse_mode) body.parse_mode = parse_mode;
    const result = await apiPost(`/api/telegram/bots/${bot}/chats/${chat_id}/edit`, body);
    if (result.error) return `Error: ${result.error}`;
    return `Mensaje editado (message_id: ${result.message_id})`;
  },
};

const telegramDeleteMessage = {
  name: 'telegram_delete_message',
  description: 'Borrar un mensaje de Telegram por su ID.',
  params: {
    bot: 'string — key del bot (ej: chibi2026_bot)',
    chat_id: 'string — ID del chat',
    message_id: 'string — ID del mensaje a borrar',
  },

  async execute({ bot, chat_id, message_id }, ctx = {}) {
    if (!bot || !chat_id || !message_id) return 'Error: bot, chat_id y message_id son requeridos.';
    const denied = _checkChatAccess(chat_id, ctx);
    if (denied) return denied;

    const result = await apiPost(`/api/telegram/bots/${bot}/chats/${chat_id}/delete`, { message_id: Number(message_id) });
    if (result.error) return `Error: ${result.error}`;
    return 'Mensaje borrado.';
  },
};

module.exports = [telegramListBots, telegramSendMessage, telegramSendPhoto, telegramSendDocument, telegramSendVoice, telegramSendVideo, telegramEditMessage, telegramDeleteMessage];
