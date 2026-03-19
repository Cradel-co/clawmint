'use strict';

const path = require('path');
const os   = require('os');

// ─── Estado singleton ────────────────────────────────────────────────────────

let _pipeline = null;
let _loadingPromise = null;
let _idleTimer = null;
let _loadedDtype = null;

const DEFAULT_MODEL   = 'Xenova/speecht5_tts';
const VOCODER         = 'Xenova/speecht5_hifigan';
const SPEAKER_URL     = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TEXT_LENGTH  = 500;

// ─── Umbrales de memoria por dtype ──────────────────────────────────────────

const DTYPE_THRESHOLDS = [
  { dtype: 'fp16', minFree: 500 * 1024 * 1024 },
  { dtype: 'q8',   minFree: 250 * 1024 * 1024 },
];

function _resolveDtype() {
  const free = os.freemem();
  for (const { dtype, minFree } of DTYPE_THRESHOLDS) {
    if (free >= minFree) return dtype;
  }
  const freeMB = Math.round(free / 1024 / 1024);
  throw new Error(`Memoria insuficiente para TTS: minimo ~250MB, disponible ${freeMB}MB`);
}

async function _loadModel(modelId) {
  if (_pipeline) {
    _resetIdleTimer();
    return _pipeline;
  }
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    try {
      const dtype = _resolveDtype();
      const model = modelId || DEFAULT_MODEL;
      console.log(`[tts:speecht5] Cargando modelo ${model} (dtype: ${dtype})...`);
      const { pipeline: pipelineFn, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, '..', 'models-cache');
      _pipeline = await pipelineFn('text-to-speech', model, { dtype, device: 'cpu' });
      _loadedDtype = dtype;
      console.log(`[tts:speecht5] Modelo ${model} cargado (dtype: ${dtype})`);
      _resetIdleTimer();
      return _pipeline;
    } catch (err) {
      _pipeline = null;
      _loadedDtype = null;
      throw err;
    } finally {
      _loadingPromise = null;
    }
  })();
  return _loadingPromise;
}

function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _unloadModel(), IDLE_TIMEOUT_MS);
}

function _unloadModel() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_pipeline) {
    _pipeline = null;
    _loadedDtype = null;
    console.log(`[tts:speecht5] Modelo descargado`);
    if (typeof global.gc === 'function') global.gc();
  }
}

// ─── Conversión audio ────────────────────────────────────────────────────────

function _float32ToWavBuffer(float32Array, sampleRate) {
  const numSamples = float32Array.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    let sample = Math.max(-1, Math.min(1, float32Array[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    buffer.writeInt16LE(Math.round(int16), 44 + i * 2);
  }

  return buffer;
}

// ─── Módulo exportado ────────────────────────────────────────────────────────

module.exports = {
  name: 'speecht5',
  label: 'SpeechT5 (local)',
  type: 'local',
  voices: [],
  defaultVoice: null,
  models: [DEFAULT_MODEL],
  defaultModel: DEFAULT_MODEL,

  async synthesize({ text, model }) {
    if (!text || !text.trim()) return null;
    const truncated = text.slice(0, MAX_TEXT_LENGTH);
    const pipe = await _loadModel(model);
    const result = await pipe(truncated, { speaker_embeddings: SPEAKER_URL });
    _resetIdleTimer();
    return _float32ToWavBuffer(result.audio, result.sampling_rate);
  },

  async preload(model) {
    try {
      await _loadModel(model);
      console.log(`[tts:speecht5] Modelo precargado`);
    } catch (err) {
      console.error(`[tts:speecht5] Error al precargar: ${err.message}`);
    }
  },

  unload() { _unloadModel(); },
  getLoadedDtype() { return _loadedDtype; },
};
