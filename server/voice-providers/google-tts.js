'use strict';

module.exports = {
  name: 'google-tts',
  label: 'Google Cloud TTS',
  type: 'cloud',
  voices: ['es-US-Standard-A', 'es-US-Standard-B', 'es-US-Standard-C', 'en-US-Standard-A', 'en-US-Standard-B', 'en-US-Standard-C', 'en-US-Standard-D', 'en-US-Standard-E', 'en-US-Standard-F'],
  defaultVoice: 'es-US-Standard-A',
  models: ['standard', 'wavenet', 'neural2'],
  defaultModel: 'standard',

  async synthesize({ text, voice, model, apiKey }) {
    if (!apiKey) throw new Error('Google TTS API key no configurada');
    if (!text || !text.trim()) return null;

    const voiceName = voice || 'es-US-Standard-A';
    const languageCode = voiceName.split('-').slice(0, 2).join('-');

    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: { audioEncoding: 'OGG_OPUS' },
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Google TTS error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return Buffer.from(data.audioContent, 'base64');
  },
};
