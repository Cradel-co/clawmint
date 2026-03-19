'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Configuración ──────────────────────────────────────────────────────────

const PIPER_DIR   = path.join(__dirname, 'piper');
const MODELS_DIR  = path.join(PIPER_DIR, 'models');
const SAMPLE_RATE = 22050;
const MAX_TEXT_LENGTH = 500;

const IS_WIN = process.platform === 'win32';
const PIPER_BIN = path.join(PIPER_DIR, IS_WIN ? 'piper.exe' : 'piper');

const PIPER_VERSION = '2023.11.14-2';
const PIPER_RELEASE_BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;
const PIPER_ARCHIVE = IS_WIN
  ? `piper_windows_amd64.zip`
  : `piper_linux_x86_64.tar.gz`;

const VOICES = {
  'es_MX-claude-medium': {
    model: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/claude/medium/es_MX-claude-medium.onnx',
    config: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_MX/claude/medium/es_MX-claude-medium.onnx.json',
  },
  'es_ES-davefx-medium': {
    model: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx',
    config: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json',
  },
};

const DEFAULT_VOICE = 'es_MX-claude-medium';

// ─── Helpers ────────────────────────────────────────────────────────────────

let _setupPromise = null;

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function _download(url, dest) {
  console.log(`[tts:piper] Descargando ${path.basename(dest)}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`[tts:piper] Descargado ${path.basename(dest)} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
}

async function _ensureBinaryImpl() {
  if (fs.existsSync(PIPER_BIN)) return;

  const parentDir = path.dirname(PIPER_DIR);
  const archivePath = path.join(parentDir, PIPER_ARCHIVE);
  await _download(`${PIPER_RELEASE_BASE}/${PIPER_ARCHIVE}`, archivePath);

  console.log(`[tts:piper] Extrayendo binario...`);
  if (IS_WIN) {
    // unzip disponible en Git Bash; zip contiene piper/ como raíz → extraer al parent
    const proc = spawn('unzip', ['-o', archivePath, '-d', parentDir], { stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`)));
      proc.on('error', reject);
    });
  } else {
    // .tar.gz nativo en Linux; contiene piper/ como raíz → extraer al parent
    const proc = spawn('tar', ['-xzf', archivePath, '-C', parentDir], { stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)));
      proc.on('error', reject);
    });
    fs.chmodSync(PIPER_BIN, 0o755);
  }

  // Limpiar archivo descargado
  try { fs.unlinkSync(archivePath); } catch {}
  console.log(`[tts:piper] Binario listo en ${PIPER_DIR}`);
}

function _ensureBinary() {
  if (!_setupPromise) {
    _setupPromise = _ensureBinaryImpl().catch(err => {
      _setupPromise = null; // permitir reintentos si falla
      throw err;
    });
  }
  return _setupPromise;
}

async function _ensureModel(voiceName) {
  const voice = VOICES[voiceName];
  if (!voice) throw new Error(`Voz piper desconocida: ${voiceName}`);

  _ensureDir(MODELS_DIR);
  const modelPath  = path.join(MODELS_DIR, `${voiceName}.onnx`);
  const configPath = path.join(MODELS_DIR, `${voiceName}.onnx.json`);

  if (!fs.existsSync(modelPath))  await _download(voice.model, modelPath);
  if (!fs.existsSync(configPath)) await _download(voice.config, configPath);

  return modelPath;
}

function _pcmToWavBuffer(pcmBuffer) {
  const numSamples = pcmBuffer.length / 2;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// ─── Módulo exportado ────────────────────────────────────────────────────────

module.exports = {
  name: 'piper-tts',
  label: 'Piper TTS (local/offline)',
  type: 'local',
  voices: Object.keys(VOICES),
  defaultVoice: DEFAULT_VOICE,
  models: ['medium'],
  defaultModel: 'medium',

  async synthesize({ text, voice }) {
    if (!text || !text.trim()) return null;
    const truncated = text.slice(0, MAX_TEXT_LENGTH);
    const voiceName = voice || DEFAULT_VOICE;

    await _ensureBinary();
    const modelPath = await _ensureModel(voiceName);

    return new Promise((resolve, reject) => {
      const args = ['--model', modelPath, '--output_raw'];
      const proc = spawn(PIPER_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      const chunks = [];
      let stderr = '';

      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

      proc.on('close', code => {
        if (code !== 0) return reject(new Error(`Piper exit ${code}: ${stderr}`));
        if (chunks.length === 0) return reject(new Error('Piper no generó audio'));
        const pcm = Buffer.concat(chunks);
        resolve(_pcmToWavBuffer(pcm));
      });

      proc.on('error', reject);
      proc.stdin.write(truncated);
      proc.stdin.end();
    });
  },

  async preload() {
    try {
      await _ensureBinary();
      await _ensureModel(DEFAULT_VOICE);
      console.log(`[tts:piper] Binario y modelo precargados`);
    } catch (err) {
      console.error(`[tts:piper] Error al precargar: ${err.message}`);
    }
  },
};
