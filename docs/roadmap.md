> Última actualización: 2026-03-17

# Roadmap

## Estado actual (v2.x)

El núcleo del sistema está operativo:

- [x] Terminal PTY en tiempo real (WebSocket + xterm.js)
- [x] Sesiones AI (Anthropic, Gemini, OpenAI) desde el navegador
- [x] Bot Telegram con soporte multi-proveedor
- [x] Sistema de memoria persistente (SQLite + Markdown + spreading activation)
- [x] Gestión de agentes (CRUD desde UI y Telegram)
- [x] Skills (locales + búsqueda en ClawHub)
- [x] MCPs (Model Context Protocol — integración con Smithery)
- [x] Recordatorios en Telegram
- [x] Transcripción de audio (faster-whisper)
- [x] Refactoring arquitectural completo (DI, bootstrap, BaseChannel, repos)
- [x] MCP Server embebido con ShellSession — herramientas con estado de shell por conversación
- [x] `TelegramBot` delega a `ConversationService` — código unificado para todos los canales
- [x] Providers inyectables — `executeTool` con `shellId` para persistencia de cwd/env

## Deuda técnica identificada

| Ítem | Prioridad | Descripción |
|------|-----------|-------------|
| Eliminar `telegram.js` shim | Media | `index.js` puede importar `TelegramChannel` directamente desde `bootstrap.js` |
| Eliminar `events.js` | Baja | `memory-consolidator.js` aún lo requiere; reemplazar por `EventBus` inyectado |
| Simplificar `index.js` | Baja | Aún hace `require()` de dominio directamente; debería obtener todo del container |
| ShellSession en sesión WS | Media | El WS AI session (`startAISession` en index.js) no pasa `shellId` ni usa `convSvc`; tiene su propio loop de herramientas |
| Tests automatizados | Alta | No hay test suite; solo scripts manuales en `server/test-*.js` |

## Próximas features

### Infraestructura

| Feature | Estado | Notas |
|---------|--------|-------|
| Canal Discord | Propuesta | `BaseChannel` ya existe; sería `channels/discord/` |
| Búsqueda semántica con embeddings | Parcial | `note_embeddings` table existe; integración incompleta |
| Modo offline con IA local | Exploración | Ver `proposals/002-ia-local.md` |
| Tests automatizados | Pendiente | Solo scripts manuales en `server/test-*.js` |

### UX Telegram (de `mejoras.md`, 2026-03-15)

| Feature | Prioridad |
|---------|-----------|
| `setMyCommands` — sugerencias de comandos en el teclado | Media |
| Botones post-respuesta contextuales ("Seguir", "Resumir", "Guardar") | Parcial (implementado básico) |
| Confirmaciones Sí/No antes de acciones destructivas | Baja |
| `/nota` — notas rápidas independientes de la sesión | Media |
| `/historial` — resumen de sesiones anteriores | Baja |
| Análisis de archivos de texto/código/imágenes enviados | Media |
| Modo dictado — acumular audios y consolidar | Baja |
| Agentes temporales: `/agente-temp "prompt"` | Baja |
| Alertas proactivas de CPU/RAM/disco | Media |
| Logs de uso: mensajes/día, costo semanal | Baja |
| Respuestas largas partidas con botón "Ver más" | Media |
