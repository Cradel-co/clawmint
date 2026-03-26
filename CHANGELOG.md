# Changelog

Todos los cambios notables en este proyecto se documentan en este archivo.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

---

## [1.4.0] — 2026-03-25

### Added
- Comando `/restart` para reiniciar servidor PM2 desde Telegram
- Comando `/run` (alias `/cmd`) para ejecutar comandos de terminal desde el chat
- Botón 🔄 Restart en el submenú de monitor de Telegram
- Registro de nuevos comandos en el menú del bot

### Fixed
- Suprimir mensaje duplicado cuando Claude ya respondió via MCP tools (#70)
- Auto-remove de botones inline después de interacción con callback
- Tests desactualizados: destructuring de tools, conteo hardcodeado, path comparison Linux (#72)

---

## [1.3.0] — 2026-03-24

### Added
- Canal WebChat completo con ConversationService integration (`server/channels/web/`)
- Reproductor de audio personalizado con visualización de transcripción en WebChat
- Renderizado HTML en mensajes del chat WebChat
- Persistencia de historial y grabación de audio en WebChat
- Panel de MCPs con iconos Lucide y mejoras de UX en frontend (#39)
- MCP tools para WebChat — paridad con Telegram (`webchat_send_message`, etc.)
- MCP client pool para herramientas externas (`server/mcp-pool/`)
- Providers API con tools, modos, costo, `edit_file` y PTY interactivo
- Resiliencia de providers — retry, rate limit, timeout, resume
- Critter tools, relay fallback, channel filtering y Ollama tool-use
- Módulo Nodriza: configuración, conexión WebRTC con señalización, rutas REST y sesión P2P
- Adaptador P2PBotAdapter para DataChannel
- `transcribePCM` para audio P2P en transcriber
- Telegram: 4 nuevas MCP tools expandidas

### Fixed
- Dropdown sync al cambiar provider/agente en WebChat (#32)
- Contraste WCAG AA en todos los CSS (#50)
- Error handling silencioso + mejoras UX (#52)
- Estabilidad crítica: pty_exec, git tool
- Ollama: carga dinámica de modelos desde API
- Ollama marcado como siempre configurado
- WebChat: file upload, TTS error, mic validation, inline buttons
- WebChat: persist history for all providers
- WebChat: tools en system prompt
- Telegram: await consolidator processQueue
- Telegram: unificar audio status con msg flow
- Timers persistentes con `unref()`
- MCP pool: cerrar transport al desconectar
- Transcriber: usar ffmpeg en vez de ogg-opus-decoder
- Dependencias: agregar sharp, remover ogg-opus-decoder no usado
- Seguridad: remover provider-config.json del tracking

### Changed
- Refactor: `index.js` de 1704 → 170 LOC — rutas y WS handlers extraídos a módulos

### Docs
- Actualización de CLAUDE.md y ROADMAP.md
- Documentación de providers, channel filtering, critter tools

---

## [1.2.0] — 2026-03-22

### Added
- MCP memory tools con tags IDF-weighted y continuidad de sesión

---

## [1.1.0] — 2026-03-22

### Added
- Panel WebChat, MCP telegram tools, botones inline dinámicos con callbacks
- Visión multi-provider: fotos en Telegram con OCR kheiron-tools + fallback minicpm-v
- Ollama: visión con minicpm-v y fallback para claude-code
- Git hooks para proteger rama main y conventional commits

### Fixed
- Ollama: redimensionar imágenes a 512px antes de enviar a minicpm-v
- Vision: parsear output de kheiron OCR correctamente
- Telegram: diagnóstico de errores en fotos, silenciar stderr de OCR
- Telegram: fallback sin parse_mode en editMessageText
- TTS: carga resiliente de voice-providers y mejoras en comandos Telegram

### Changed
- Ollama: usar sharp en vez de Python para redimensionar imágenes

### Docs
- Plan de WebChannel desacoplado de Telegram
- Reescribir ARQUITECTURA.md y completar CLAUDE.md
- Actualizar estado de implementación en planes
- Plan P2P y docs de ia-local

---

## [0.9.0] — 2026-03-19

### Added
- Provider Grok (xAI) con soporte streaming y modelos configurables (`server/providers/grok.js`)
- Provider Ollama para modelos locales (`server/providers/ollama.js`)
- Sistema TTS multi-proveedor desacoplado: Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS (`server/voice-providers/`)
- Módulo TTS central con selección dinámica de proveedor (`server/tts.js`, `server/tts-config.js`)
- Persistencia de sesión Claude en SQLite para resume tras reinicio del servidor
- Persistencia del modo de permisos Claude (`ask`/`auto`/`plan`) en SQLite — sobrevive reinicios
- Configuración PM2 para gestión de procesos en producción (`server/ecosystem.config.js`)
- Auto-arranque del servidor con PM2 + systemd al encender la máquina
- Modularización del transcriptor de audio (`server/transcriber.js`)

### Fixed
- Robustecer persistencia de sesión Claude: reintentar sin `--resume` cuando la sesión es inválida
- Limpiar sesión rota en caso de error para evitar reintento con `--resume`
- Sincronizar `cwd` de `claudeSession` al cambiar directorio con `/cd` y `>>cd`
- Persistir `monitorCwd` (elegido por el usuario) en vez del `cwd` interno de Claude
- `_isClaudeBased` reconoce `'claude-code'` como provider válido (fix `/permisos`)

### Changed
- Piper TTS: extracción por OS, lock de concurrencia y preload al inicio

---

## [0.5.0] — 2026-03-16

### Added
- Soporte `groupWhitelist` en bots de Telegram para control de acceso en grupos
- Sistema de recordatorios/alarmas para el bot (`/recordar`, `/recordatorios`)

### Changed
- README reestructurado al estilo visual de proyecto open source
- Documentación detallada movida a `/documentacion` (servidor y cliente)

---

## [0.4.0] — 2026-03-15

### Added
- Inicialización automática de `bots.json` desde variables de entorno en primer arranque
- Provider configurable por agente (Anthropic, Gemini, OpenAI, Claude Code)
- Reconexión WebSocket con exponential backoff y persistencia de historial AI (24h)

---

## [0.3.0] — 2026-03-14

### Added
- Transcripción de audio con faster-whisper (mensajes de voz en Telegram)
- Comandos `/dir`, `/monitor`, `/ls`, `/cat`, `/mkdir` en el bot
- Respuestas chunked para mensajes largos en Telegram
- Configuración de bot desde panel web

---

## [0.2.0] — 2026-03-13

### Added
- Modo consola bash en Telegram (`/consola`)
- Navegación jerárquica por botones inline
- Módulo de memoria por agente
- Logger global con archivo `server.log`
- Panel de agentes en la UI web
- Sistema de skills (locales + ClawHub)
- Comando `/id`, rate-limit keyword bypass

---

## [0.1.0] — 2026-03-12

### Added
- Terminal PTY real con xterm.js + node-pty
- Servidor Express + WebSocket (puerto 3001)
- Cliente React + Vite (puerto 5173)
- Bot de Telegram con long polling y streaming progresivo
- Sesiones AI con Claude Code CLI (`claude -p`)
- API REST para sesiones, agentes, skills y memoria
- README inicial con instalación y comandos
