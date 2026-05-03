'use strict';

/**
 * TitleGenerator — genera títulos cortos para conversaciones de WebChat.
 *
 * Llama al provider más barato disponible (anthropic/haiku, openai/gpt-4o-mini, gemini/flash-lite)
 * con un prompt mínimo. Si ninguno tiene API key, fallback al primer mensaje del usuario truncado.
 *
 * Uso:
 *   const tg = new TitleGenerator({ providers, providerConfig, logger });
 *   const title = await tg.generate(userMsg, assistantMsg);
 */

const FALLBACK_PROVIDERS = [
  { name: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  { name: 'openai',    model: 'gpt-4o-mini' },
  { name: 'gemini',    model: 'gemini-2.5-flash-lite' },
  { name: 'grok',      model: 'grok-3-mini' },
  { name: 'deepseek',  model: 'deepseek-chat' },
];

const PROMPT = `Generá un título de máximo 5 palabras para esta conversación. Solo el título, sin comillas ni puntuación final. En español.`;

class TitleGenerator {
  constructor({ providers, providerConfig, logger } = {}) {
    this._providers      = providers || null;
    this._providerConfig = providerConfig || null;
    this._logger         = logger || console;
  }

  /**
   * Devuelve un título corto. Garantiza nunca-throw — devuelve fallback si algo falla.
   * @param {string} userMsg
   * @param {string} assistantMsg
   * @returns {Promise<string>} título (máx 60 chars)
   */
  async generate(userMsg, assistantMsg) {
    const fallback = this._fallback(userMsg);

    if (!this._providers || !this._providerConfig) return fallback;

    // Probar providers en orden hasta encontrar uno con API key.
    for (const cand of FALLBACK_PROVIDERS) {
      const provObj = this._providers.get(cand.name);
      if (!provObj) continue;
      const apiKey = this._providerConfig.getApiKey?.(cand.name);
      if (!apiKey) continue;

      try {
        const title = await this._askProvider(provObj, apiKey, cand.model, userMsg, assistantMsg);
        if (title) return this._sanitize(title);
      } catch (err) {
        this._logger.warn?.(`[TitleGenerator] ${cand.name} falló: ${err.message}`);
      }
    }

    return fallback;
  }

  async _askProvider(provObj, apiKey, model, userMsg, assistantMsg) {
    const conversation = `Usuario: ${(userMsg || '').slice(0, 500)}\nAsistente: ${(assistantMsg || '').slice(0, 200)}`;
    const history = [{ role: 'user', content: `${conversation}\n\n${PROMPT}` }];

    let accumulated = '';
    const gen = provObj.chat({
      systemPrompt: 'Sos un titulador conciso. Respondés solo con el título pedido.',
      history,
      apiKey,
      model,
      // sin tools, sin canal, sin nada — pure completion
      executeTool: async () => 'noop',
    });

    // Timeout duro: 8s
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));

    const collect = (async () => {
      for await (const ev of gen) {
        if (ev.type === 'text') accumulated += ev.text;
        else if (ev.type === 'done') accumulated = ev.fullText || accumulated;
      }
      return accumulated;
    })();

    const text = await Promise.race([collect, timeoutPromise]);
    return (text || '').trim();
  }

  _sanitize(title) {
    return title
      .replace(/^[\s"'`*_-]+|[\s"'`*_.\-]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 60)
      .trim();
  }

  _fallback(userMsg) {
    const t = (userMsg || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'Conversación';
    return t.length > 50 ? t.slice(0, 50) + '…' : t;
  }
}

module.exports = TitleGenerator;
