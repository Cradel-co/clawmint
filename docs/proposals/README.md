> Última actualización: 2026-03-17

# Propuestas técnicas

Análisis y decisiones de diseño antes de implementar cambios significativos.

**Regla:** antes de implementar algo nuevo o de gran impacto, se escribe una propuesta aquí con análisis, alternativas y decisión. Se implementa solo después de que la propuesta tiene estado `implementada` o `aprobada`.

---

## Índice

| Propuesta | Estado | Fecha | Descripción |
|-----------|--------|-------|-------------|
| [001-refactoring-arquitectural.md](./001-refactoring-arquitectural.md) | `implementada` | 2026-03 | Desacoplamiento completo de telegram.js monolito |
| [002-ia-local.md](./002-ia-local.md) | `propuesta` | 2026-03 | Pool de IA local con Ollama (Llama 8B, DeepSeek) |
| [003-mcp-shell-persistente.md](./003-mcp-shell-persistente.md) | `implementada` | 2026-03 | MCP Server embebido con ShellSession — estado de shell por conversación |
| [004-rate-limiting-configurable.md](./004-rate-limiting-configurable.md) | `propuesta` | 2026-03 | Límites configurables: rate limiting + duración de sesión CLI por scope |

---

## Estados posibles

| Estado | Descripción |
|--------|-------------|
| `propuesta` | Análisis escrito, pendiente de revisión |
| `aprobada` | Aprobada para implementar |
| `implementada` | Implementada y en producción |
| `descartada` | Analizada y descartada (con justificación) |
| `pausada` | Aprobada pero pausada por dependencias |
