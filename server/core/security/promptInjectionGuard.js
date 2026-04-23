'use strict';

/**
 * promptInjectionGuard — sanitiza texto que viene de fuentes externas (skills,
 * webfetch, MCPs remotos) antes de inyectarlo al contexto del modelo.
 *
 * El objetivo NO es eliminar todo prompt injection (imposible: cualquier texto
 * puede contener instrucciones). El objetivo es **evitar que el texto escape
 * el wrapper de system-reminder** que el server usa para delimitar contenido
 * untrusted.
 *
 * Ataques cubiertos:
 *   1. Cerrar prematuramente el marcador: un SKILL.md malicioso incluye
 *      `</system-reminder>` en su body → el modelo ve el body como "fuera" del
 *      reminder y interpreta el resto como instrucciones del server.
 *   2. Abrir un marcador nuevo: un webfetch retorna `<system-reminder>hackme</system-reminder>`
 *      → el modelo lo ve como instrucción legítima del harness.
 *   3. Falsos system prompts: `<system-prompt>` y variantes.
 *
 * API:
 *   - `sanitizeExternalText(text, opts?)` → string sin marcadores peligrosos.
 *   - `stripSystemTags(text)` → versión simple sin opts (legacy/ergonomic).
 *
 * Reemplaza los tags con `[system-*]` (sin `<>`) para que sigan siendo legibles
 * pero inertes desde el punto de vista del parsing de Claude.
 */

const SYSTEM_TAG_PATTERN = /<\/?\s*(system-reminder|system-prompt|system|assistant|user)\b[^>]*>/gi;
const CDATA_PATTERN      = /<!\[CDATA\[[\s\S]*?\]\]>/g;

/**
 * Sanitiza texto externo.
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.stripCdata=true]
 * @returns {string}
 */
function sanitizeExternalText(text, opts = {}) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  const stripCdata = opts.stripCdata !== false;

  // Reemplazar tags de system/control con formato `[tag-neutralizado]`
  s = s.replace(SYSTEM_TAG_PATTERN, (match) => {
    // Preservar el nombre del tag pero quitar `<>`, `/`, y atributos
    const name = match.replace(/[<>/]/g, '').trim().split(/\s+/)[0].toLowerCase();
    return `[${name}-neutralizado]`;
  });

  if (stripCdata) s = s.replace(CDATA_PATTERN, '[cdata-neutralizado]');

  return s;
}

/** Atajo sin opts. */
function stripSystemTags(text) {
  return sanitizeExternalText(text);
}

module.exports = { sanitizeExternalText, stripSystemTags };
module.exports._internal = { SYSTEM_TAG_PATTERN, CDATA_PATTERN };
