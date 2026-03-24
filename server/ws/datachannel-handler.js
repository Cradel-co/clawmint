'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Factory para startAISessionForDataChannel — sesión AI sobre DataChannel (nodriza P2P).
 * Reutiliza CommandHandler + CallbackHandler de Telegram via P2PBotAdapter.
 *
 * @param {Object} deps - Bootstrap container con todos los módulos
 * @param {Object} deps.providerConfig
 * @param {Object} deps.logger
 * @returns {Function} startAISessionForDataChannel(dcAdapter, peerId)
 */
function createDataChannelHandler({ providerConfig, logger }) {

  function startAISessionForDataChannel(dcAdapter, peerId) {
    logger.info(`[nodriza] Sesión AI P2P iniciada con peer ${peerId}`);

    const { createContainer } = require('../bootstrap');
    const container = createContainer();
    const P2PBotAdapter = require('../channels/p2p/P2PBotAdapter');
    const CommandHandler = require('../channels/telegram/CommandHandler');
    const CallbackHandler = require('../channels/telegram/CallbackHandler');

    // Estado del chat (similar a chat de Telegram)
    const chat = {
      chatId: peerId,
      firstName: 'peer',
      claudeSession: null,
      activeAgent: null,
      pendingAction: null,
      provider: providerConfig.getConfig().default || 'claude-code',
      model: null,
      claudeMode: 'auto',
      aiHistory: [],
      monitorCwd: process.env.HOME || process.cwd(),
      consoleMode: false,
      busy: false,
      _savedInSession: [],
    };

    let initialized = false;

    function send(data) {
      dcAdapter.send(JSON.stringify(data));
    }

    // Registrar peer en CritterRegistry para control remoto del PC
    const critterRegistry = require('../mcp/tools/critter-registry');
    critterRegistry.register(peerId, send);

    // Crear handlers con las mismas deps que Telegram
    const cbHandler = new CallbackHandler({
      agents: container.agents,
      skills: container.skills,
      memory: container.memory,
      reminders: container.reminders,
      mcps: container.mcps,
      consolidator: container.consolidator,
      providers: container.providers,
      providerConfig: container.providerConfig,
      chatSettings: container.chatSettingsRepo,
      transcriber: container.transcriber,
      tts: container.tts,
      voiceProviders: container.voiceProviders,
      ttsConfig: container.ttsConfig,
      logger,
    });

    const cmdHandler = new CommandHandler({
      agents: container.agents,
      skills: container.skills,
      memory: container.memory,
      reminders: container.reminders,
      mcps: container.mcps,
      consolidator: container.consolidator,
      sessionManager: container.sessionManager,
      providers: container.providers,
      providerConfig: container.providerConfig,
      transcriber: container.transcriber,
      tts: container.tts,
      chatSettings: container.chatSettingsRepo,
      logger,
    });

    const botAdapter = new P2PBotAdapter({
      send,
      chat,
      container,
      callbackHandler: cbHandler,
    });

    dcAdapter.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        // Action results del critter
        if (msg.type === 'action_result') {
          critterRegistry.handleResult(peerId, msg.id, msg.result);
          return;
        }
        if (msg.type === 'action_error') {
          critterRegistry.handleError(peerId, msg.id, msg.error);
          return;
        }

        // Init
        if (msg.type === 'init' && !initialized) {
          initialized = true;
          if (msg.provider) chat.provider = msg.provider;
          if (msg.agentKey) chat.activeAgent = { key: msg.agentKey, prompt: '' };
          if (msg.model) chat.model = msg.model;

          const sessionId = crypto.randomUUID();
          send({ type: 'session_id', id: sessionId });
          logger.info(`[nodriza] P2P sesión ${sessionId} con provider ${chat.provider}`);
          return;
        }

        // Callback de botón
        if (msg.type === 'callback' && initialized) {
          handleCallback(msg.data);
          return;
        }

        // Audio para transcripción remota
        if (msg.type === 'audio' && initialized && !chat.busy) {
          handleAudio(msg.data, msg.format);
          return;
        }

        // Input de texto
        if (msg.type === 'input' && initialized && !chat.busy) {
          handleTextInput(msg.data);
        }
      } catch (e) {
        logger.error('[nodriza] Mensaje P2P inválido:', e.message);
      }
    });

    async function handleTextInput(text) {
      if (!text?.trim()) return;

      // Comandos /
      if (text.startsWith('/')) {
        const parts = text.slice(1).split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);

        // Crear msg fake compatible con CommandHandler
        const fakeMsg = { chat: { id: peerId }, from: { first_name: 'peer' } };

        try {
          await cmdHandler.handle(botAdapter, fakeMsg, cmd, args, chat);
        } catch (err) {
          logger.error(`[nodriza] Error en comando /${cmd}:`, err.message);
          send({ type: 'output', data: `Error: ${err.message}` });
          send({ type: 'exit' });
        }
        return;
      }

      // Texto normal → ConversationService
      await botAdapter._sendToSession(peerId, text, chat);
    }

    async function handleCallback(callbackData) {
      // Crear callback query fake compatible con CallbackHandler
      const fakeCbq = {
        id: crypto.randomUUID(),
        data: callbackData,
        message: { chat: { id: peerId }, message_id: 0 },
        from: { id: peerId, first_name: 'peer' },
      };

      try {
        await cbHandler.handle(botAdapter, fakeCbq, chat);
      } catch (err) {
        logger.error(`[nodriza] Error en callback ${callbackData}:`, err.message);
        send({ type: 'output', data: `Error: ${err.message}` });
        send({ type: 'exit' });
      }
    }

    async function handleAudio(base64Data, format) {
      logger.info(`[nodriza] Audio recibido de peer ${peerId} (${base64Data?.length || 0} chars, format: ${format || 'unknown'})`);
      try {
        const transcriber = container.transcriber;
        if (!transcriber) {
          send({ type: 'output', data: 'Error: transcriber no disponible en el server' });
          send({ type: 'exit' });
          return;
        }

        let text;

        if (format === 'pcm_f32_16k') {
          // PCM Float32 16kHz directo — pasar al pipeline sin decodificar
          const buffer = Buffer.from(base64Data, 'base64');
          const pcm = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
          logger.info(`[nodriza] PCM recibido: ${pcm.length} muestras (${(pcm.length / 16000).toFixed(1)}s)`);
          text = await transcriber.transcribePCM(pcm);
        } else {
          // Formato archivo (webm, ogg) — guardar y transcribir
          const raw = base64Data.replace(/^data:[^;]+;base64,/, '');
          const buffer = Buffer.from(raw, 'base64');
          const ext = format === 'ogg' ? '.ogg' : '.webm';
          const tmpFile = path.join(require('os').tmpdir(), `p2p_voice_${Date.now()}${ext}`);
          fs.writeFileSync(tmpFile, buffer);
          text = await transcriber.transcribe(tmpFile);
          try { fs.unlinkSync(tmpFile); } catch {}
        }

        if (text?.trim()) {
          await handleTextInput(text);
        } else {
          send({ type: 'output', data: '🎤 (no se detectó audio)' });
          send({ type: 'exit' });
        }
      } catch (err) {
        logger.error(`[nodriza] Error transcribiendo audio:`, err.message);
        send({ type: 'output', data: `Error transcripción: ${err.message}` });
        send({ type: 'exit' });
      }
    }

    // TODO: _pcmToWav could be extracted to a shared utility module (e.g. audio-utils.js)
    /** Convierte PCM Float32 a Buffer WAV */
    function _pcmToWav(pcm, sampleRate) {
      const numSamples = pcm.length;
      const bytesPerSample = 2; // 16-bit
      const dataSize = numSamples * bytesPerSample;
      const buffer = Buffer.alloc(44 + dataSize);

      // WAV header
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16);       // fmt chunk size
      buffer.writeUInt16LE(1, 20);        // PCM format
      buffer.writeUInt16LE(1, 22);        // mono
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
      buffer.writeUInt16LE(bytesPerSample, 32);
      buffer.writeUInt16LE(16, 34);       // bits per sample
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      // Float32 → Int16
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, 44 + i * 2);
      }

      return buffer;
    }

    dcAdapter.on('close', () => {
      critterRegistry.unregister(peerId);
      logger.info(`[nodriza] DataChannel cerrado con peer ${peerId}`);
    });
  }

  return startAISessionForDataChannel;
}

module.exports = createDataChannelHandler;
