'use strict';

/**
 * outputCaps — caps de tamaño de output para tools (Fase 7.5.6).
 *
 * Motivación: valores de Claude Code son mucho más conservadores que nuestros defaults actuales.
 * Bash en Fase 3 tiene ring buffer de 2MB (OOM protection), pero lo que se envía al modelo
 * debería estar capado a 30KB por default — de lo contrario, un solo `ls -laR` puede quemar
 * 50k+ tokens en una sola respuesta.
 *
 * Este módulo no cambia el ring buffer (sigue 2MB para evitar OOM de procesos runaway);
 * agrega una capa de truncado final antes de devolver al modelo.
 *
 * Env vars (rollback seguro a comportamiento pre-Fase-7.5.6):
 *   BASH_MAX_OUTPUT_LENGTH=30000      — default, truncado que recibe el modelo
 *   BASH_MAX_OUTPUT_UPPER_LIMIT=150000 — tope absoluto que puede pedir el caller
 *   GREP_HEAD_LIMIT_DEFAULT=250       — resultados default de grep
 *   OUTPUT_CAPS_ENABLED=true          — master switch; false restaura sin truncado adicional
 */

const DEFAULTS = Object.freeze({
  bashMaxOutput:     30_000,
  bashUpperLimit:    150_000,
  grepHeadLimitDefault: 250,
});

function _intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isEnabled() {
  return process.env.OUTPUT_CAPS_ENABLED !== 'false';
}

function bashMaxOutputLength() {
  return _intEnv('BASH_MAX_OUTPUT_LENGTH', DEFAULTS.bashMaxOutput);
}

function bashUpperLimit() {
  return _intEnv('BASH_MAX_OUTPUT_UPPER_LIMIT', DEFAULTS.bashUpperLimit);
}

function grepHeadLimitDefault() {
  return _intEnv('GREP_HEAD_LIMIT_DEFAULT', DEFAULTS.grepHeadLimitDefault);
}

/**
 * Aplica truncado a un output de bash/pty si excede el cap.
 * No toca el output si caps están deshabilitados.
 *
 * @param {string} output
 * @param {object} [opts]
 * @param {number} [opts.maxLength]    — override del cap para este caller
 * @returns {string} output posiblemente truncado con prefix de aviso
 */
function truncateBashOutput(output, opts = {}) {
  if (!isEnabled() || typeof output !== 'string') return output;

  const cap = Math.min(
    opts.maxLength || bashMaxOutputLength(),
    bashUpperLimit()
  );
  if (output.length <= cap) return output;

  const droppedBytes = output.length - cap;
  const preserved = output.slice(-cap); // preservar el final (más informativo)
  return `[truncado ${droppedBytes} bytes — mostrando últimos ${cap} bytes / cap BASH_MAX_OUTPUT_LENGTH]\n${preserved}`;
}

module.exports = {
  DEFAULTS,
  isEnabled,
  bashMaxOutputLength,
  bashUpperLimit,
  grepHeadLimitDefault,
  truncateBashOutput,
};
