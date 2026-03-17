# Mejoras propuestas para el bot de Telegram

Ideas de mejora discutidas el 2026-03-15. Ninguna implementada aún.

## Interacción y UX
- **Menú persistente (setMyCommands)** — Que los comandos aparezcan como sugerencias al escribir `/`
- **Botones contextuales post-respuesta** — "Seguir", "Resumir", "Guardar en memoria", "Nueva conversación"
- **Confirmaciones interactivas** — Botones Sí/No antes de acciones destructivas (reset, nueva conv)

## Funcionalidad nueva
- **Notas rápidas / bookmarks** — `/nota` para guardar fragmentos, `/notas` para consultar
- **Historial de conversaciones** — Resumen automático al cerrar sesión, consultable con `/historial`
- **Recordatorios / tareas** — `/recordar` para agendar mensajes futuros
- **Enviar archivos** — Analizar archivos de texto/código/imágenes con Claude (ya se hace con audio)
- **Modo dictado** — Acumular audios y consolidar al final

## Agentes y personalización
- **Agentes temporales** — `/agente-temp "prompt"` para agentes de una sola sesión
- **Encadenar agentes** — Delegación automática entre agentes
- **Agente por horario** — Agente por defecto según la hora del día

## Monitoreo y sistema
- **Alertas proactivas** — Notificar si CPU/RAM/disco superan un umbral
- **Logs de uso** — Mensajes por día, costo semanal/mensual, gráficos
- **Health check** — Ping periódico que avise si el bot/servidor se cayó

## Calidad de vida
- **Respuestas largas partidas** — Botón "Ver más" en vez de mandar todo de golpe
- **Formateo mejorado** — Bloques de código largos como archivos adjuntos
- **Pin automático** — Opción de pinear respuestas importantes
