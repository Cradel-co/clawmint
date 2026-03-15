'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, 'skills');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { body: content, meta: {} };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const [k, ...rest] = line.split(':');
    if (k && rest.length) meta[k.trim()] = rest.join(':').trim();
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

// Construye el prompt final: prompt del agente + TODOS los skills instalados
function buildAgentPrompt(agentDef) {
  const parts = [];
  if (agentDef.prompt) parts.push(agentDef.prompt);
  if (!fs.existsSync(SKILLS_DIR)) return parts.join('');
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

module.exports = { listSkills, buildAgentPrompt, searchClawHub, SKILLS_DIR };
