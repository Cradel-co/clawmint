> Estado: `propuesta` | Fecha: 2026-03

# Propuesta 002: IA local — Modelos self-hosted

Estrategia para integrar modelos de IA locales en Clawmint, complementando los providers cloud (Anthropic, Gemini, OpenAI).

---

## Motivación

Un modelo local no reemplaza a Claude/GPT-4o en calidad, pero habilita tareas automáticas, continuas y sin costo de API:

- Clasificación y routing de mensajes
- Resúmenes automáticos de conversaciones
- Alertas con contexto en lenguaje natural
- Pre-procesamiento antes de delegar a un modelo cloud
- Búsqueda semántica en memoria y skills

---

## Arquitectura de dos capas

```
Mensaje del usuario
        │
        ▼
  ┌─────────────┐
  │ Modelo local │  ← gratis, rápido, siempre disponible
  │  (7-8B)     │
  └──────┬──────┘
         │
         ├─ Simple    → responde directo
         ├─ Complejo  → delega a Claude / GPT-4o
         ├─ Sistema   → acción interna (resumir, alertar, clasificar)
         └─ Comando   → parsea y ejecuta sin IA
```

El 70-80% de las interacciones no necesitan un modelo frontier. El router local filtra y solo escala a cloud lo que realmente lo requiere.

---

## Módulos habilitados por IA local

| Módulo | Función | Estado |
|---|---|---|
| **Router inteligente** | Clasifica mensajes y decide local vs cloud | Pendiente |
| **Auto-memoria** | Resume conversaciones al cerrar sesión y guarda en `memory/` | Pendiente |
| **Alertas con contexto** | Monitorea sistema y genera alertas en lenguaje natural | Pendiente |
| **Pre-procesamiento** | Detecta intención, extrae parámetros, traduce | Pendiente |
| **Resúmenes de historial** | Genera resumen automático para `/historial` | Pendiente |
| **Sugerencia de comandos** | Autocomplete inteligente en la CommandBar | Pendiente |
| **Clasificación de skills** | Sugiere qué skill activar según contexto | Pendiente |

---

## Modelos recomendados por tarea

| Tarea | Modelo | RAM estimada (Q4) |
|---|---|---|
| Chat general / routing | Llama 3.1 8B | ~5 GB |
| Código | DeepSeek Coder 6.7B | ~4 GB |
| Embeddings / búsqueda semántica | nomic-embed-text | ~300 MB |
| Resúmenes | Mistral 7B | ~5 GB |

---

## Runtime: Ollama

[Ollama](https://ollama.ai) es el runtime recomendado. Expone una API compatible con el SDK de OpenAI, lo que simplifica la integración.

```bash
# Instalar en cualquier nodo Linux
curl -fsSL https://ollama.ai/install.sh | sh

# O con Docker
docker run -d --name ollama -p 11434:11434 ollama/ollama

# Descargar un modelo
ollama pull llama3.1:8b
```

API disponible en `http://localhost:11434/v1` (compatible OpenAI).

---

## Integración con Clawmint

### Paso 1 — Soporte `baseUrl` en provider config

Agregar campo `baseUrl` a `provider-config.json` para que el provider de OpenAI apunte a cualquier API compatible:

```json
{
  "default": "claude-code",
  "providers": {
    "anthropic": { "apiKey": "...", "model": "claude-opus-4-6" },
    "local-chat": {
      "apiKey": "not-needed",
      "model": "llama3.1:8b",
      "baseUrl": "http://nodo1:11434/v1"
    },
    "local-code": {
      "apiKey": "not-needed",
      "model": "deepseek-coder:6.7b",
      "baseUrl": "http://nodo2:11434/v1"
    }
  }
}
```

### Paso 2 — Provider local (adaptador)

Crear `server/providers/local.js` que reutilice el SDK de OpenAI con `baseURL` custom. El adaptador ya existe en `server/providers/openai.js` — solo necesita aceptar `baseUrl` como parámetro.

### Paso 3 — Módulo router

Lógica en el server que intercepta mensajes antes de enviarlos al provider y decide:

- **Local:** preguntas simples, comandos, clasificación, traducciones
- **Cloud:** razonamiento complejo, código largo, análisis profundo

---

## Pool de nodos (escalado)

Con múltiples máquinas Linux en la misma red, cada nodo puede servir un rol especializado:

```
Clawmint (server)
    │
    ├─ claude-code   → CLI local
    ├─ anthropic     → API cloud
    ├─ local-chat    → http://nodo1:11434/v1 (Llama 8B)
    ├─ local-code    → http://nodo2:11434/v1 (DeepSeek Coder)
    └─ local-embed   → http://nodo3:11434/v1 (embeddings)
```

### Requisitos por nodo

| Componente | Mínimo | Recomendado |
|---|---|---|
| RAM | 8 GB | 16 GB |
| CPU | 4 cores | 8 cores |
| Disco | 20 GB libres | SSD |
| GPU | Opcional | NVIDIA con 6+ GB VRAM |
| Red | Tailscale / LAN | misma subred, baja latencia |

### Limitaciones con 8 GB de RAM por nodo

- Modelos de hasta 8B parámetros (quantizados a Q4) corren cómodamente
- Modelos de 14B+ no caben en 8 GB — requieren más RAM o GPU offloading
- Sin GPU, la inferencia es lenta (~5-15 tokens/segundo en CPU para 8B)
- La latencia de red entre nodos suma al tiempo de respuesta

### Cuándo escalar a pool

1. Primero validar con un solo nodo que el router y los módulos funcionan
2. Si la carga justifica separar tareas, agregar nodos especializados
3. El pool no mejora la calidad del modelo — mejora throughput y disponibilidad

---

## Ruta de implementación

| Fase | Tarea | Prioridad |
|---|---|---|
| 1 | Soporte `baseUrl` en provider config | Alta |
| 2 | Adaptador provider local (OpenAI-compatible) | Alta |
| 3 | Conectar Ollama con un modelo 8B | Alta |
| 4 | Módulo router (local vs cloud) | Media |
| 5 | Auto-memoria (resúmenes post-sesión) | Media |
| 6 | Alertas con contexto | Baja |
| 7 | Embeddings y búsqueda semántica | Baja |
| 8 | Pool multi-nodo | Baja |
