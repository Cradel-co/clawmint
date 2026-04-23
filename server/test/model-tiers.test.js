'use strict';

const modelTiers = require('../providers/modelTiers');

function withEnv(envPatch, fn) {
  const orig = { ...process.env };
  Object.assign(process.env, envPatch);
  // Quitar keys que el patch explícitamente pone a undefined
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete process.env[k];
  }
  modelTiers._reset();
  try { fn(); }
  finally {
    process.env = orig;
    modelTiers._reset();
  }
}

describe('modelTiers — defaults', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (/_MODEL$/.test(k) || k === 'MODEL_TIERS_JSON') delete process.env[k];
    }
    modelTiers._reset();
  });

  test('anthropic cheap → claude-haiku-4-5', () => {
    expect(modelTiers.resolveModelForTier('anthropic', 'cheap')).toBe('claude-haiku-4-5');
  });

  test('openai premium → gpt-5', () => {
    expect(modelTiers.resolveModelForTier('openai', 'premium')).toBe('gpt-5');
  });

  test('gemini balanced → gemini-2.5-flash', () => {
    expect(modelTiers.resolveModelForTier('gemini', 'balanced')).toBe('gemini-2.5-flash');
  });

  test('ollama reasoning → qwen2.5:72b', () => {
    expect(modelTiers.resolveModelForTier('ollama', 'reasoning')).toBe('qwen2.5:72b');
  });

  test('provider desconocido → null', () => {
    expect(modelTiers.resolveModelForTier('nonexistent', 'cheap')).toBeNull();
  });

  test('tier desconocido → cae a balanced', () => {
    // 'wrong' no es un tier válido → FALLBACK_UP default es balanced chain
    expect(modelTiers.resolveModelForTier('anthropic', 'wrong')).toBe('claude-sonnet-4-6');
  });

  test('case-insensitive en tier', () => {
    expect(modelTiers.resolveModelForTier('anthropic', 'CHEAP')).toBe('claude-haiku-4-5');
    expect(modelTiers.resolveModelForTier('anthropic', 'Cheap')).toBe('claude-haiku-4-5');
  });
});

describe('modelTiers — env overrides', () => {
  test('ANTHROPIC_CHEAP_MODEL sobrescribe default', () => {
    withEnv({ ANTHROPIC_CHEAP_MODEL: 'claude-haiku-custom' }, () => {
      expect(modelTiers.resolveModelForTier('anthropic', 'cheap')).toBe('claude-haiku-custom');
    });
  });

  test('override per-tier no afecta otros tiers', () => {
    withEnv({ OPENAI_CHEAP_MODEL: 'custom-mini' }, () => {
      expect(modelTiers.resolveModelForTier('openai', 'cheap')).toBe('custom-mini');
      expect(modelTiers.resolveModelForTier('openai', 'premium')).toBe('gpt-5');
    });
  });

  test('MODEL_TIERS_JSON override completo', () => {
    const override = { anthropic: { cheap: 'custom-1', balanced: 'custom-2', premium: 'custom-3', reasoning: 'custom-4' } };
    withEnv({ MODEL_TIERS_JSON: JSON.stringify(override) }, () => {
      expect(modelTiers.resolveModelForTier('anthropic', 'cheap')).toBe('custom-1');
      expect(modelTiers.resolveModelForTier('anthropic', 'premium')).toBe('custom-3');
    });
  });

  test('env var individual pisa MODEL_TIERS_JSON', () => {
    const json = { anthropic: { cheap: 'from-json' } };
    withEnv({
      MODEL_TIERS_JSON: JSON.stringify(json),
      ANTHROPIC_CHEAP_MODEL: 'from-env-var',
    }, () => {
      expect(modelTiers.resolveModelForTier('anthropic', 'cheap')).toBe('from-env-var');
    });
  });

  test('MODEL_TIERS_JSON inválido no rompe el arranque (ignora)', () => {
    withEnv({ MODEL_TIERS_JSON: 'not-valid-json-}' }, () => {
      expect(modelTiers.resolveModelForTier('anthropic', 'cheap')).toBe('claude-haiku-4-5');
    });
  });

  test('provider nuevo introducido por JSON override', () => {
    const json = { myProvider: { cheap: 'my-cheap-model', balanced: 'my-balanced-model' } };
    withEnv({ MODEL_TIERS_JSON: JSON.stringify(json) }, () => {
      expect(modelTiers.resolveModelForTier('myProvider', 'cheap')).toBe('my-cheap-model');
      expect(modelTiers.resolveModelForTier('myProvider', 'balanced')).toBe('my-balanced-model');
      // Tiers faltantes caen en cascada hacia arriba
      expect(modelTiers.resolveModelForTier('myProvider', 'premium')).toBe('my-balanced-model');
    });
  });
});

describe('modelTiers — fallback cascade', () => {
  test('deepseek (cheap=chat, reasoning=reasoner) — reasoning se respeta', () => {
    expect(modelTiers.resolveModelForTier('deepseek', 'reasoning')).toBe('deepseek-reasoner');
  });

  test('cheap cae a balanced si cheap=null', () => {
    const json = { test: { balanced: 'balanced-only', premium: 'premium-only' } };
    withEnv({ MODEL_TIERS_JSON: JSON.stringify(json) }, () => {
      expect(modelTiers.resolveModelForTier('test', 'cheap')).toBe('balanced-only');
    });
  });

  test('premium cae a reasoning si premium=null', () => {
    const json = { test: { reasoning: 'reasoning-only' } };
    withEnv({ MODEL_TIERS_JSON: JSON.stringify(json) }, () => {
      expect(modelTiers.resolveModelForTier('test', 'premium')).toBe('reasoning-only');
    });
  });

  test('todo null → null', () => {
    const json = { empty: {} };
    withEnv({ MODEL_TIERS_JSON: JSON.stringify(json) }, () => {
      expect(modelTiers.resolveModelForTier('empty', 'cheap')).toBeNull();
    });
  });
});

describe('modelTiers — getCatalog', () => {
  test('retorna catálogo con todos los providers y tiers resueltos', () => {
    modelTiers._reset();
    const cat = modelTiers.getCatalog();
    expect(cat.anthropic).toBeDefined();
    expect(cat.openai).toBeDefined();
    expect(cat.anthropic.cheap).toBe('claude-haiku-4-5');
    expect(cat.anthropic.premium).toBe('claude-opus-4-7');
  });
});
