'use strict';

/**
 * Tests de mcp/tools/skills.js — skill_list + skill_invoke.
 *
 * Crea fixtures de skills dentro de server/skills/__test_fixtures__/ para
 * que skills.js (que hardcodea SKILLS_DIR) los detecte. Limpia al finalizar.
 */

const path = require('path');
const fs   = require('fs');

const skillsModule = require('../skills');
const tools = require('../mcp/tools/skills');

const FIXTURE_SLUGS = ['__test_review', '__test_no_body'];

function mkSkill(slug, name, desc, body) {
  const dir = path.join(skillsModule.SKILLS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
}

function byName(n) { return tools.find(t => t.name === n); }

beforeAll(() => {
  fs.mkdirSync(skillsModule.SKILLS_DIR, { recursive: true });
  mkSkill('__test_review', '__test_review', 'Review test skill', '# Review\nPaso 1: leer diff.\nPaso 2: dejar comentarios.');
  mkSkill('__test_no_body', '__test_no_body', 'sin body', '');
});

afterAll(() => {
  for (const slug of FIXTURE_SLUGS) {
    try { fs.rmSync(path.join(skillsModule.SKILLS_DIR, slug), { recursive: true, force: true }); } catch {}
  }
});

describe('skill_list', () => {
  test('lista slug + descripción (incluye los fixtures)', () => {
    const out = byName('skill_list').execute({});
    expect(out).toMatch(/`__test_review`: Review test skill/);
    expect(out).toMatch(/`__test_no_body`: sin body/);
  });
});

describe('skill_invoke', () => {
  test('devuelve system-reminder con body', () => {
    const out = byName('skill_invoke').execute({ slug: '__test_review' }, {});
    expect(out).toMatch(/<system-reminder source="skill:__test_review">/);
    expect(out).toMatch(/Paso 1: leer diff/);
    expect(out).toMatch(/<\/system-reminder>/);
  });

  test('agrega input del usuario si se pasa', () => {
    const out = byName('skill_invoke').execute({ slug: '__test_review', input: 'PR #42' }, {});
    expect(out).toMatch(/Input del usuario: PR #42/);
  });

  test('error si slug no existe', () => {
    const out = byName('skill_invoke').execute({ slug: 'no-existe-bogus' }, {});
    expect(out).toMatch(/no existe/);
  });

  test('error si slug vacío', () => {
    expect(byName('skill_invoke').execute({}, {})).toMatch(/slug requerido/);
  });

  test('error si SKILL.md vacío', () => {
    const out = byName('skill_invoke').execute({ slug: '__test_no_body' }, {});
    expect(out).toMatch(/vacío o malformado/);
  });

  test('emite evento skill:invoked al eventBus si está disponible', () => {
    const events = [];
    const eventBus = { emit: (name, payload) => events.push({ name, payload }) };
    byName('skill_invoke').execute({ slug: '__test_review' }, { eventBus, chatId: 'c1', agentKey: 'coord' });
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('skill:invoked');
    expect(events[0].payload.slug).toBe('__test_review');
    expect(events[0].payload.chatId).toBe('c1');
  });
});
