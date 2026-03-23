'use strict';

/**
 * parseButtons — extrae botones inline de la sintaxis <!-- buttons: ... --> en texto de respuesta IA.
 *
 * Formato esperado: <!-- buttons: [[{"text":"Label","callback_data":"data"}]] -->
 * El array externo representa filas, cada fila es un array de botones.
 * Atajo: si se pasa un solo array (no anidado), se convierte en una fila.
 *
 * @param {string} text - Texto de respuesta del AI
 * @returns {{ text: string, buttons: object[][]|null }} - Texto limpio + botones (o null)
 */
function parseButtons(text) {
  if (!text) return { text: text || '', buttons: null };

  const regex = /<!--\s*buttons:\s*([\s\S]*?)\s*-->/;
  const match = text.match(regex);
  if (!match) return { text, buttons: null };

  try {
    let parsed = JSON.parse(match[1]);

    // Normalizar: si es array plano de objetos → envolverlo en una fila
    if (Array.isArray(parsed) && parsed.length > 0 && !Array.isArray(parsed[0])) {
      parsed = [parsed];
    }

    // Validar estructura
    if (!Array.isArray(parsed) || parsed.length === 0) return { text, buttons: null };
    for (const row of parsed) {
      if (!Array.isArray(row)) return { text, buttons: null };
      for (const btn of row) {
        if (!btn.text) return { text, buttons: null };
      }
    }

    const cleanText = text.replace(regex, '').trimEnd();
    return { text: cleanText, buttons: parsed };
  } catch {
    return { text, buttons: null };
  }
}

module.exports = parseButtons;
