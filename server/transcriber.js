'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ─── Estado singleton ────────────────────────────────────────────────────────

let _pipeline = null;
let _loadingPromise = null;
let _idleTimer = null;

// ─── Configuración por defecto ───────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'whisper-config.json');

const DEFAULTS = {
  model: 'Xenova/whisper-medium',
  language: 'es',
  chunkLengthS: 30,
  idleTimeoutMs: 5 * 60 * 1000,
  timeout: 300000,
};

// Cargar config persistida al iniciar
try {
  const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(DEFAULTS, saved);
} catch {}

function _saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n'); } catch {}
}

const MEMORY_THRESHOLDS = {
  'Xenova/whisper-tiny':    600 * 1024 * 1024,
  'Xenova/whisper-tiny.en': 600 * 1024 * 1024,
  'Xenova/whisper-base':    800 * 1024 * 1024,
  'Xenova/whisper-small':  1400 * 1024 * 1024,
  'Xenova/whisper-medium': 2600 * 1024 * 1024,
};

const MODEL_FALLBACK_CHAIN = [
  'Xenova/whisper-medium',
  'Xenova/whisper-small',
  'Xenova/whisper-base',
  'Xenova/whisper-tiny',
];

// ─── Funciones internas ──────────────────────────────────────────────────────

function _checkMemory(modelId) {
  const threshold = MEMORY_THRESHOLDS[modelId];
  if (!threshold) return true;
  const free = os.freemem();
  return free >= threshold;
}

function _resolveModel(preferredModel) {
  const startIdx = MODEL_FALLBACK_CHAIN.indexOf(preferredModel);
  const chain = startIdx >= 0 ? MODEL_FALLBACK_CHAIN.slice(startIdx) : [preferredModel];

  for (const modelId of chain) {
    if (_checkMemory(modelId)) {
      if (modelId !== preferredModel) {
        console.log(`[transcriber] Memoria insuficiente para ${preferredModel}, usando ${modelId}`);
      }
      return modelId;
    }
  }

  const free = os.freemem();
  const freeMB = Math.round(free / 1024 / 1024);
  const smallest = chain[chain.length - 1];
  const needMB = Math.round((MEMORY_THRESHOLDS[smallest] || 0) / 1024 / 1024);
  throw new Error(`Memoria insuficiente: el modelo más pequeño (${smallest}) necesita ${needMB}MB, disponible ${freeMB}MB`);
}

async function _loadModel(modelId) {
  if (_pipeline) {
    _resetIdleTimer(modelId);
    return _pipeline;
  }
  if (_loadingPromise) {
    return _loadingPromise;
  }
  _loadingPromise = (async () => {
    try {
      const resolvedModel = _resolveModel(modelId);
      console.log(`[transcriber] Cargando modelo ${resolvedModel}...`);
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(__dirname, 'models-cache');
      _pipeline = await pipeline('automatic-speech-recognition', resolvedModel, {
        dtype: 'q8',
        device: 'cpu',
      });
      console.log(`[transcriber] Modelo ${resolvedModel} cargado`);
      _resetIdleTimer(resolvedModel);
      return _pipeline;
    } catch (err) {
      _pipeline = null;
      throw err;
    } finally {
      _loadingPromise = null;
    }
  })();
  return _loadingPromise;
}

function _resetIdleTimer(modelId) {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _unloadModel(modelId), DEFAULTS.idleTimeoutMs);
}

function _unloadModel(modelId) {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  if (_pipeline) {
    _pipeline = null;
    console.log(`[transcriber] Modelo ${modelId || 'whisper'} descargado por inactividad`);
    if (typeof global.gc === 'function') global.gc();
  }
}

async function _decodeOgg(filePath) {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const decoder = new OggOpusDecoder();
  await decoder.ready;

  const fileBuffer = fs.readFileSync(filePath);
  const { channelData, sampleRate } = await decoder.decode(new Uint8Array(fileBuffer));
  decoder.free();

  let pcm = channelData[0];
  if (sampleRate !== 16000) {
    pcm = _resample(pcm, sampleRate, 16000);
  }
  return pcm;
}

function _resample(float32, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const newLength = Math.floor(float32.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, float32.length - 1);
    const frac = srcIdx - lo;
    result[i] = float32[lo] * (1 - frac) + float32[hi] * frac;
  }
  return result;
}

// ─── Descarga HTTPS genérica ─────────────────────────────────────────────────

function httpsDownload(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      family: 4,
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsDownload(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(new Error('Download timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Transcripción con Transformers.js (Whisper ONNX) ────────────────────────

async function transcribe(filePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const pipe = await _loadModel(cfg.model);
  const audio = await _decodeOgg(filePath);

  const result = await pipe(audio, {
    language: cfg.language,
    chunk_length_s: cfg.chunkLengthS,
    return_timestamps: false,
  });

  _resetIdleTimer(cfg.model);

  const text = result.text.trim();
  if (!text) {
    throw new Error('No se pudo extraer texto del audio');
  }
  return text;
}

const VALID_MODELS = ['tiny', 'base', 'small', 'medium'];

const VALID_LANGUAGES = ['es', 'en', 'pt', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'auto'];

function getConfig() { return { ...DEFAULTS }; }

function setModel(model) {
  if (!VALID_MODELS.includes(model)) return false;
  DEFAULTS.model = `Xenova/whisper-${model}`;
  _saveConfig();
  return true;
}

function setLanguage(lang) {
  if (!VALID_LANGUAGES.includes(lang)) return false;
  DEFAULTS.language = lang;
  _saveConfig();
  return true;
}

module.exports = { httpsDownload, transcribe, DEFAULTS, VALID_MODELS, VALID_LANGUAGES, getConfig, setModel, setLanguage };
