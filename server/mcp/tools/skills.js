'use strict';

/**
 * mcp/tools/skills.js — Tools MCP para invocación de skills bajo demanda.
 *
 * El modelo recibe en el system prompt solo la lista de slug+description
 * (cuando SKILLS_EAGER_LOAD!=true). Con `skill_invoke` carga el body del
 * skill dinámicamente, evitando el costo de inyectar todos los skills en
 * cada turno.
 *
 * El body se devuelve envuelto en `<system-reminder source="skill:<slug>">`
 * para que el modelo lo interprete como guía de sistema cuando lo lea
 * en el turno siguiente (tool-result llega como mensaje tool/user).
 */

const path = require('path');
const fs   = require('fs');
const skillsModule = require('../../skills');
const { sanitizeExternalText } = require('../../core/security/promptInjectionGuard');

const SKILL_LIST = {
  name: 'skill_list',
  description: 'Lista los skills disponibles (metadata: slug + descripción). Usar skill_invoke para cargar el contenido de uno específico.',
  params: {},
  execute(_args = {}, _ctx = {}) {
    const items = skillsModule.listSkills();
    if (!items.length) return 'Sin skills instalados.';
    return items.map(s => `- \`${s.slug}\`: ${s.description || s.name}`).join('\n');
  },
};

const SKILL_INVOKE = {
  name: 'skill_invoke',
  description: 'Carga el contenido (body) de un skill específico para aplicar sus instrucciones al turno actual. Opcionalmente acepta input del usuario.',
  params: {
    slug: 'string',
    input: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!args.slug) return "Error: parámetro slug requerido. Listá con skill_list.";
    const slug = String(args.slug).trim();
    const file = path.join(skillsModule.SKILLS_DIR, slug, 'SKILL.md');
    if (!fs.existsSync(file)) {
      return `Error: skill '${slug}' no existe. Listá con skill_list.`;
    }
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { return `Error leyendo skill '${slug}': ${e.message}`; }
    const { body, meta } = skillsModule.parseFrontmatter
      ? skillsModule.parseFrontmatter(raw)
      : { body: raw, meta: {} };
    if (!body || !body.trim()) {
      return `Error: SKILL.md de '${slug}' vacío o malformado.`;
    }

    // A3 — si el skill declara allowedTools en frontmatter y hay PermissionService activo,
    // otorga grants efímeros (5 min) para bajar 'ask' → 'auto' durante el turn del skill.
    const allowed = (meta && (meta['allowedTools'] || meta['allowed-tools'])) || null;
    if (Array.isArray(allowed) && allowed.length && ctx.permissionService && ctx.chatId
        && typeof ctx.permissionService.grantTemporary === 'function') {
      try {
        ctx.permissionService.grantTemporary(ctx.chatId, allowed, 5 * 60 * 1000);
      } catch { /* no bloquear invocación del skill por fallos en grant */ }
    }

    // Telemetría opcional para futuro LoopRunner que escuche y promueva a system real.
    if (ctx.eventBus && typeof ctx.eventBus.emit === 'function') {
      ctx.eventBus.emit('skill:invoked', {
        slug, chatId: ctx.chatId, agentKey: ctx.agentKey, userId: ctx.userId,
      });
    }

    // Sanitizar body para evitar prompt injection: un SKILL.md malicioso podría incluir
    // `</system-reminder>` para escapar el wrapper, o abrir tags falsos del harness.
    const safeBody  = sanitizeExternalText(body.trim());
    const safeInput = args.input ? sanitizeExternalText(String(args.input)) : '';

    const inputLine = safeInput ? `\n\nInput del usuario: ${safeInput}` : '';
    return `<system-reminder source="skill:${slug}">\n${safeBody}${inputLine}\n</system-reminder>`;
  },
};

module.exports = [SKILL_LIST, SKILL_INVOKE];
