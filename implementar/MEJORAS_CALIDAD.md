# Mejoras de calidad de respuesta — terminal-live/server

> Análisis realizado el 2026-03-15. Objetivo: mejorar calidad sin afectar eficiencia.

---

## 1. `--system-prompt` en `ClaudePrintSession` ★ Mayor impacto

**Archivo:** `server/telegram.js`

**Problema:** El prompt del agente y la memoria se inyectan como primer *mensaje de usuario*, no como system prompt real. Esto contamina el historial de conversación y debilita la consistencia del rol del agente en sesiones largas.

```js
// Hoy (telegram.js:1004-1009) — MAL: contamina el mensaje del usuario
if (chat.claudeSession.messageCount === 0 && memoryFiles.length > 0) {
  messageText = `${parts.join('\n\n')}\n\n---\n\n${text}`;
}
```

**Solución:** `claude -p` acepta el flag `--system-prompt`. Mover el contexto del agente + memoria ahí:

```js
// ClaudePrintSession — agregar propiedad systemPrompt al constructor
constructor({ model = null, systemPrompt = null } = {}) {
  // ...existente...
  this.systemPrompt = systemPrompt;
}

// ClaudePrintSession.sendMessage() — agregar el flag
const claudeArgs = [
  '--dangerously-skip-permissions',
  '-p', text,
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
];
if (this.systemPrompt) {
  claudeArgs.push('--system-prompt', this.systemPrompt);
}
```

```js
// En _sendToSession() — construir system prompt una sola vez al crear sesión
if (!chat.claudeSession) {
  const agentDef = agentsModule.get(agentKey);
  const memCtx   = memoryModule.buildMemoryContext(agentKey, agentDef?.memoryFiles || []);
  const skillCtx = agentDef?.prompt ? skillsModule.buildAgentPrompt(agentDef) : '';
  const systemPrompt = [skillCtx, memCtx, memoryModule.TOOL_INSTRUCTIONS]
    .filter(Boolean).join('\n\n') || null;

  chat.claudeSession = new ClaudePrintSession({ model: ..., systemPrompt });
}

// Ya NO inyectar nada en messageText para el primer mensaje
let messageText = text; // siempre limpio
```

**Beneficio:** Separación correcta sistema/usuario → mejor consistencia del rol, sin tokens extra (mismos datos, diferente canal).

---

## 2. System prompt enriquecido para sesiones WebSocket sin agente

**Archivo:** `server/index.js`

**Problema:** El prompt base para sesiones Claude API vía WebSocket es muy genérico.

```js
// Hoy (index.js:563-565)
const basePrompt = opts.systemPrompt ||
  'Sos un asistente útil. Respondé de forma concisa y clara. ' +
  'Usá texto plano sin markdown ya que tu respuesta se mostrará en una terminal.';
```

**Solución:**

```js
const basePrompt = opts.systemPrompt || [
  `Sos un asistente experto en desarrollo de software y sistemas.`,
  `Fecha actual: ${new Date().toLocaleDateString('es-AR', { dateStyle: 'long' })}.`,
  `Respondé en texto plano sin markdown (la salida se renderiza en una terminal xterm).`,
  `Cuando no sabés algo, decilo claramente. Sé preciso y conciso.`,
  `Si el usuario pide código, incluilo directamente sin bloques de código adicionales.`,
].join(' ');
```

**Beneficio:** ~30 tokens extra, mejora relevancia y honestidad de respuestas.

---

## 3. Memoria actualizada al crear nueva sesión

**Archivo:** `server/telegram.js`

**Problema:** La memoria solo se inyecta en `messageCount === 0`. Si el usuario ejecuta `/nueva` o `/reset`, la nueva `ClaudePrintSession` no recibe la memoria actualizada hasta que el sistema la lee, pero con el cambio del punto 1 esto se resuelve automáticamente al construir el `systemPrompt` en cada nueva sesión.

**Acción:** Al implementar el punto 1, asegurarse de que la construcción del `systemPrompt` ocurra también al crear sesión desde `/nueva`, `/reset` y callbacks `nueva`/`reset`.

```js
// Función helper reutilizable
function buildSessionSystemPrompt(agentKey) {
  const agentDef = agentsModule.get(agentKey);
  const memCtx   = memoryModule.buildMemoryContext(agentKey, agentDef?.memoryFiles || []);
  const skillCtx = agentDef?.prompt ? skillsModule.buildAgentPrompt(agentDef) : '';
  return [skillCtx, memCtx, memoryModule.TOOL_INSTRUCTIONS].filter(Boolean).join('\n\n') || null;
}
```

Usar esta función en todos los lugares donde se crea `new ClaudePrintSession()`.

---

## 4. `stableMs` adaptativo para PTY no-Claude

**Archivo:** `server/telegram.js` (línea 1092)

**Problema:** `stableMs=3000` es fijo para todos los agentes PTY. Consultas que generan output largo (análisis, código extenso) pueden cortarse; consultas simples esperan de más.

**Solución:** Heurística simple basada en el texto del usuario:

```js
// En _sendToSession() para agentes PTY
const isComplexQuery = text.length > 200
  || /anali[sz]|explica|escrib[ei]|cre[aá]|genera|lista|resume/i.test(text);
const stableMs = isComplexQuery ? 4500 : 2500;

const result = await session.sendMessage(text, { timeout: 1080000, stableMs });
```

**Beneficio:** Respuestas cortas más rápidas, respuestas largas más completas.

---

## 5. Skills selectivos por agente (reducción de tokens)

**Archivo:** `server/skills.js`

**Problema:** `buildAgentPrompt()` concatena **todos** los skills instalados en cada prompt, sin filtrar por relevancia. Con muchos skills instalados esto consume contexto innecesariamente.

```js
// Hoy: inyecta TODOS los skills siempre
for (const slug of fs.readdirSync(SKILLS_DIR)) { ... }
```

**Solución:** Agregar campo opcional `skills: ['slug1', 'slug2']` en la definición del agente. Si está presente, solo se incluyen esos; si está ausente, se incluyen todos (comportamiento actual, retrocompatible).

```js
// agents.json — ejemplo
{
  "key": "dev",
  "command": null,
  "description": "Dev assistant",
  "prompt": "Sos un experto en desarrollo...",
  "skills": ["git-helper", "code-review"]  // opcional
}

// skills.js — buildAgentPrompt modificado
function buildAgentPrompt(agentDef) {
  const parts = [];
  if (agentDef.prompt) parts.push(agentDef.prompt);
  if (!fs.existsSync(SKILLS_DIR)) return parts.join('');

  const allowedSlugs = Array.isArray(agentDef.skills) ? agentDef.skills : null;

  for (const slug of fs.readdirSync(SKILLS_DIR)) {
    if (allowedSlugs && !allowedSlugs.includes(slug)) continue; // filtrar
    const file = path.join(SKILLS_DIR, slug, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const { body, meta } = parseFrontmatter(raw);
    const header = meta.name ? `\n\n## Skill: ${meta.name}` : `\n\n## Skill: ${slug}`;
    parts.push(header + '\n\n' + body);
  }
  return parts.join('');
}
```

**Beneficio:** Reduce tokens de contexto, mejora foco del agente, sin cambios en UI.

---

## Resumen de prioridades

| # | Mejora | Impacto calidad | Complejidad | Tokens |
|---|--------|-----------------|-------------|--------|
| 1 | `--system-prompt` en ClaudePrintSession | **Alta** | Baja | = (mismos datos) |
| 2 | System prompt WS enriquecido | Media | Muy baja | +~30 |
| 3 | Memoria en nueva sesión | Media | Muy baja | = |
| 4 | `stableMs` adaptativo | Baja–Media | Muy baja | 0 |
| 5 | Skills selectivos | Media | Media | ↓ reduce |

**Recomendación de orden de implementación:** 1 → 3 → 2 → 5 → 4
