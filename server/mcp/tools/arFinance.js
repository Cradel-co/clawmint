'use strict';

/**
 * mcp/tools/arFinance.js — finanzas (AR + global) + utilidades de cultura general.
 *
 * APIs free, sin key:
 *   - dolarapi.com           → cotizaciones AR (blue/oficial/MEP/CCL/cripto/turista)
 *   - api.coingecko.com      → crypto prices
 *   - open.er-api.com        → currency conversion
 *   - en/es.wikipedia.org    → resúmenes
 *   - themealdb.com          → recetas
 *   - v2.jokeapi.dev         → chistes
 *   - date.nager.at          → feriados
 */

const https = require('https');

function _getJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Clawmint/1.0', Accept: 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error(json.error || json.message || `HTTP ${res.statusCode}`));
          resolve(json);
        } catch { reject(new Error(`Respuesta no-JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── dolar_ar ───────────────────────────────────────────────────────────────

const DOLAR_AR = {
  name: 'dolar_ar',
  description: 'Cotizaciones del dólar en Argentina: blue, oficial, MEP, CCL, cripto, turista, mayorista, tarjeta. Datos en vivo de dolarapi.com (free). Devuelve compra/venta y fecha de actualización.',
  params: {
    type: '?string', // opcional: 'blue' | 'oficial' | 'mep' | 'ccl' | 'cripto' | 'turista' | 'mayorista' | 'tarjeta'. Si se omite, retorna todos.
  },
  async execute(args = {}) {
    try {
      if (args.type) {
        const t = String(args.type).toLowerCase();
        const data = await _getJson(`https://dolarapi.com/v1/dolares/${encodeURIComponent(t)}`);
        return JSON.stringify(data, null, 2);
      }
      const data = await _getJson('https://dolarapi.com/v1/dolares');
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        cotizaciones: (data || []).map(d => ({
          tipo:   d.casa,
          nombre: d.nombre,
          compra: d.compra,
          venta:  d.venta,
          fecha:  d.fechaActualizacion,
        })),
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── feriados_ar ────────────────────────────────────────────────────────────

const FERIADOS_AR = {
  name: 'feriados_ar',
  description: 'Feriados nacionales de Argentina para un año. Default: año actual. Útil para planificar viajes y consultas.',
  params: { year: '?number' },
  async execute(args = {}) {
    const year = args.year || new Date().getUTCFullYear();
    try {
      const data = await _getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/AR`);
      return JSON.stringify({
        year,
        country: 'AR',
        count: data.length,
        feriados: (data || []).map(h => ({
          fecha: h.date,
          dia:   new Date(h.date).toLocaleDateString('es-ES', { weekday: 'long' }),
          nombre: h.localName,
        })),
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── currency_convert ──────────────────────────────────────────────────────

const CURRENCY_CONVERT = {
  name: 'currency_convert',
  description: 'Convierte un monto entre dos monedas (ISO 4217: USD, EUR, ARS, BRL, GBP, etc.). Tasas oficiales free de open.er-api.com (actualizadas diariamente).',
  params: {
    amount: 'number',
    from:   'string', // ej. "USD"
    to:     'string', // ej. "ARS"
  },
  async execute(args = {}) {
    if (args.amount == null || !args.from || !args.to) return JSON.stringify({ error: 'Pasá amount, from y to.' });
    const from = String(args.from).toUpperCase();
    const to = String(args.to).toUpperCase();
    try {
      const data = await _getJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
      if (data.result !== 'success') throw new Error(data['error-type'] || 'fail');
      const rate = data.rates?.[to];
      if (rate == null) return JSON.stringify({ error: `Moneda destino "${to}" no encontrada` });
      const amount = Number(args.amount);
      return JSON.stringify({
        from, to,
        amount,
        converted: Number((amount * rate).toFixed(4)),
        rate,
        last_updated: data.time_last_update_utc,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── crypto_price ──────────────────────────────────────────────────────────

const CRYPTO_PRICE = {
  name: 'crypto_price',
  description: 'Precio actual de una o más criptomonedas en USD/EUR/ARS. Default: BTC, ETH. Coingecko free.',
  params: {
    symbols: '?string', // CSV de coingecko ids: "bitcoin,ethereum,cardano". Default "bitcoin,ethereum".
    vs:      '?string', // CSV de monedas: "usd,eur,ars". Default "usd".
  },
  async execute(args = {}) {
    const ids = (args.symbols || 'bitcoin,ethereum').toLowerCase();
    const vs  = (args.vs      || 'usd').toLowerCase();
    try {
      const data = await _getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`);
      return JSON.stringify({ timestamp: new Date().toISOString(), prices: data }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── wikipedia_summary ────────────────────────────────────────────────────

const WIKIPEDIA_SUMMARY = {
  name: 'wikipedia_summary',
  description: 'Resumen corto de un término de Wikipedia. Default: español. Útil para preguntas tipo "¿quién fue X?", "¿qué es Y?".',
  params: {
    term: 'string',
    lang: '?string', // 'es' | 'en' | 'pt'... default 'es'
  },
  async execute(args = {}) {
    if (!args.term) return JSON.stringify({ error: 'Pasá `term`.' });
    const lang = (args.lang || 'es').toLowerCase();
    const term = encodeURIComponent(args.term.replace(/\s+/g, '_'));
    try {
      const data = await _getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${term}`);
      if (data.type === 'disambiguation') {
        return JSON.stringify({
          term: args.term, lang,
          type: 'desambiguación',
          message: 'El término es ambiguo. Varios significados posibles.',
          extract: data.extract,
        });
      }
      return JSON.stringify({
        term:    data.title,
        lang,
        extract: data.extract,
        url:     data.content_urls?.desktop?.page,
        thumbnail: data.thumbnail?.source,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── recipe_random + recipe_search ────────────────────────────────────────

function _formatMeal(meal) {
  if (!meal) return null;
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const name = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (name && name.trim()) ingredients.push(`${measure?.trim() || ''} ${name.trim()}`.trim());
  }
  return {
    name:        meal.strMeal,
    category:    meal.strCategory,
    area:        meal.strArea,
    instructions: meal.strInstructions?.slice(0, 2000),
    ingredients,
    image:       meal.strMealThumb,
    youtube:     meal.strYoutube || null,
    source:      meal.strSource || null,
    tags:        meal.strTags || null,
  };
}

const RECIPE_RANDOM = {
  name: 'recipe_random',
  description: 'Receta aleatoria con ingredientes y pasos. Útil para "qué cocino hoy". TheMealDB free, sin key.',
  params: {},
  async execute() {
    try {
      const data = await _getJson('https://www.themealdb.com/api/json/v1/1/random.php');
      return JSON.stringify(_formatMeal(data?.meals?.[0]), null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

const RECIPE_SEARCH = {
  name: 'recipe_search',
  description: 'Busca recetas por nombre (en inglés generalmente). Devuelve hasta 5 con ingredientes e instrucciones.',
  params: { query: 'string' },
  async execute(args = {}) {
    if (!args.query) return JSON.stringify({ error: 'Pasá `query`.' });
    try {
      const data = await _getJson(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(args.query)}`);
      const meals = (data?.meals || []).slice(0, 5).map(_formatMeal);
      return JSON.stringify({ query: args.query, count: meals.length, meals }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

// ── joke_get ──────────────────────────────────────────────────────────────

const JOKE_GET = {
  name: 'joke_get',
  description: 'Chiste random. Default: español, family-friendly. Útil para amenizar la conversación.',
  params: {
    lang:     '?string', // 'es' | 'en' | 'de' | 'fr' | 'pt'. Default 'es'.
    category: '?string', // 'Any' | 'Misc' | 'Programming' | 'Pun'. Default 'Any'.
  },
  async execute(args = {}) {
    const lang = (args.lang || 'es').toLowerCase();
    const category = args.category || 'Any';
    try {
      const data = await _getJson(`https://v2.jokeapi.dev/joke/${encodeURIComponent(category)}?lang=${lang}&blacklistFlags=nsfw,religious,political,racist,sexist,explicit&safe-mode`);
      if (data.error) return JSON.stringify({ error: data.message || 'jokeapi error' });
      if (data.type === 'twopart') return JSON.stringify({ setup: data.setup, punchline: data.delivery, category: data.category });
      return JSON.stringify({ joke: data.joke, category: data.category });
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  },
};

module.exports = [DOLAR_AR, FERIADOS_AR, CURRENCY_CONVERT, CRYPTO_PRICE, WIKIPEDIA_SUMMARY, RECIPE_RANDOM, RECIPE_SEARCH, JOKE_GET];
