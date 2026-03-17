# Docker

Guía de despliegue con Docker y opciones de integración con Claude CLI.

---

## Inicio rápido

```bash
# Build y levantar
docker compose up -d --build

# Ver logs
docker compose logs -f

# Detener
docker compose down
```

El servidor queda accesible en `http://localhost:3001` con el frontend integrado.

---

## Archivos

| Archivo | Función |
|---|---|
| `Dockerfile` | Multi-stage: build del client (Vite) + server con node-pty |
| `docker-compose.yml` | Servicio, volúmenes y env |
| `docker-entrypoint.sh` | Crea directorios de datos antes de arrancar |
| `.dockerignore` | Excluye node_modules, .git, datos runtime |

---

## Persistencia

| Dato | Ubicación en container | Volumen |
|---|---|---|
| Memoria por agente | `/app/server/memory` | `server-memory` |
| Skills instalados | `/app/server/skills` | `server-skills` |
| `bots.json`, `agents.json`, `provider-config.json` | `/app/server/` | Dentro del container (se recrean desde `.env` o la API) |

---

## Variables de entorno

Se cargan desde `server/.env`. Ver `server/.env.example` para la plantilla completa.

---

## Montar Claude CLI del host (opcional)

Por defecto, el container **no incluye** la CLI de Claude (`claude`). Si un agente usa el provider `claude-code`, el error se captura y se responde con un mensaje de error al chat.

Para habilitar `claude-code` dentro del container, se puede montar la instalación del host:

```yaml
services:
  clawmint:
    # ...
    volumes:
      - server-memory:/app/server/memory
      - server-skills:/app/server/skills
      # Claude CLI (ajustar rutas según tu instalación)
      - $HOME/.nvm/versions/node/v22.x.x/lib/node_modules/@anthropic-ai/claude-code:/usr/lib/claude-code:ro
      - $HOME/.claude:/root/.claude
```

Y agregar al Dockerfile:

```dockerfile
RUN ln -s /usr/lib/claude-code/cli.js /usr/local/bin/claude
```

### Limitaciones del montaje

- **Filesystem aislado:** Claude ejecuta comandos dentro del container, no en el host. Solo ve los archivos montados.
- **Sesión compartida:** `$HOME/.claude` contiene los tokens de autenticación. Montar sin `:ro` permite que el container modifique la config.
- **Para terminal real** (el caso de uso principal de Clawmint), es preferible correr el server nativamente en el host donde claude ya está instalado y autenticado.

### Cuándo usar Docker vs nativo

| Escenario | Recomendación |
|---|---|
| Desarrollo local con Claude CLI | Server nativo (`npm run dev`) |
| Deploy en otro servidor con providers API | Docker |
| Solo chat IA sin ejecución de comandos | Docker + montaje de Claude CLI |

---

## Notas

- `node-pty` requiere compilación nativa: el Dockerfile instala `python3`, `make` y `g++` para eso.
- El server sirve el build del client (`client/dist/`) automáticamente via `express.static` cuando existe — no se necesita nginx.
- El `docker-entrypoint.sh` solo crea los directorios `memory/` y `skills/` si no existen.
