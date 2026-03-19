'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Estado singleton ────────────────────────────────────────────────────────

let _pipeline = null;
let _loadingPromise = null;
let _idleTimer = null;
let _loadedDtype = null;

// ─── Configuración por defecto ───────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'tts-config.json');

const DEFAULTS = {
  enabled: false,
  model: 'Xenova/speecht5_tts',
  vocoder: 'Xenova/speecht5_hifigan',
  speaker: 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin',
  maxTextLength: 500,
  idleTimeoutMs: 5 * 60 * 1000,
};

// Cargar config persistida al iniciar
try {
  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(DEFAULTS, saved);
} catch {}

function _saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n'); } catch {}
}

// ─── Umbrales de memoria por dtype ──────────────────────────────────────────
// SpeechT5 (~540MB fp32) + HiFiGAN vocoder (~100MB fp32) + overhead
// fp16: ~385MB total | q8: ~190MB total

const DTYPE_THRESHOLDS = [
  { dtype: 'fp16', minFree: 500 * 1024 * 1024 },   // ~385MB modelo + margen
  { dtype: 'q8',   minFree: 250 * 1024 * 1024 },   // ~190MB modelo + margen
];

// ─── Funciones internas ──────────────────────────────────────────────────────

function _resolveDtype() {
  const free = os.freemem();
  for (const { dtype, minFree } of DTYPE_THRESHOLDS) {
    if (free >= minFree) return dtype;
  }
  const freeMB = Math.round(free / 1024 / 1024);
  throw new Error(`Memoria insuficiente para TTS: mínimo ~250MB, disponible ${freeMB}MB`);
}

async function _loadModel() {
  if (_pipeline) {
    _resetIdleTimer();
    return _pipeline;
  }
  if (_loadingPromise) {
    return _loadingPromise;
  }
  _loadingPromise = (async () => {
    try {
      const dtype = _resolveDtype();
      console.log(`[tts] Cargando modelo ${DEFAULTS.model} (dtype: ${dtype})...`);
      const { pipeline: pipelineFn, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, 'models-cache');
      _pipeline = await pipelineFn('text-to-speech', DEFAULTS.model, {
        dtype,
        device: 'cpu',
      });
      _loadedDtype = dtype;
      console.log(`[tts] Modelo ${DEFAULTS.model} cargado (dtype: ${dtype})`);
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
  _idleTimer = setTimeout(() => _unloadModel(), DEFAULTS.idleTimeoutMs);
}

function _unloadModel() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_pipeline) {
    _pipeline = null;
    _loadedDtype = null;
    console.log(`[tts] Modelo descargado`);
    if (typeof global.gc === 'function') global.gc();
  }
}

// ─── Conversión audio ────────────────────────────────────────────────────────

function _float32ToWavBuffer(float32Array, sampleRate) {
  const numSamples = float32Array.length;
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);        // chunk size
  buffer.writeUInt16LE(1, 20);         // PCM format
  buffer.writeUInt16LE(1, 22);         // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32);              // block align
  buffer.writeUInt16LE(16, 34);        // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM samples
  for (let i = 0; i < numSamples; i++) {
    let sample = float32Array[i];
    sample = Math.max(-1, Math.min(1, sample));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    buffer.writeInt16LE(Math.round(int16), 44 + i * 2);
  }

  return buffer;
}

// ─── API pública ─────────────────────────────────────────────────────────────

async function synthesize(text) {
  if (!DEFAULTS.enabled) return null;
  if (!text || !text.trim()) return null;

  const truncated = text.slice(0, DEFAULTS.maxTextLength);

  const pipe = await _loadModel();
  const result = await pipe(truncated, {
    speaker_embeddings: DEFAULTS.speaker,
  });
  _resetIdleTimer();

  const audio = result.audio;
  const sampleRate = result.sampling_rate;
  return _float32ToWavBuffer(audio, sampleRate);
}

function enable() {
  DEFAULTS.enabled = true;
  _saveConfig();
}

function disable() {
  DEFAULTS.enabled = false;
  _saveConfig();
  _unloadModel();
}

function isEnabled() {
  return DEFAULTS.enabled;
}

function getConfig() {
  return { ...DEFAULTS, loadedDtype: _loadedDtype };
}

function setModel(modelId) {
  DEFAULTS.model = modelId;
  _saveConfig();
  _unloadModel(); // fuerza recarga con nuevo modelo
}

async function preload() {
  try {
    await _loadModel();
    console.log(`[tts] Modelo precargado: ${DEFAULTS.model}`);
  } catch (err) {
    console.error(`[tts] Error al precargar modelo: ${err.message}`);
  }
}

function unload() {
  _unloadModel();
}

module.exports = { synthesize, preload, unload, enable, disable, isEnabled, getConfig, setModel, DEFAULTS };
