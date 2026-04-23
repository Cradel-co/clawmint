> Última actualización: 2026-04-18

# Filosofía de desarrollo de Clawmint

Este documento explica **por qué** se toman ciertas decisiones en el proyecto. Para las reglas concretas (qué hacer, qué evitar), ver [development-rules.md](./development-rules.md).

La filosofía toma como base la que aplica Claude Code (CLI oficial de Anthropic) y se adapta al dominio de Clawmint: servidor doméstico multicanal con memoria persistente, en lugar de CLI de desarrollo.

---

## 1. Principios raíz

Los principios de producto ya están en [vision.md](./vision.md). Acá se sintetizan los que tienen consecuencias directas en el código:

- **Local-first**: los datos del usuario viven en su propio hardware. Ninguna feature puede volverse dependiente de un servicio cloud obligatorio.
- **Multi-usuario con aislamiento real**: cada miembro de la familia tiene su contexto. La memoria no se filtra entre usuarios salvo que se declare explícitamente como compartida.
- **Extensible por plugin**: hooks, skills, MCPs, providers. Agregar una capacidad nueva no debería requerir tocar el core.
- **Fail-open en features opcionales**: si LSP, hooks, worktrees o un MCP externo se caen, el motor sigue funcionando. Nunca una integración opcional tira el server.
- **Proactivo, no reactivo**: el scheduler, los recordatorios, las rutinas matutinas son parte del ADN. El agente no solo responde — también avisa y actúa.

---

## 2. Filosofía de código

### Minimalismo intencional

- **Tres líneas parecidas son mejor que una abstracción prematura.** Una helper function que sirve en un solo lugar no es reutilización, es acoplamiento.
- **No agregar features no pedidas.** Un bug fix no necesita refactor alrededor. Un endpoint nuevo no necesita inventar validaciones para inputs que aún no existen.
- **No diseñar para requisitos hipotéticos.** La flexibilidad que no tiene consumer hoy es costo sin valor.
- **Borrar código muerto sin vergüenza.** No dejar variables `_unused`, no comentar `// removed`, no re-exportar tipos por compat cuando nadie los usa.

### Comentarios con propósito

- **Default: cero comentarios.** Nombres de variable y función bien elegidos explican QUÉ hace el código.
- Un comentario vale la pena **solo si explica el PORQUÉ no-obvio**: una restricción oculta, un invariante sutil, un workaround para un bug concreto, un comportamiento que sorprendería a un lector atento.
- **Nunca referenciar tarea, PR, issue ni caller.** "usado por X", "agregado en la tarea Y", "fix para issue #42" pertenecen a la descripción del PR. En el código envejecen y estorban.
- Un `// TODO` sin fecha ni owner es deuda fantasma. O se fixea, o se documenta en issue tracker.

### Error handling disciplinado

- **Validar solo en los bordes del sistema.** Input de Telegram, WebChat, webhooks, MCP responses externas: sanitizar. Funciones internas del mismo módulo: confiar.
- **No agregar fallbacks para escenarios imposibles.** Si un argumento de tipo `User` no puede ser `null` en el flujo, no poner `if (!user) return`. Mentís sobre la intención del código.
- **No usar feature flags ni shims de compat cuando se puede simplemente cambiar el código.** La compat tiene costo cognitivo permanente. Si nadie la usa, removerla.
- **Errores claros, no tragados silencio.** Un `catch` vacío es un bug esperando pasar.

---

## 3. Honestidad de verificación

- **Antes de reportar "listo", verificar que funciona**: correr el test, ejecutar el script, ver el output real.
- **Si los tests fallan, decirlo** con el output relevante. Nunca "todos los tests pasan" cuando hay rojos en pantalla.
- **Nunca suprimir ni simplificar checks** (lint, types, tests) para forzar verde. Si un check estorba, se discute su valor explícitamente; no se silencia.
- **Si no corriste una verificación, decirlo.** No implicar éxito. Un PR honesto con "no pude probar X porque Y" vale más que un PR optimista que se rompe en prod.

---

## 4. Reversibilidad primero

Antes de ejecutar una acción, preguntar: **¿cuánto cuesta revertir esto si estaba equivocado?**

- **Acciones locales y reversibles** (editar archivos, correr tests, leer DB): se toman libremente.
- **Acciones de alto blast radius** (push a main, drop table, rm -rf, force-push, delete branch, modificar CI, borrar archivos del usuario): se consultan explícitamente antes.
- **Cuando encontrás un obstáculo, no usar destructive como atajo para hacerlo desaparecer.** Un `git reset --hard` que "resuelve" un merge conflict está destruyendo trabajo. Un `rm -rf node_modules` cuando una dependencia no instala está evadiendo el diagnóstico.
- **Investigar antes de borrar.** Un lock file, un archivo raro, una config desconocida pueden ser trabajo en progreso del usuario. Leer primero, decidir después.

Principio resumen: **medir dos veces, cortar una.**

---

## 5. Root cause sobre workaround

- **Diagnosticar por qué falla algo antes de cambiar de táctica.** Si el test falla, entender el fallo — no reescribir el test hasta que pase.
- **No reintentar comandos fallidos en sleep loops.** Encontrar la causa. Un comando que falla 3 veces seguidas no va a fallar menos la cuarta por esperar 5 segundos más.
- **Resolver merge conflicts, no descartar cambios.** Si uno de los dos lados se pierde, se perdió información.
- **Solo escalar a "pregunto al usuario" cuando genuinamente estás trabado**, no como primera respuesta a fricción. Investigar, probar hipótesis, leer código relacionado primero.

---

## 6. Colaboración sobre ejecución ciega

- **Si la petición del usuario se basa en un malentendido, o si ves un bug adyacente al que te pidieron fixear, decirlo.** El usuario no pierde nada con saberlo, y a veces lo que pidió no es lo que necesita.
- **Sos colaborador, no ejecutor.** El valor está en el juicio, no solo en cumplir órdenes literalmente.
- **Flaggear suposiciones antes de tomarlas como ciertas.** "Voy a asumir que X porque Y, decime si prefieres otra cosa" es mucho mejor que hacerlo y que el usuario lo descubra en el diff.

---

## 7. Decisiones arquitectónicas y su porqué

Decisiones que pueden parecer extrañas a simple vista y su razón:

| Decisión | Razón |
|---|---|
| **CommonJS** en lugar de ES Modules | Compat con `sql.js`, `node-pty` y dependencias legacy. Migración prevista más adelante cuando el ecosistema esté maduro. |
| **sql.js (WASM)** en lugar de `better-sqlite3` | Evitar compilación nativa — portabilidad garantizada entre WSL, Raspberry Pi, Docker y macOS sin rebuildear. |
| **Multi-provider con contrato v2** | No acoplar a Anthropic. Fail-open: si un provider cae, el usuario puede cambiar sin que el motor muera. Ver `server/providers/`. |
| **MCP modular con 32+ tools** en lugar de tools monolíticas | Extensible por dominio, filtrable por canal (algunos tools solo aplican a P2P, otros solo a admin). |
| **Event-driven (EventEmitter)** en lugar de polling | Menor overhead, mejor latencia, observable (cada evento es un punto de intercepción para hooks y métricas). |
| **Sliding window + compactación reactiva** (Fase 7 del roadmap) en lugar de "mandá todo siempre" | Costo de tokens controlado en conversaciones largas. |
| **Haiku / tier cheap por provider** para tareas internas (Fase 7.5) | Consolidación, resúmenes y compactación no necesitan el modelo premium. Reducción medida 30–50% en tokens facturados. |
| **Flags por feature, no por fase** | Rollback quirúrgico sin revertir un mes de trabajo. Default conservador (off) en features nuevas. |

---

## Referencias

- [vision.md](./vision.md) — visión del producto
- [architecture.md](./architecture.md) — cómo está hecho hoy
- [development-rules.md](./development-rules.md) — reglas concretas derivadas de esta filosofía
- `server/ROADMAP.md` — plan técnico con ajustes de modularidad aplicados
- `CLAUDE.md` (raíz) — referencia operativa para Claude asistente
