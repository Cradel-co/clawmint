'use strict';

/**
 * WebSocket PTY handler — gestiona conexiones WS para sesiones PTY, listener y webchat.
 *
 * @param {Object} deps
 * @param {import('ws').WebSocketServer} deps.wss
 * @param {Object} deps.sessionManager
 * @param {Object} deps.webChannel
 * @param {Set} deps.allWebClients
 * @param {Function} deps.startAISession
 * @param {Object} deps.events
 * @param {Object} [deps.telegramUIHandler]
 */
function setupPtyHandler({ wss, sessionManager, webChannel, allWebClients, startAISession, events, telegramUIHandler, authService }) {

  wss.on('connection', (ws) => {
    console.log('Cliente WS conectado');
    allWebClients.add(ws);

    let session = null;    // PtySession (puede ser null si es claude-api)
    let initialized = false;

    const initTimeout = setTimeout(() => {
      if (!initialized) {
        initialized = true;
        session = sessionManager.create({});
        ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
        attachWsToSession(ws, session);
      }
    }, 500);

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === 'init' && !initialized) {
          clearTimeout(initTimeout);
          initialized = true;

          // Listener puro: solo recibe broadcasts, sin PTY
          if (msg.sessionType === 'listener') {
            return;
          }

          if (msg.sessionType === 'telegram-ui') {
            if (telegramUIHandler) {
              telegramUIHandler.handleConnection(ws, msg);
            } else {
              ws.send(JSON.stringify({ type: 'error', error: 'TelegramUIHandler no disponible' }));
            }
            return;
          }

          if (msg.sessionType === 'webchat') {
            if (webChannel) {
              webChannel.handleConnection(ws, msg);
            } else {
              ws.send(JSON.stringify({ type: 'chat_error', error: 'WebChannel no disponible' }));
            }
            return;
          }

          if (msg.sessionType === 'claude' || msg.sessionType === 'ai') {
            // Sesión AI (sin PTY, acoplada al WS)
            startAISession(ws, msg);
            return;
          }

          // Adjuntarse a sesión existente o crear nueva
          if (msg.sessionId) {
            const existing = sessionManager.get(msg.sessionId);
            if (existing) {
              session = existing;
              ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
              attachWsToSession(ws, session);
              return;
            }
          }

          session = sessionManager.create({
            type: 'pty',
            command: msg.command || null,
            cols: msg.cols || 80,
            rows: msg.rows || 24,
          });

          ws.send(JSON.stringify({ type: 'session_id', id: session.id }));
          attachWsToSession(ws, session);
          return;
        }

        if (msg.type === 'input' && session) {
          session.input(msg.data);
        } else if (msg.type === 'resize' && session) {
          session.resize(msg.cols, msg.rows);
        }
      } catch (e) {
        console.error('Mensaje WS inválido:', e);
      }
    });

    ws.on('close', () => {
      // La sesión NO se destruye al cerrar WS: persiste para uso HTTP
      console.log('Cliente WS desconectado — sesión persiste');
      allWebClients.delete(ws);
      clearTimeout(initTimeout);
    });
  });
}

/** Conecta un WebSocket a una PtySession existente */
function attachWsToSession(ws, session) {
  // Enviar historial acumulado si hay algo
  const past = session.getOutputSince(0);
  if (past) {
    ws.send(JSON.stringify({ type: 'output', data: past }));
  }

  const unsub = session.onOutput((data, event) => {
    if (!ws || ws.readyState !== ws.OPEN) { unsub(); return; }
    if (event === 'exit') {
      ws.send(JSON.stringify({ type: 'exit' }));
    } else {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ws.on('close', unsub);
}

module.exports = setupPtyHandler;
