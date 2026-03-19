# Fix: evitar mezclar turnos anteriores en respuestas streaming

**Commit:** `a3d8fbc`
**Fecha:** 2026-03-16
**Archivo:** `server/telegram.js` — clase `ClaudePrintSession`

## Problema

Al usar `claude --continue`, los eventos `assistant` y `result` del stream podían
sobreescribir el texto ya acumulado via deltas (`text_delta`) con contenido de
**turnos anteriores de la sesión**. El resultado era que la respuesta mostrada en
Telegram mezclaba o reemplazaba el texto del turno actual por el de uno previo.

## Causa

El manejador del evento `assistant` usaba la condición:

```js
if (textBlock?.text && textBlock.text.length > fullText.length)
```

Esto permitía que el bloque de texto del evento `assistant` —que puede contener
el historial acumulado de la sesión— reemplazara los deltas si era más largo.

El manejador del evento `result` sobreescribía `fullText` incondicionalmente:

```js
if (event.result) fullText = event.result;
```

## Solución

Ambos eventos ahora se usan **solo como fallback**: si el streaming de deltas
no produjo ningún texto (`!fullText`), entonces se toma el valor del evento.
Si los deltas ya acumularon texto, se ignoran `assistant` y `result`.

```js
// assistant event (fallback)
if (textBlock?.text && !fullText) {
  fullText = textBlock.text;
  if (onChunk) onChunk(fullText);
}

// result event (fallback)
if (event.result && !fullText) fullText = event.result;
```

## Estado

✅ **IMPLEMENTADO y en producción.** Commit `a3d8fbc` mergeado a `main` y publicado en GitHub. La lógica ahora vive en `server/core/ClaudePrintSession.js` (refactorizado desde `telegram.js`).
