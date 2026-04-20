'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');

/**
 * Parser mínimo de frontmatter YAML-like. Soporta:
 *   key: value                    → string
 *   key: [a, b, c]                → array de strings
 *   key:
 *     - a
 *     - b                         → array de strings
 *   key: |
 *     multi                       → string multilínea
 *     línea
 * No soporta nested objects (no se usan en skills).
 *
 * A3 — claves conocidas que se normalizan a arrays:
 *   allowed-tools / allowedTools, skills
 */
const ARRAY_KEYS = new Set(['allowed-tools', 'allowedtools', 'skills']);

function _parseInlineArray(s) {
  // "[a, b, c]" → ['a', 'b', 'c']
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { body: content, meta: {} };
  const meta = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Key: value en misma línea
    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].trim();
    const rhs = kvMatch[2];
    const keyLower = key.toLowerCase();

    if (rhs === '' || rhs === '|' || rhs === '>') {
      // Lista en líneas siguientes o bloque multilínea
      const collected = [];
      const strings = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (!nxt.trim()) { j++; continue; }
        // Nueva key de top-level → salir
        if (/^[A-Za-z0-9_-]+\s*:/.test(nxt) && !nxt.startsWith(' ') && !nxt.startsWith('\t')) break;
        if (/^\s*-\s+/.test(nxt)) {
          collected.push(nxt.replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
        } else if (rhs === '|' || rhs === '>') {
          // bloque multilínea (tab o ≥2 espacios)
          strings.push(nxt.replace(/^\s{2}|^\t/, ''));
        }
        j++;
      }
      if (collected.length) {
        meta[key] = collected;
      } else if (strings.length) {
        meta[key] = (rhs === '>' ? strings.join(' ') : strings.join('\n')).trim();
      } else {
        meta[key] = '';
      }
      i = j - 1;
      continue;
    }

    if (rhs.startsWith('[') && rhs.endsWith(']')) {
      meta[key] = _parseInlineArray(rhs);
      continue;
    }

    const value = rhs.trim().replace(/^['"]|['"]$/g, '');
    // Normalización: claves conocidas como arrays aceptan string suelto como [string]
    if (ARRAY_KEYS.has(keyLower)) {
      meta[key] = value ? [value] : [];
    } else {
      meta[key] = value;
    }
  }
  return { body: content.slice(match[0].length).trim(), meta };
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(d => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md')))
    .map(slug => {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
      const { meta } = parseFrontmatter(raw);
      return { slug, name: meta.name || slug, description: meta.description || '' };
    });
}

// Construye el prompt final: prompt del agente + skills.
// Modo por defecto (SKILLS_EAGER_LOAD=false o unset): solo inyecta el índice de skills
// con name + description. El agente invoca skill_invoke para cargar el body bajo demanda.
// Modo legacy (SKILLS_EAGER_LOAD=true): inyecta el body completo de TODOS los skills
// en cada system prompt — costoso en tokens.
function buildAgentPrompt(agentDef) {
  const parts = [];
  if (agentDef.prompt) parts.push(agentDef.prompt);
  if (!fs.existsSync(SKILLS_DIR)) return parts.join('');

  const eager = process.env.SKILLS_EAGER_LOAD === 'true';
  if (eager) {
    for (const slug of fs.readdirSync(SKILLS_DIR)) {
      const file = path.join(SKILLS_DIR, slug, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { body, meta } = parseFrontmatter(raw);
      const header = meta.name ? `\n\n## Skill: ${meta.name}` : `\n\n## Skill: ${slug}`;
      parts.push(header + '\n\n' + body);
    }
    return parts.join('');
  }

  // Lazy mode: solo metadata, el agente invoca skill_invoke para obtener el body
  const available = listSkills();
  if (available.length) {
    parts.push('\n\n## Skills disponibles (invocá con la tool skill_invoke para cargar el contenido completo)');
    for (const s of available) {
      parts.push(`\n- \`${s.slug}\`: ${s.description || s.name}`);
    }
  }
  return parts.join('');
}

async function searchClawHub(query) {
  const response = await fetch('https://clawhub.ai/api/v1/skills');
  if (!response.ok) throw new Error(`ClawHub respondió ${response.status}`);
  const data = await response.json();
  const items = Array.isArray(data) ? data : (data.items || []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  return items
    .map(item => {
      const tagWords = Object.keys(item.tags || {}).join(' ');
      const hay = [
        item.displayName || '',
        item.summary || '',
        tagWords,
      ].join(' ').toLowerCase();
      const score = words.filter(w => hay.includes(w)).length;
      return {
        slug: item.slug,
        name: item.displayName || item.slug,
        description: item.summary || '',
        score,
      };
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

module.exports = { listSkills, buildAgentPrompt, searchClawHub, parseFrontmatter, SKILLS_DIR };
