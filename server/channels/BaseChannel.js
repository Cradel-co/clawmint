'use strict';

/**
 * BaseChannel — interfaz abstracta para canales de mensajería.
 *
 * Implementar start(), stop(), send() y toJSON() en subclases.
 * Permite agregar Discord, HTTP, etc. sin tocar el núcleo.
 */
class BaseChannel {
  /**
   * @param {object} opts
   * @param {object} opts.eventBus - instancia de EventBus
   * @param {object} opts.logger   - instancia de Logger
   */
  constructor({ eventBus, logger } = {}) {
    this.eventBus = eventBus || null;
    this.logger   = logger  || console;
  }

  /** Conectar al proveedor externo (Telegram, Discord, etc.) */
  async start() { throw new Error('start() no implementado'); }

  /** Desconectar limpiamente */
  async stop()  { throw new Error('stop() no implementado'); }

  /**
   * Enviar un mensaje a un destino (chatId, channelId, etc.)
   * @param {string|number} destination
   * @param {string} text
   */
  async send(destination, text) { throw new Error('send() no implementado'); }

  /** Estado serializable (para la API REST) */
  toJSON() { return {}; }
}

module.exports = BaseChannel;
