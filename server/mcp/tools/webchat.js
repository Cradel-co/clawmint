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
 * Verifica que un non-admin solo opere sobre su propia sesión.
 */
function _checkSessionAccess(sessionId, ctx) {
  if (isAdmin(ctx)) return null;
  if (!ctx.chatId) return 'Error: no se pudo identificar tu sesión. Acceso denegado.';
  if (String(sessionId) !== String(ctx.chatId)) {
    return 'Error: solo podés operar en tu propia sesión.';
  }
  return null;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const webchatListSessions = {
  name: 'webchat_list_sessions',
  description: 'Lista las sesiones WebChat activas con su sessionId, provider y agente.',
  params: {},

  async execute(_args, ctx = {}) {
    if (!isAdmin(ctx)) return 'Error: solo administradores pueden listar todas las sesiones.';
    return _webchatListSessionsImpl();
  },
};

async function _webchatListSessionsImpl() {
  const sessions = await apiGet('/api/webchat/sessions');
  if (!Array.isArray(sessions) || sessions.length === 0) return 'No hay sesiones WebChat activas.';
  const lines = sessions.map(s =>
    `  ${s.sessionId} — provider: ${s.provider}, agente: ${s.agent || '(ninguno)'}, msgs: ${s.messages}, cwd: ${s.cwd}`
  );
  return `Sesiones activas (${sessions.length}):\n${lines.join('\n')}`;
}

const webchatSendMessage = {
  name: 'webchat_send_message',
  description: 'Enviar un mensaje de texto a una sesión WebChat. Soporta botones inline con callbacks dinámicos.',
  params: {
    session_id: 'string — ID de la sesión WebChat destino',
    text: 'string — texto del mensaje',
    'buttons?': '?array — Array de botones: [{ text: "label", callback_data: "/cmd o texto" }]',
    'callbacks?': '?object — Callbacks dinámicos: { "callback_data": { type: "message"|"command"|"prompt", ...params, ttl?, once? } }. ' +
      'type "message": { text } responde con texto. ' +
      'type "command": { cmd, timeout? } ejecuta bash y envía output. ' +
      'type "prompt": { text } envía como prompt al AI activo. ' +
      'ttl: ms de vida (default 300000=5min). once: true para single-use.',
  },

  async execute({ session_id, text, buttons, callbacks }, ctx = {}) {
    if (!session_id || !text) return 'Error: session_id y text son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;
    if (_isNoiseText(text)) return 'Mensaje filtrado (meta-text interno).';

    const parseIfString = (v) => {
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    };

    const body = { text };
    if (buttons) body.buttons = parseIfString(buttons);
    if (callbacks) body.callbacks = parseIfString(callbacks);
    const result = await apiPost(`/api/webchat/sessions/${session_id}/message`, body);
    if (result.error) return `Error: ${result.error}`;
    return `Mensaje enviado a sesión ${session_id.slice(0, 8)}`;
  },
};

const webchatSendPhoto = {
  name: 'webchat_send_photo',
  description: 'Enviar una imagen a una sesión WebChat. La imagen debe existir en disco.',
  params: {
    session_id: 'string — ID de la sesión WebChat destino',
    file_path: 'string — ruta absoluta de la imagen en disco',
    'caption?': '?string — texto debajo de la imagen (opcional)',
  },

  async execute({ session_id, file_path, caption }, ctx = {}) {
    if (!session_id || !file_path) return 'Error: session_id y file_path son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
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
      `/api/webchat/sessions/${session_id}/photo?${qs.toString()}`,
      buffer,
      contentType
    );
    if (result.error) return `Error: ${result.error}`;
    return `Foto enviada a sesión ${session_id.slice(0, 8)} (msgId: ${result.msgId})`;
  },
};

const webchatSendDocument = {
  name: 'webchat_send_document',
  description: 'Enviar un archivo/documento a una sesión WebChat.',
  params: {
    session_id: 'string — ID de la sesión WebChat destino',
    file_path: 'string — ruta absoluta del archivo en disco',
    'caption?': '?string — texto debajo del archivo (opcional)',
  },

  async execute({ session_id, file_path, caption }, ctx = {}) {
    if (!session_id || !file_path) return 'Error: session_id y file_path son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/webchat/sessions/${session_id}/document?${qs.toString()}`,
      buffer,
      'application/octet-stream'
    );
    if (result.error) return `Error: ${result.error}`;
    return `Documento enviado a sesión ${session_id.slice(0, 8)} (msgId: ${result.msgId})`;
  },
};

const webchatEditMessage = {
  name: 'webchat_edit_message',
  description: 'Editar el texto de un mensaje ya enviado en una sesión WebChat.',
  params: {
    session_id: 'string — ID de la sesión WebChat',
    msg_id: 'string — ID del mensaje a editar',
    text: 'string — nuevo texto del mensaje',
  },

  async execute({ session_id, msg_id, text }, ctx = {}) {
    if (!session_id || !msg_id || !text) return 'Error: session_id, msg_id y text son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;

    const result = await apiPost(`/api/webchat/sessions/${session_id}/edit`, { msg_id, text });
    if (result.error) return `Error: ${result.error}`;
    return `Mensaje editado en sesión ${session_id.slice(0, 8)}`;
  },
};

const webchatDeleteMessage = {
  name: 'webchat_delete_message',
  description: 'Borrar un mensaje de una sesión WebChat por su ID.',
  params: {
    session_id: 'string — ID de la sesión WebChat',
    msg_id: 'string — ID del mensaje a borrar',
  },

  async execute({ session_id, msg_id }, ctx = {}) {
    if (!session_id || !msg_id) return 'Error: session_id y msg_id son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;

    const result = await apiPost(`/api/webchat/sessions/${session_id}/delete`, { msg_id });
    if (result.error) return `Error: ${result.error}`;
    return 'Mensaje borrado.';
  },
};

const webchatSendVoice = {
  name: 'webchat_send_voice',
  description: 'Enviar un audio/voz a una sesión WebChat. El archivo debe existir en disco.',
  params: {
    session_id: 'string — ID de la sesión WebChat destino',
    file_path: 'string — ruta absoluta del archivo de audio en disco',
    'caption?': '?string — texto descriptivo (opcional)',
  },

  async execute({ session_id, file_path, caption }, ctx = {}) {
    if (!session_id || !file_path) return 'Error: session_id y file_path son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const ext = file_path.split('.').pop().toLowerCase();
    const mimeMap = { ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4' };
    const contentType = mimeMap[ext] || 'audio/ogg';
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/webchat/sessions/${session_id}/voice?${qs.toString()}`,
      buffer,
      contentType
    );
    if (result.error) return `Error: ${result.error}`;
    return `Audio enviado a sesión ${session_id.slice(0, 8)} (msgId: ${result.msgId})`;
  },
};

const webchatSendVideo = {
  name: 'webchat_send_video',
  description: 'Enviar un video a una sesión WebChat. El archivo debe existir en disco.',
  params: {
    session_id: 'string — ID de la sesión WebChat destino',
    file_path: 'string — ruta absoluta del video en disco',
    'caption?': '?string — texto debajo del video (opcional)',
  },

  async execute({ session_id, file_path, caption }, ctx = {}) {
    if (!session_id || !file_path) return 'Error: session_id y file_path son requeridos.';
    const denied = _checkSessionAccess(session_id, ctx);
    if (denied) return denied;

    if (!fs.existsSync(file_path)) return `Error: archivo no encontrado: ${file_path}`;
    const buffer = fs.readFileSync(file_path);
    const ext = file_path.split('.').pop().toLowerCase();
    const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime' };
    const contentType = mimeMap[ext] || 'video/mp4';
    const filename = file_path.split('/').pop();

    const qs = new URLSearchParams();
    if (caption) qs.set('caption', caption);
    qs.set('filename', filename);

    const result = await apiPost(
      `/api/webchat/sessions/${session_id}/video?${qs.toString()}`,
      buffer,
      contentType
    );
    if (result.error) return `Error: ${result.error}`;
    return `Video enviado a sesión ${session_id.slice(0, 8)} (msgId: ${result.msgId})`;
  },
};

module.exports = [webchatListSessions, webchatSendMessage, webchatSendPhoto, webchatSendDocument, webchatSendVoice, webchatSendVideo, webchatEditMessage, webchatDeleteMessage];
