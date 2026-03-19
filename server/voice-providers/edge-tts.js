'use strict';

const { EdgeTTS } = require('@andresaya/edge-tts');

const VOICES = [
  'es-MX-DaliaNeural',
  'es-MX-JorgeNeural',
  'es-ES-ElviraNeural',
  'es-ES-AlvaroNeural',
  'es-AR-ElenaNeural',
];

const DEFAULT_VOICE = 'es-MX-DaliaNeural';
const MAX_TEXT_LENGTH = 500;

module.exports = {
  name: 'edge-tts',
  label: 'Edge TTS (Microsoft)',
  type: 'cloud',
  voices: VOICES,
  defaultVoice: DEFAULT_VOICE,
  models: ['default'],
  defaultModel: 'default',

  async synthesize({ text, voice }) {
    if (!text || !text.trim()) return null;
    const truncated = text.slice(0, MAX_TEXT_LENGTH);
    const selectedVoice = voice || DEFAULT_VOICE;

    const tts = new EdgeTTS();
    await tts.synthesize(truncated, selectedVoice);
    const buffer = tts.toBuffer();
    if (!buffer || buffer.length === 0) throw new Error('Edge TTS no generó audio');
    return buffer;
  },
};
