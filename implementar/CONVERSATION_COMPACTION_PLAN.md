# Plan: Compactación de Conversaciones

## El problema

Las conversaciones largas acumulan tokens. A medida que crece el historial:
- El costo por mensaje sube linealmente
- El modelo pierde foco en contexto lejano
- Eventualmente se alcanza el límite del context window

La solución no es truncar — es **comprimir y consolidar en memoria** antes de que explote.

---

## La idea central

Cuando la conversación supera un umbral de tokens:

```
1. Extraer lo importante de la conversación → guardar en memoria con tags + embeddings
2. Comprimir el historial → un resumen compacto
3. Iniciar nueva sesión con: sistema + memoria relevante + resumen compacto
```

El modelo "olvida" los detalles pero **recuerda lo importante** vía la memoria persistente.
Imita cómo el cerebro consolida memorias durante el sueño.

---

## Cuándo disparar la compactación

### Opción A — Umbral fijo de tokens
```
if (conversationTokens > THRESHOLD) → disparar compactación
```
Threshold sugerido: 80% del context window del modelo (dejar margen para la respuesta).

### Opción B — Proactivo por turnos
Cada N turnos hacer una mini-compactación parcial (más suave, menos disruptivo).

### Opción C — Híbrido (recomendado)
- Cada 10 turnos: mini-compactación (extraer y guardar sin reiniciar sesión)
- Al 80% del context window: compactación completa y nueva sesión

---

## Dos modos según contexto

| Contexto | Quién detecta | Quién compacta |
|----------|---------------|----------------|
| **Claude Code** | El modelo monitorea sus propios tokens | El modelo ejecuta el proceso, escribe archivos directamente |
| **API** (`startClaudeSession`) | El servidor cuenta tokens del historial | El servidor dispara un request de compactación al LLM y reinicia la sesión |

---

## El proceso de compactación

### Paso 1 — Extracción (qué salvar a memoria)

Pedir al LLM que analice la conversación y extraiga en categorías:

```
- Decisiones tomadas
- Preferencias del usuario detectadas
- Problemas encontrados y cómo se resolvieron
- Patrones de código o arquitectura definidos
- Contexto del proyecto relevante
- Preguntas abiertas / pendientes
```

Cada extracción se guarda como un chunk en memoria con:
- `tags[]` apropiados al contenido
- `embedding` si está disponible
- `title` descriptivo

### Paso 2 — Compresión del historial

Pedir al LLM un resumen de la conversación en formato compacto:

```markdown
## Resumen de sesión [fecha]

**Contexto:** [en qué se estaba trabajando]
**Lo que se hizo:** [acciones tomadas]
**Estado actual:** [dónde quedó el trabajo]
**Pendiente:** [qué falta resolver]
```

Este resumen tiene un cap de tokens (ej. 500 tokens máximo).

### Paso 3 — Nueva sesión

La nueva sesión arranca con:

```
[CACHEABLE] system prompt del agente
[CACHEABLE] MEMORY.md instrucciones
[DINÁMICO]  chunks de memoria relevantes al resumen (via tags/embeddings)
[DINÁMICO]  resumen compacto de la sesión anterior
```

El modelo retoma desde el resumen como si fuera contexto fresco.

---

## Qué NO guardar en memoria durante la compactación

- Código completo (solo el patrón o decisión)
- Conversación literal (solo la extracción semántica)
- Errores temporales que ya se resolvieron y no enseñan nada
- Detalles de debugging irrelevantes a futuro

---

## Formato de chunks generados por compactación

Los chunks guardados automáticamente deben tener frontmatter como cualquier otro:

```markdown
---
title: Decisión — usar SQLite para índice de memoria
tags: [arquitectura, memoria, sqlite, decisiones]
links: [memory-system]
source: compaction
session: 2026-03-15
---
Se decidió usar SQLite como índice de búsqueda para el sistema de memoria,
con los archivos .md como source of truth. El DB se puede reconstruir
desde los archivos si se borra.
```

El campo `source: compaction` permite distinguir chunks auto-generados
de los que escribió el agente manualmente.

---

## Integración con el sistema de memoria

La compactación alimenta el mismo DB de memoria. No hay sistema separado:

```
Conversación normal → agente guarda chunks manualmente
Compactación        → sistema guarda chunks automáticamente
                      ↓
                   mismo SQLite, mismos tags, mismos embeddings
                   misma visualización en el grafo
```

Los chunks de compactación aparecen en el grafo conectados por sus tags,
mezclados naturalmente con la memoria manual.

---

## Schema adicional para tracking

Agregar a la tabla `notes` en SQLite:

```sql
source       TEXT DEFAULT 'manual',    -- 'manual' | 'compaction'
session_date TEXT,                     -- fecha de la sesión de origen
access_count INTEGER DEFAULT 0,        -- veces que se recuperó (para decay)
last_accessed DATETIME                 -- para calcular decay de relevancia
```

---

## Preguntas abiertas

- ¿El resumen de sesión se guarda también en memoria o solo se usa como puente?
- ¿Cuánto del context window reservar para los chunks inyectados vs. el resumen?
- ¿La compactación parcial (cada N turnos) reinicia sesión o solo guarda sin interrumpir?

---

## Escalabilidad a largo plazo

Con un año de compactaciones el DB crece sin control — miles de chunks,
muchos obsoletos o redundantes. Guardar más no es la solución.

El cerebro resuelve esto con mecanismos de olvido y consolidación.
El sistema necesita los mismos.

---

### 1. Olvido activo (decay)

Lo que no se accede se degrada y eventualmente desaparece:

```
score_final = relevancia × decay(días_sin_acceso)

Si score_final < umbral mínimo → archivar → eventualmente eliminar
```

Chunks que nadie recuperó en 6 meses probablemente ya no importan.

---

### 2. Consolidación periódica

En lugar de acumular 50 chunks sobre el mismo tema, el sistema los fusiona
en uno solo más rico. Los originales se archivan.

```
Episodios específicos (muchos, pequeños)
       ↓  consolidación mensual
Patrón semántico (uno, denso, más valioso)
```

Igual que el cerebro convierte memorias episódicas en semánticas con el tiempo.
La consolidación se dispara cuando hay N chunks con tags muy solapados.

---

### 3. Memoria por niveles (tiered)

| Tier | Contenido | Velocidad | Comportamiento |
|------|-----------|-----------|----------------|
| **Activa** | últimos 30 días o access_count alto | rápido | siempre en queries |
| **Tibia** | 1-6 meses, poco acceso | medio | solo si hay match fuerte |
| **Archivo** | +6 meses, sin acceso | lento | solo búsqueda explícita |
| **Eliminado** | +1 año, acceso = 0 | — | gone |

La query normal solo toca el tier activo.
El DB activo se mantiene pequeño sin importar cuánto tiempo lleve el sistema corriendo.

---

### 4. El ciclo completo

```
Conversación → compactación → chunks guardados
                                    ↓
                             decay degrada los viejos
                             consolidación fusiona similares
                             tiering mueve lo frío al archivo
                                    ↓
                        DB activo: siempre ~50-100 chunks relevantes
```

Con un año de uso el tier activo tiene los mismos ~50-100 chunks que el primer mes.
El costo de tokens no crece con el tiempo.

---

### Schema adicional para soportar tiering y consolidación

```sql
ALTER TABLE notes ADD COLUMN tier         TEXT DEFAULT 'active';
                                          -- 'active' | 'warm' | 'archive'
ALTER TABLE notes ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_accessed DATETIME;
ALTER TABLE notes ADD COLUMN consolidated_into INTEGER REFERENCES notes(id);
                                          -- apunta al chunk fusionado si fue consolidado
```

### Job periódico (ejecutado por el servidor, ej. cada noche)

```
1. Calcular decay de todos los chunks activos
2. Mover a 'warm' los que cayeron bajo umbral
3. Mover a 'archive' los que llevan 6 meses en 'warm'
4. Eliminar los que llevan 1 año en 'archive' con access_count = 0
5. Buscar grupos de chunks con tags muy solapados → consolidar → archivar originales
```
