> Última actualización: 2026-03-17

# Clawmint — Documentación

Terminal en tiempo real accesible desde el navegador y Telegram. Combina PTY virtual, WebSocket, REST API y un bot de Telegram como frontend alternativo para Claude Code y otros agentes de IA.

---

## Primeros pasos

| Documento | Descripción |
|-----------|-------------|
| [setup.md](./setup.md) | Instalación, configuración y comandos de desarrollo |
| [architecture.md](./architecture.md) | Arquitectura del sistema, módulos y flujo de datos |
| [roadmap.md](./roadmap.md) | Estado actual y próximos pasos |

---

## Estructura

| Carpeta | Contenido |
|---------|-----------|
| [api_contract/](./api_contract/README.md) | Contratos REST y WebSocket (rutas, parámetros, responses) |
| [modules/](./modules/README.md) | Documentación de módulos backend (responsabilidad, interfaces) |
| [frontend/](./frontend/README.md) | Componentes React, estado y protocolo WS |
| [flows/](./flows/README.md) | Flujos de negocio (envío de mensaje, memoria, Telegram) |
| [database/](./database/README.md) | Schema SQLite, relaciones e índices |
| [deployment/](./deployment/README.md) | Deploy, variables de entorno e infraestructura |
| [integrations/](./integrations/README.md) | Servicios externos (Anthropic, Gemini, OpenAI, Telegram, Whisper) |
| [proposals/](./proposals/README.md) | Propuestas técnicas previas a implementación |

---

## Convenciones

### Formato por tipo de documento

**Endpoints (`api_contract/`):** método HTTP · ruta · parámetros (tabla) · response JSON de ejemplo · códigos de error.

**Flujos (`flows/`):** descripción · actores · precondiciones · pasos secuenciales numerados · condiciones de error · resultado esperado.

**Módulos (`modules/`):** archivo fuente · responsabilidad · interfaces públicas · dependencias.

**Propuestas (`proposals/`):** análisis previo a implementar. Incluyen estado (`propuesta` / `implementada` / `descartada`) y fecha.

### Reglas de mantenimiento

1. **Proposals como gate:** antes de implementar algo significativo, se escribe una propuesta en `proposals/` con análisis, alternativas y decisión. Se implementa solo después de consenso.
2. **Documentar en el mismo commit:** al modificar código, se actualiza el documento correspondiente en el mismo commit.
3. **Fecha de actualización** al inicio de cada documento (blockquote).
4. Cada carpeta tiene un `README.md` que actúa como índice de esa sección con tabla de contenidos.
