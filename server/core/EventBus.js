'use strict';

const EventEmitter = require('events');

/**
 * EventBus: thin wrapper sobre EventEmitter.
 * Reemplaza el singleton events.js con una instancia inyectable.
 */
class EventBus extends EventEmitter {}

module.exports = EventBus;
