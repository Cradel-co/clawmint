# Sistema de Tareas en Background — Task Scheduler

> Diseño completo para `terminal-live/server`. Tareas persistentes en JSON que corren en segundo plano y notifican por Telegram sin depender de sesiones activas.

---

## Visión general

```
tasks.json ──→ scheduler.js ──→ runners/
                    │               ├── calendar.js   (Google Calendar via claude -p + MCP)
                    │               ├── shell.js       (comandos bash)
                    │               └── claude.js      (prompt a Claude)
                    │
                    └──→ telegram.js  (notificación directa a bot/chatId)
```

El scheduler corre dentro del proceso del servidor (`index.js`). Carga todas las tareas al arrancar, programa timers independientes por tarea y, al dispararse, ejecuta la acción y manda el aviso por Telegram al bot/chat configurado — sin necesidad de que haya un usuario conectado.

---

## Estructura de `tasks.json`

```json
[
  {
    "id": "uuid-v4",
    "name": "Google Calendar — Avisos del día",
    "enabled": true,
    "type": "interval",
    "schedule": {
      "intervalMs": 3600000,
      "startAt": null
    },
    "action": {
      "type": "calendar_check",
      "params": {
        "lookaheadHours": 25,
        "notify24h": true,
        "notify5minUnder15h": true
      }
    },
    "notify": {
      "botKey": "mi-bot",
      "chatId": 123456789
    },
    "state": {
      "lastRun": null,
      "nextRun": null,
      "notifiedEvents": {}
    }
  },
  {
    "id": "uuid-v4",
    "name": "Backup semanal",
    "enabled": true,
    "type": "cron",
    "schedule": {
      "cron": "0 3 * * 1"
    },
    "action": {
      "type": "shell",
      "params": {
        "command": "tar -czf /backups/weekly.tar.gz /home/kheiron/webapp"
      }
    },
    "notify": {
      "botKey": "mi-bot",
      "chatId": 123456789
    },
    "state": {
      "lastRun": null,
      "nextRun": null
    }
  },
  {
    "id": "uuid-v4",
    "name": "Reporte diario Claude",
    "enabled": true,
    "type": "once",
    "schedule": {
      "at": "2026-03-20T09:00:00-03:00"
    },
    "action": {
      "type": "claude",
      "params": {
        "prompt": "Resumí el estado de los proyectos en /home/kheiron y avisame si hay algo pendiente."
      }
    },
    "notify": {
      "botKey": "mi-bot",
      "chatId": 123456789
    },
    "state": {
      "lastRun": null,
      "nextRun": null,
      "done": false
    }
  }
]
```

### Tipos de schedule

| `type` | Campos en `schedule` | Descripción |
|--------|----------------------|-------------|
| `interval` | `intervalMs`, `startAt?` | Cada N milisegundos |
| `cron` | `cron` (string estándar 5 campos) | Expresión cron |
| `once` | `at` (ISO 8601) | Una sola vez en fecha/hora exacta |

### Tipos de action

| `type` | Descripción |
|--------|-------------|
| `calendar_check` | Consulta Google Calendar vía `claude -p` + MCP y evalúa proximidad de eventos |
| `shell` | Ejecuta un comando bash, manda output por Telegram |
| `claude` | Envía un prompt a Claude vía `claude -p`, manda respuesta por Telegram |

---

## Archivos a crear

```
server/
├── scheduler.js          ← Core: carga tasks.json, maneja timers
├── tasks.json            ← Base de datos de tareas (persistente)
└── runners/
    ├── calendar.js       ← Runner: calendar_check
    ├── shell.js          ← Runner: shell
    └── claude.js         ← Runner: claude
```

---

## `scheduler.js` — Diseño

```js
'use strict';

const fs   = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, 'tasks.json');

// Mapa de timers activos: taskId → { timer, intervalTimer }
const activeTimers = new Map();

// Runners por tipo de acción
const runners = {
  calendar_check: require('./runners/calendar'),
  shell:          require('./runners/shell'),
  claude:         require('./runners/claude'),
};

// ─── Carga y guarda ─────────────────────────────────────────────────────────

function loadTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]', 'utf8');
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch { return []; }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

// ─── Ejecución de una tarea ──────────────────────────────────────────────────

async function runTask(task, telegram) {
  const runner = runners[task.action.type];
  if (!runner) {
    console.error(`[Scheduler] Runner desconocido: ${task.action.type}`);
    return;
  }

  console.log(`[Scheduler] Ejecutando tarea "${task.name}" (${task.id.slice(0, 8)}…)`);

  try {
    // El runner recibe la tarea completa; puede mutar task.state para rastrear estado
    const messages = await runner.run(task);

    // messages: array de strings a mandar por Telegram (puede ser vacío si no hay nada que avisar)
    if (messages && messages.length > 0) {
      const bot = telegram.getBot(task.notify.botKey);
      if (bot) {
        for (const text of messages) {
          await bot.sendText(task.notify.chatId, text);
        }
      } else {
        console.warn(`[Scheduler] Bot "${task.notify.botKey}" no encontrado para tarea "${task.name}"`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Error en tarea "${task.name}":`, err.message);
    // Notificar el error también
    try {
      const bot = telegram.getBot(task.notify.botKey);
      if (bot) await bot.sendText(task.notify.chatId, `⚠️ Error en tarea *${task.name}*:\n${err.message}`);
    } catch {}
  }

  // Actualizar lastRun
  task.state = task.state || {};
  task.state.lastRun = new Date().toISOString();

  // Si es "once", marcar como done y cancelar timer
  if (task.type === 'once') {
    task.state.done = true;
    task.enabled = false;
    cancelTask(task.id);
  }

  // Persistir estado
  const all = loadTasks();
  const idx = all.findIndex(t => t.id === task.id);
  if (idx !== -1) { all[idx] = task; saveTasks(all); }
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

function scheduleTask(task, telegram) {
  cancelTask(task.id); // limpiar timer previo si existe
  if (!task.enabled) return;

  if (task.type === 'interval') {
    const ms = task.schedule.intervalMs;
    // Primera ejecución: ahora o en startAt
    const delay = task.schedule.startAt
      ? Math.max(0, new Date(task.schedule.startAt) - Date.now())
      : ms; // primera corrida después de 1 intervalo para no ejecutar en el boot
    const t = setTimeout(async () => {
      await runTask(task, telegram);
      // Después de la primera, repetir periódicamente
      const iv = setInterval(() => runTask(task, telegram), ms);
      activeTimers.set(task.id, { timer: null, intervalTimer: iv });
    }, delay);
    activeTimers.set(task.id, { timer: t, intervalTimer: null });
  }

  else if (task.type === 'once') {
    if (task.state?.done) return; // ya ejecutada
    const delay = Math.max(0, new Date(task.schedule.at) - Date.now());
    const t = setTimeout(() => runTask(task, telegram), delay);
    activeTimers.set(task.id, { timer: t, intervalTimer: null });
    task.state = { ...task.state, nextRun: task.schedule.at };
  }

  else if (task.type === 'cron') {
    // Usar librería `node-cron` (dependencia a agregar)
    const cron = require('node-cron');
    const job  = cron.schedule(task.schedule.cron, () => runTask(task, telegram));
    activeTimers.set(task.id, { cronJob: job });
  }
}

function cancelTask(id) {
  const entry = activeTimers.get(id);
  if (!entry) return;
  if (entry.timer)        clearTimeout(entry.timer);
  if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  if (entry.cronJob)       entry.cronJob.stop();
  activeTimers.delete(id);
}

// ─── API pública ─────────────────────────────────────────────────────────────

function init(telegram) {
  const tasks = loadTasks();
  for (const task of tasks) {
    scheduleTask(task, telegram);
    console.log(`[Scheduler] Tarea registrada: "${task.name}" (${task.type})`);
  }
  console.log(`[Scheduler] ${tasks.length} tarea(s) cargada(s).`);
}

module.exports = {
  init,
  loadTasks,
  saveTasks,
  scheduleTask,
  cancelTask,
  runTask,
};
```

---

## `runners/calendar.js` — Runner de Google Calendar

### Lógica de notificaciones

```
Tarea corre cada 1 hora
│
├─ Para cada evento en las próximas 25h:
│     │
│     ├─ Si faltan entre 23h y 25h  → aviso "24h antes" (solo 1 vez por evento)
│     │
│     └─ Si faltan ≤ 15h            → aviso cada 5 min (rastreado en state.notifiedEvents)
│
└─ state.notifiedEvents = {
       "event-id": {
           notified24h: true,
           last5minNotify: 1710000000000   ← timestamp del último aviso de 5min
       }
   }
```

```js
'use strict';

const { spawn } = require('child_process');

const PROMPT_TEMPLATE = `
Usando el MCP de Google Calendar, obtené todos los eventos de las próximas 25 horas.
Para cada evento devolvé un JSON con este formato exacto (sin texto extra, solo JSON):
[
  {
    "id": "event-id-unico",
    "title": "Título del evento",
    "start": "2026-03-16T10:00:00-03:00",
    "description": "descripción opcional"
  }
]
Si no hay eventos, devolvé: []
`.trim();

async function fetchCalendarEvents() {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--dangerously-skip-permissions',
      '-p', PROMPT_TEMPLATE,
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ], {
      cwd: process.env.HOME,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let fullText = '';
    let lineBuffer = '';

    child.stdout.on('data', chunk => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line.trim());
          if (event.type === 'result' && event.result) fullText = event.result;
          if (event.type === 'assistant') {
            const textBlock = event.message?.content?.find(b => b.type === 'text');
            if (textBlock?.text) fullText = textBlock.text;
          }
        } catch {}
      }
    });

    child.on('close', (code) => {
      try {
        // Extraer el JSON del output (puede tener texto extra alrededor)
        const match = fullText.match(/\[[\s\S]*\]/);
        if (!match) return resolve([]);
        resolve(JSON.parse(match[0]));
      } catch {
        resolve([]);
      }
    });

    setTimeout(() => { child.kill(); reject(new Error('Timeout consultando Google Calendar')); }, 60000);
  });
}

async function run(task) {
  const params  = task.action.params || {};
  const state   = task.state || {};
  const noticed = state.notifiedEvents || {};
  const now     = Date.now();
  const messages = [];

  const events = await fetchCalendarEvents();

  for (const ev of events) {
    const startMs   = new Date(ev.start).getTime();
    const diffMs    = startMs - now;
    const diffHours = diffMs / 3600000;
    const diffMins  = diffMs / 60000;

    if (diffMs < 0) continue; // ya pasó

    const evState = noticed[ev.id] || { notified24h: false, last5minNotify: 0 };

    // Aviso 24h antes (ventana: entre 23h y 25h)
    if (params.notify24h && !evState.notified24h && diffHours >= 23 && diffHours <= 25) {
      const horasTexto = `${Math.floor(diffHours)}h ${Math.round((diffHours % 1) * 60)}min`;
      messages.push(
        `📅 *Recordatorio 24h* — ${ev.title}\n` +
        `⏰ Empieza en: ${horasTexto}\n` +
        `🕐 Hora: ${new Date(ev.start).toLocaleString('es-AR')}\n` +
        (ev.description ? `📝 ${ev.description.slice(0, 200)}` : '')
      );
      evState.notified24h = true;
    }

    // Avisos cada 5 min cuando faltan ≤ 15h
    if (params.notify5minUnder15h && diffHours <= 15 && diffMins > 0) {
      const msSinceLastNotify = now - (evState.last5minNotify || 0);
      const FIVE_MIN_MS = 5 * 60 * 1000;

      if (msSinceLastNotify >= FIVE_MIN_MS) {
        const mins = Math.round(diffMins);
        const urgency = mins <= 30 ? '🔴' : mins <= 60 ? '🟠' : '🟡';
        messages.push(
          `${urgency} *${ev.title}*\n` +
          `⏳ Faltan *${mins} minutos*\n` +
          `🕐 ${new Date(ev.start).toLocaleString('es-AR')}`
        );
        evState.last5minNotify = now;
      }
    }

    noticed[ev.id] = evState;
  }

  // Limpiar eventos pasados del state para no acumular indefinidamente
  for (const id of Object.keys(noticed)) {
    const ev = events.find(e => e.id === id);
    if (!ev || new Date(ev.start).getTime() < now) {
      delete noticed[id];
    }
  }

  task.state = { ...state, notifiedEvents: noticed };
  return messages;
}

module.exports = { run };
```

---

## `runners/shell.js` — Runner de comandos bash

```js
'use strict';
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function run(task) {
  const { command } = task.action.params;
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000, cwd: process.env.HOME });
    const output = (stdout + stderr).slice(0, 3000).trim();
    if (!output) return [];
    return [`🖥️ *${task.name}*\n\`\`\`\n${output}\n\`\`\``];
  } catch (err) {
    return [`❌ *${task.name}* falló:\n${err.message.slice(0, 500)}`];
  }
}

module.exports = { run };
```

---

## `runners/claude.js` — Runner de prompt a Claude

```js
'use strict';
// Reutiliza ClaudePrintSession de telegram.js o crea una versión standalone
const { spawn } = require('child_process');

async function run(task) {
  const { prompt } = task.action.params;
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '--dangerously-skip-permissions',
      '-p', prompt,
      '--output-format', 'stream-json',
    ], { cwd: process.env.HOME, env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] });

    let result = '';
    let buf = '';
    child.stdout.on('data', c => {
      buf += c.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        try { const e = JSON.parse(l); if (e.type === 'result') result = e.result || ''; } catch {}
      }
    });
    child.on('close', () => resolve(result.trim() ? [`🤖 *${task.name}*\n\n${result.trim().slice(0, 3500)}`] : []));
    setTimeout(() => { child.kill(); resolve([`⚠️ *${task.name}* timeout`]); }, 120000);
  });
}

module.exports = { run };
```

---

## Integración en `index.js`

```js
// Al final de los módulos (línea 70)
const scheduler = require('./scheduler');

// Después de iniciar bots de Telegram (línea ~675)
server.listen(PORT, async () => {
  await telegram.loadAndStart();

  // ← Agregar esto:
  scheduler.init(telegram);
});
```

### Endpoints REST a agregar

```
GET    /api/tasks              — listar tareas
POST   /api/tasks              — crear tarea
PATCH  /api/tasks/:id          — actualizar (enable/disable, schedule, etc.)
DELETE /api/tasks/:id          — eliminar tarea
POST   /api/tasks/:id/run      — ejecutar ahora (manual trigger)
```

---

## Dependencias a agregar

```bash
npm install node-cron uuid
```

- `node-cron` — para tipo `cron` (expresiones estándar 5 campos)
- `uuid` — para generar IDs de tarea (`v4`)
- Google Calendar MCP debe estar configurado en `~/.claude/settings.json` bajo `mcpServers`

---

## Ejemplo de configuración MCP para Google Calendar

Agregar en `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-google-calendar"],
      "env": {
        "GOOGLE_CLIENT_ID": "...",
        "GOOGLE_CLIENT_SECRET": "...",
        "GOOGLE_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

---

## Flujo completo — ejemplo Google Calendar

```
Boot del servidor
    └─→ scheduler.init(telegram)
            └─→ scheduleTask("Google Calendar — Avisos del día")
                    └─→ setInterval(runTask, 3600000)  ← cada 1 hora

Cada 1 hora:
    runTask()
        └─→ runners/calendar.run(task)
                └─→ spawn('claude -p <PROMPT_TEMPLATE>')
                        └─→ Claude usa MCP Google Calendar
                        └─→ Devuelve eventos JSON
                └─→ Para cada evento:
                        ├─ Si 23h ≤ diff ≤ 25h  → push "aviso 24h"
                        └─ Si diff ≤ 15h y han pasado 5min → push "aviso urgente"
        └─→ bot.sendText(chatId, message) por cada aviso
        └─→ task.state.notifiedEvents actualizado y guardado en tasks.json
```

---

## Estado de implementación

- [ ] Crear `server/scheduler.js`
- [ ] Crear `server/runners/calendar.js`
- [ ] Crear `server/runners/shell.js`
- [ ] Crear `server/runners/claude.js`
- [ ] Crear `server/tasks.json` (vacío: `[]`)
- [ ] Agregar endpoints REST en `index.js`
- [ ] Integrar `scheduler.init(telegram)` en el boot
- [ ] Agregar `node-cron` y `uuid` a `package.json`
- [ ] Configurar MCP de Google Calendar en `~/.claude/settings.json`
- [ ] Agregar soporte de tareas en la UI del cliente (panel web)
