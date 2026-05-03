'use strict';

/**
 * slashCommandParser — detecta `/slug [resto]` en mensajes de usuario y lo
 * resuelve contra skills disponibles.
 *
 * NO toca channels individuales. Se usa como middleware en
 * `ConversationService.processMessage` para que una sola impl sirva a
 * telegram/webchat/p2p.
 *
 * Contrato:
 *   parse(text, { skills, agentKey }) → { text, injected? }
 *
 * Donde:
 *   - `text`: texto modificado (sin /slug si fue consumido)
 *   - `injected`: bloque <system-reminder> con el body del skill invocado, o null
 *
 * Reglas:
 *   - Solo dispara si `text` empieza con `^/` seguido de slug alfanumérico (+ `-_`).
 *   - Si el slug NO existe como skill, el texto pasa tal cual (sin inyectar).
 *     Esto preserva comportamiento actual: `/comando` raro va al modelo que decide.
 *   - El body del skill se sanitiza via `promptInjectionGuard` para evitar nested
 *     system-reminder escaping.
 */

const { sanitizeExternalText } = require('./security/promptInjectionGuard');

const SLASH_RE = /^\/([a-zA-Z0-9][a-zA-Z0-9_\-]*)(?:\s+([\s\S]*))?$/;

/**
 * @param {string} text
 * @param {object} opts
 * @param {object} opts.skills  — módulo skills.js con listSkills/parseFrontmatter
 * @returns {{ text: string, injected: string|null, slug: string|null }}
 */
function parseSlashCommand(text, { skills } = {}) {
  if (!text || typeof text !== 'string') return { text, injected: null, slug: null };
  if (!skills || typeof skills.listSkills !== 'function') return { text, injected: null, slug: null };

  const trimmed = text.trimStart();
  const match = trimmed.match(SLASH_RE);
  if (!match) return { text, injected: null, slug: null };

  const slug = match[1];
  const rest = (match[2] || '').trim();

  // Resolver skill por slug
  const availableSkills = skills.listSkills();
  const skill = availableSkills.find(s => s.slug === slug);
  if (!skill) {
    // No es un skill conocido — dejar pasar (puede ser /help de canal, /cmd random que el modelo ve)
    return { text, injected: null, slug: null };
  }

  // Leer body del skill desde filesystem
  const path = require('path');
  const fs = require('fs');
  const bodyPath = path.join(skills.SKILLS_DIR || '', slug, 'SKILL.md');
  let body = '';
  try {
    const raw = fs.readFileSync(bodyPath, 'utf8');
    const parsed = skills.parseFrontmatter
      ? skills.parseFrontmatter(raw)
      : { body: raw };
    body = parsed.body || '';
  } catch { /* skill sin body → aún devolvemos injected vacío para loguear la invocación */ }

  const safeBody = sanitizeExternalText(body.trim());
  const restSan = rest ? sanitizeExternalText(rest) : '';
  const inputLine = restSan ? `\n\nInput del usuario: ${restSan}` : '';
  const injected = `<system-reminder source="slash-command:${slug}">\n${safeBody}${inputLine}\n</system-reminder>`;

  // Stripear el /slug del texto original. Si había "resto" se preserva para que
  // el modelo lo vea como mensaje del usuario.
  const strippedText = rest || `(usuario invocó /${slug})`;

  return { text: strippedText, injected, slug };
}

module.exports = { parseSlashCommand };
module.exports._internal = { SLASH_RE };
