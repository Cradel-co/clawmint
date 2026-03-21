# Sistema P2P para Clawmint

Propuesta de arquitectura P2P para convertir Clawmint en un sistema distribuido. Permite conectar múltiples instancias de Clawmint entre sí, compartir recursos y sesiones sin servidor central.

**Estado:** Propuesta — nada implementado aún.

---

## Arquitectura general

```
     ┌──────────────┐         ┌──────────────┐
     │  CLAWMINT A  │◄──P2P──►│  CLAWMINT B  │
     │  (PC local)  │         │  (servidor)  │
     │              │         │              │
     │ - Agentes    │ sync    │ - Agentes    │
     │ - Memoria    │◄──────►│ - Memoria    │
     │ - Skills     │         │ - Skills     │
     │ - PTYs       │         │ - PTYs       │
     │ - TTS local  │         │ - GPU tasks  │
     └──────┬───────┘         └──────┬───────┘
            │                        │
     ┌──────┴───────┐         ┌──────┴───────┐
     │  Navegador   │         │  Telegram    │
     │  WebSocket   │         │  Bot         │
     └──────────────┘         └──────────────┘
```

## Librerías compatibles (CommonJS, Node >= 22)

| Librería | Uso | Peso | Complejidad |
|---|---|---|---|
| `simple-peer` | WebRTC fácil (DataChannel, MediaStream) | ~50KB | Baja |
| `hyperswarm` | Discovery + conexión P2P automática | ~2MB | Media |
| `hypercore` | Datos replicados P2P (append-only log) | ~3MB | Media |
| `automerge` | CRDT para sincronización sin conflictos | ~1MB | Media |
| `gun` | BD descentralizada en tiempo real | ~500KB | Baja |
| `libp2p` | Red P2P completa (modular) | ~10MB | Alta |
| `webtorrent` | Transferencia de archivos P2P | ~5MB | Baja |

---

## 1. Capa de comunicación

### 1.1 Discovery de nodos (fundamento)

Base de todo el sistema P2P. Los nodos de Clawmint se descubren automáticamente en la red (tailnet o LAN).

- **Tech:** `hyperswarm`
- Cada instancia de Clawmint anuncia un topic compartido (hash del nombre del proyecto/red)
- Los nodos se conectan automáticamente al descubrirse
- Funciona dentro de la tailnet sin configuración adicional

### 1.2 Terminal sharing P2P

Compartir sesiones PTY entre usuarios sin pasar por el server central.

- **Tech:** WebRTC DataChannel vía `simple-peer`
- Un usuario comparte su sesión → otro se conecta directo
- Baja latencia, sin saturar el server
- Similar a `tmate` pero integrado en Clawmint

### 1.3 Chat P2P entre agentes remotos

Un agente en un nodo puede comunicarse directamente con agentes en otros nodos.

- Ejemplo: agente "devops" en nodo A le pide al agente "database" en nodo B que revise logs
- Los agentes se descubren automáticamente vía Hyperswarm
- Protocolo de mensajes JSON sobre conexiones P2P

### 1.4 Relay de Telegram distribuido

Múltiples bots de Telegram en distintos nodos redirigen conversaciones según el agente requerido.

- Bot en nodo A detecta que necesita agente "coder" → lo tiene nodo B → P2P directo
- El usuario no nota la redirección, respuesta transparente

### 1.5 Broadcast de eventos entre nodos

El `events.js` actual es local. Con P2P, los eventos se propagan a todos los nodos.

- Alguien crea una sesión en nodo A → todos los navegadores conectados a cualquier nodo la ven
- Los listeners de Telegram en el frontend web ven sesiones de cualquier nodo

---

## 2. Capa de datos

### 2.1 ClawHub descentralizado

En vez de depender de `clawhub.ai` para skills, los nodos comparten skills entre sí.

- **Tech:** `hypercore` como registro distribuido de skills
- Publicas un skill → se replica automáticamente a todos los nodos de la red
- Funciona offline si ya se replicó previamente
- ClawHub centralizado sigue como fallback/fuente pública

### 2.2 Memoria compartida entre agentes

Agentes del mismo rol en distintos nodos sincronizan memoria automáticamente.

- **Tech:** `automerge` + `hypercore`
- CRDT (conflict-free replicated data) para resolver conflictos de escritura simultánea
- Un agente aprende algo útil → esa memoria se propaga a los demás
- Control granular: qué memorias son locales vs compartidas

### 2.3 Historial de conversaciones replicado

Las conversaciones se replican entre nodos como backup automático.

- Sin necesidad de un servicio de backup centralizado
- Si un nodo cae, el historial sigue disponible en los otros
- **Tech:** `hypercore` (append-only log ideal para historial)

---

## 3. Capa de cómputo

### 3.1 Balanceo de carga de IA

Los nodos negocian quién procesa cada petición según capacidad.

- Nodo A tiene GPU → recibe peticiones de TTS (Kokoro) y modelos locales
- Nodo B tiene API keys de Anthropic → recibe peticiones de Claude
- Nodo C tiene Gemini configurado → recibe peticiones de Gemini
- Transparente para el usuario, el resultado llega igual

Cada nodo anuncia sus capacidades:
```json
{
  "node": "nodo-a",
  "capabilities": {
    "gpu": true,
    "tts": "kokoro-v1.0",
    "providers": ["anthropic", "openai"],
    "ram_available_gb": 6.6,
    "cpu_threads": 8
  }
}
```

### 3.2 Cola de tareas distribuida

Tareas pesadas se encolan y el nodo con más recursos disponibles las toma.

- **Tech:** `hyperswarm` para discovery + protocolo simple de jobs
- Generar audio largo, analizar repos grandes, batch de consultas IA
- El nodo que toma la tarea reporta progreso vía P2P

### 3.3 Ejecución remota de PTY

Desde el navegador conectado a nodo A, abrir una terminal en nodo B.

- Sin SSH, sin configurar nada — solo P2P dentro de la tailnet
- Como `tmux attach` pero entre máquinas vía Clawmint
- La sesión remota aparece como una pestaña más en el frontend

---

## 4. Capa de seguridad y acceso

### 4.1 Autenticación descentralizada

Identidades basadas en pares de llaves públicas/privadas.

- Cada nodo genera su keypair al inicializarse
- Los permisos se replican P2P entre nodos autorizados
- Un usuario autorizado en un nodo queda autorizado en todos
- Reemplaza o complementa la whitelist por chat ID de Telegram

### 4.2 Túneles P2P para sesiones externas

Compartir una sesión con alguien externo sin exponer puertos.

- **Tech:** `hyperswarm` como relay
- Link temporal tipo `clawmint://session/abc123` que expira
- Como ngrok pero P2P, sin servicio de terceros
- Ideal para pair programming o soporte remoto

---

## 5. Capa de UX

### 5.1 Presencia en tiempo real

Ver quién está conectado a qué sesión en qué nodo.

- Cursores compartidos en la terminal (como Google Docs pero en xterm.js)
- Indicadores: "Marcos está viendo esta sesión desde Telegram"
- Estado de cada nodo visible en el frontend

### 5.2 Clipboard P2P

Copiar algo en la terminal de nodo A → disponible para pegar en nodo B.

- Directo entre peers, sin pasar por servidor
- Útil para mover snippets entre máquinas

### 5.3 Notificaciones cruzadas

Eventos de cualquier nodo pueden notificar en cualquier frontend.

- Un proceso largo termina en nodo B → notificación en Telegram conectado a nodo A
- Los reminders (`reminders.js`) funcionan a nivel de red, no de nodo individual

---

## 6. Plan de implementación

Orden recomendado, cada fase construye sobre la anterior:

### Fase 1 — Fundamento (discovery)
- Integrar `hyperswarm` en el server
- Cada instancia de Clawmint se anuncia y descubre peers
- Protocolo base de mensajes JSON entre nodos
- Heartbeat y estado de peers

### Fase 2 — Valor inmediato (PTY remoto)
- Abrir sesiones PTY en nodos remotos desde cualquier frontend
- Terminal sharing entre usuarios vía WebRTC DataChannel
- Presencia básica (quién está conectado dónde)

### Fase 3 — Distribución de IA
- Anuncio de capacidades por nodo (GPU, providers, RAM)
- Routing inteligente de peticiones de IA al nodo óptimo
- Cola de tareas distribuida para operaciones pesadas
- TTS distribuido (Kokoro en nodo con GPU)

### Fase 4 — Sincronización de datos
- Replicación de memoria de agentes con `automerge` + `hypercore`
- Skills compartidos (ClawHub descentralizado)
- Historial de conversaciones replicado
- Clipboard P2P

### Fase 5 — Seguridad y acceso
- Keypairs por nodo para autenticación
- Permisos replicados entre nodos
- Túneles temporales para acceso externo

---

## TTS relacionado

Como parte de la Fase 3, se evaluó integrar TTS local para generar audio de respuestas de IA en Telegram.

### Opciones evaluadas

| Herramienta | Tipo | Calidad | Peso | Velocidad CPU | Costo |
|---|---|---|---|---|---|
| Edge TTS | Cloud (MS gratis) | 8.5/10 | 0MB | ~3s streaming | Gratis |
| Piper | Local (VITS) | 7/10 | ~50MB | ~5s/3min | Gratis |
| Kokoro v1.0 | Local (ONNX) | 9/10 | ~350MB | ~10s/3min | Gratis |
| Coqui XTTS | Local (Docker) | 9/10 | ~2GB | ~60s CPU | Gratis |

### Recomendación TTS

- **Principal:** Edge TTS (mejor calidad, zero infra, `pip install edge-tts`)
- **Local JS:** Kokoro v1.0 vía `sherpa-onnx-node` o `kokoro-js` (mejor calidad offline)
- **Fallback offline:** Piper vía `sherpa-onnx-node` (ligero, rápido)

### Recursos necesarios para Kokoro (modelo local recomendado)

| Recurso | Kokoro necesita | Disponible en PC actual |
|---|---|---|
| RAM | ~500MB-1GB en uso | 6.6GB libres de 16GB |
| CPU | Usa todos los hilos | 8 hilos |
| Disco | ~350MB modelo | 255GB libres |
| GPU | No necesaria | — |

Flujo: Claude responde texto → Kokoro/Edge TTS genera audio → `sendVoice` a Telegram (OGG/opus).

Con el sistema P2P, la generación de TTS puede distribuirse al nodo con más recursos disponibles.
