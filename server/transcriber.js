'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

// ─── Configuración por defecto ───────────────────────────────────────────────

const DEFAULTS = {
  pythonBin: path.join(process.env.HOME, '.venvs', 'whisper', 'bin', 'python3'),
  model: 'medium',
  device: 'cpu',
  computeType: 'int8',
  language: 'es',
  beamSize: 5,
  timeout: 300000, // 5 min
};

// ─── Descarga HTTPS genérica ─────────────────────────────────────────────────

/**
 * Descarga un archivo binario por HTTPS y lo guarda en disco.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<string>} ruta local del archivo descargado
 */
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

// ─── Transcripción con faster-whisper ────────────────────────────────────────

/**
 * Transcribe un archivo de audio usando faster-whisper (CTranslate2).
 * @param {string} filePath - ruta al archivo OGG/MP3/WAV
 * @param {object} [opts] - opciones para sobreescribir defaults
 * @returns {Promise<string>} texto transcrito
 */
function transcribe(filePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  return new Promise((resolve, reject) => {
    const script = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("${cfg.model}", device="${cfg.device}", compute_type="${cfg.computeType}")
segments, _ = model.transcribe(sys.argv[1], language="${cfg.language}", beam_size=${cfg.beamSize})
print(" ".join(s.text.strip() for s in segments))
`;
    const child = spawn(cfg.pythonBin, ['-c', script, filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: cfg.timeout,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error(`faster-whisper salió con código ${exitCode}: ${stderr.slice(0, 300)}`));
      }
      const text = stdout.trim();
      if (!text) {
        return reject(new Error('No se pudo extraer texto del audio'));
      }
      resolve(text);
    });

    child.on('error', reject);
  });
}

const VALID_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3'];

function getConfig() { return { ...DEFAULTS }; }

function setModel(model) {
  if (!VALID_MODELS.includes(model)) return false;
  DEFAULTS.model = model;
  return true;
}

module.exports = { httpsDownload, transcribe, DEFAULTS, VALID_MODELS, getConfig, setModel };
