'use strict';

const embeddings = require('../embeddings');

describe('Embeddings module', () => {
  test('supportsEmbeddings retorna true para local', () => {
    expect(embeddings.supportsEmbeddings('local')).toBe(true);
  });

  test('supportsEmbeddings retorna true para openai', () => {
    expect(embeddings.supportsEmbeddings('openai')).toBe(true);
  });

  test('supportsEmbeddings retorna true para gemini', () => {
    expect(embeddings.supportsEmbeddings('gemini')).toBe(true);
  });

  test('supportsEmbeddings retorna false para anthropic', () => {
    expect(embeddings.supportsEmbeddings('anthropic')).toBe(false);
  });

  test('supportsEmbeddings retorna false para grok', () => {
    expect(embeddings.supportsEmbeddings('grok')).toBe(false);
  });

  test('supportsEmbeddings retorna false para ollama', () => {
    expect(embeddings.supportsEmbeddings('ollama')).toBe(false);
  });

  test('EMBED_MODELS tiene local, openai, gemini', () => {
    expect(embeddings.EMBED_MODELS.local).toBeDefined();
    expect(embeddings.EMBED_MODELS.openai).toBeDefined();
    expect(embeddings.EMBED_MODELS.gemini).toBeDefined();
  });

  test('LOCAL_MODEL es bge-small', () => {
    expect(embeddings.LOCAL_MODEL).toContain('bge-small');
  });

  test('cosineSimilarity de vectores iguales es 1', () => {
    const v = [1, 0, 0, 0];
    expect(embeddings.cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test('cosineSimilarity de vectores opuestos es -1', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(embeddings.cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  test('cosineSimilarity de vectores ortogonales es 0', () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(embeddings.cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  test('cosineSimilarity con dimensiones distintas retorna 0', () => {
    const a = [1, 0, 0]; // 3 dims
    const b = [1, 0];     // 2 dims
    expect(embeddings.cosineSimilarity(a, b)).toBe(0);
  });

  test('cosineSimilarity con null retorna 0', () => {
    expect(embeddings.cosineSimilarity(null, [1, 0])).toBe(0);
    expect(embeddings.cosineSimilarity([1, 0], null)).toBe(0);
  });

  test('embed con texto vacío falla', async () => {
    await expect(embeddings.embed('', 'local')).rejects.toThrow('Texto vacío');
  });

  test('embed con provider desconocido falla', async () => {
    await expect(embeddings.embed('test', 'unknown')).rejects.toThrow('no soporta embeddings');
  });

  test('unloadLocal no crashea si no hay modelo', () => {
    expect(() => embeddings.unloadLocal()).not.toThrow();
  });
});
