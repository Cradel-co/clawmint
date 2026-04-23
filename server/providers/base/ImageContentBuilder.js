'use strict';

/**
 * ImageContentBuilder — construye el content multimodal uniforme según el provider,
 * consultando capabilities antes de incluir imágenes.
 *
 * Centraliza la lógica que antes estaba repetida en ConversationService.js:821-843.
 * Si el provider no soporta imágenes, las describe con minicpm-v (vía ollama.describeImage)
 * en lugar de ignorarlas silenciosamente.
 *
 * Formato canónico de imagen de entrada:
 *   { mediaType: 'image/png'|'image/jpeg'|..., base64: '...', sourceUrl?: '...' }
 */

const capabilities = require('../capabilities');

/** Providers conocidos y cómo construyen el content de imágenes */
const BUILDERS = {
  anthropic: (images, text) => {
    const parts = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    }));
    if (text) parts.push({ type: 'text', text });
    return parts;
  },

  openai: (images, text) => {
    const parts = images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
    }));
    if (text) parts.push({ type: 'text', text });
    return parts;
  },

  grok: (images, text) => BUILDERS.openai(images, text),

  gemini: (_images, text) => {
    // Gemini recibe las imágenes como parts separados en el provider.
    // Acá devolvemos solo el texto; el provider combina con images en extraOpts._images.
    return text || '';
  },

  ollama: (images, text) => {
    // Ollama nativo: `images: [base64, base64, ...]` en el message
    return { content: text || '', images: images.map(img => img.base64) };
  },
};

/**
 * Construye el content multimodal para un provider.
 * @param {string} providerName
 * @param {Array<{mediaType: string, base64: string}>} images
 * @param {string} text
 * @returns {*} content apto para pasar al provider; formato depende del provider
 */
function build(providerName, images, text) {
  const imgs = Array.isArray(images) ? images.filter(img => img && img.base64) : [];
  if (imgs.length === 0) return text;

  const caps = capabilities.get(providerName);
  if (!caps.images) {
    // Provider no soporta imágenes — devolver texto con marcador para posterior describe()
    return {
      __unsupported: true,
      images: imgs,
      text: text || '',
    };
  }

  const builder = BUILDERS[providerName];
  if (!builder) return text; // provider desconocido

  return builder(imgs, text || '');
}

/**
 * Fallback: si `build()` devolvió `{ __unsupported: true }`, llamar a `describeFn`
 * para convertir imágenes a texto descriptivo (ej: ollama.describeImage).
 * @param {{__unsupported: boolean, images, text}} content
 * @param {Function} describeFn — async (base64, mediaType) => string
 * @returns {Promise<string>}
 */
async function describeFallback(content, describeFn) {
  if (!content || !content.__unsupported) return content;
  if (typeof describeFn !== 'function') {
    return `${content.text || ''}\n\n[imagen(es) no soportada(s) por el provider — describe fallback no disponible]`.trim();
  }
  const parts = [];
  for (let i = 0; i < content.images.length; i++) {
    try {
      const desc = await describeFn(content.images[i].base64, content.images[i].mediaType);
      parts.push(`[imagen ${i + 1} descrita: ${String(desc).trim()}]`);
    } catch (err) {
      parts.push(`[imagen ${i + 1}: no se pudo describir (${err.message})]`);
    }
  }
  return `${parts.join('\n')}\n\n${content.text || ''}`.trim();
}

module.exports = { build, describeFallback };
