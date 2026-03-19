# Changelog

Todos los cambios notables en este proyecto se documentan en este archivo.

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

---

## [Unreleased]

### Added
- Provider Grok (xAI) con soporte streaming y modelos configurables (`server/providers/grok.js`)
- Provider Ollama para modelos locales (`server/providers/ollama.js`)
- Sistema TTS multi-proveedor desacoplado: Edge TTS, Piper TTS, SpeechT5, ElevenLabs, OpenAI TTS, Google TTS (`server/voice-providers/`)
- Módulo TTS central con selección dinámica de proveedor (`server/tts.js`, `server/tts-config.js`)
- Persistencia de sesión Claude en SQLite para resume tras reinicio del servidor
- Configuración PM2 para gestión de procesos en producción (`server/ecosystem.config.js`)
- Modularización del transcriptor de audio (`server/transcriber.js`)

### Fixed
- Robustecer persistencia de sesión Claude: reintentar sin `--resume` cuando la sesión es inválida
- Limpiar sesión rota en caso de error para evitar reintento con `--resume`
- Sincronizar `cwd` de `claudeSession` al cambiar directorio con `/cd` y `>>cd`
- Persistir `monitorCwd` (elegido por el usuario) en vez del `cwd` interno de Claude

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
