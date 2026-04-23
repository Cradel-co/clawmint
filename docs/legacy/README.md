# Documentación legacy

Estos docs son **planning histórico pre-roadmap** (febrero–marzo 2026), conservados para auditoría histórica. **No reflejan el estado actual del proyecto.**

El roadmap actual vive en:
- [`/ROADMAP.md`](../../ROADMAP.md) — fases del producto (raíz)
- [`/server/ROADMAP.md`](../../server/ROADMAP.md) — plan técnico interno

---

## Archivos

### `implementar/`

| Archivo | Estado actual del trabajo |
|---|---|
| `ARQUITECTURA.md` | Propuesta inicial — implementada en `bootstrap.js` + `routes/` + `ws/` |
| `CONVERSATION_COMPACTION_PLAN.md` | Implementado (sliding window en `ConversationService`) |
| `FIX_STREAMING_TURNOS_ANTERIORES.md` | Bug específico — resuelto |
| `INSTALADOR_PKG.md` | Ver `/docs/PACKAGING.md` para el packaging vigente |
| `MEJORAS_CALIDAD.md` | Checklist — parcialmente aplicado en sesiones 1–5 |
| `MEMORY_SYSTEM_PLAN.md` | Implementado (`memory.js`, `memory-consolidator.js`, spreading activation) |
| `openclaw-gaps.md` | Análisis inicial del gap vs producto referencia — superado por roadmap |
| `TASK_SCHEDULER.md` | Implementado (`scheduler.js`, `scheduled_actions`) |
| `WEB_CHANNEL_PLAN.md` | Implementado (`channels/web/WebChannel.js`) |

### Raíz de `legacy/`

| Archivo | Reemplazado por |
|---|---|
| `memoria.md` | `/docs/database/schema.md` (tablas), `/docs/architecture.md` (memoria episódica + spreading), `/docs/database/relaciones.md` (FKs) |

---

## Por qué se conservan

- **Trazabilidad**: muestran las decisiones de diseño previas al estado actual.
- **Contexto histórico**: útil si un desarrollador necesita entender por qué algo se hizo así.
- **No tocar**: no reabrir trabajo descripto acá sin chequear que no esté ya hecho. La probabilidad de que estos planes describan algo todavía pendiente es baja.

Si encontrás info acá que **no está cubierta** en la documentación actual y crees que sigue siendo relevante, abrí un issue antes de mover el contenido — la mayoría de los gaps están resueltos en el código actual.
