'use strict';

module.exports = {
  name: 'elevenlabs',
  label: 'ElevenLabs',
  type: 'cloud',
  // Solo voces pre-made por defecto; el usuario puede usar cualquier voice_id
  voices: ['rachel', 'adam', 'antoni', 'arnold', 'bella', 'domi', 'elli', 'josh', 'sam'],
  defaultVoice: 'rachel',
  models: ['eleven_multilingual_v2', 'eleven_monolingual_v1', 'eleven_turbo_v2_5'],
  defaultModel: 'eleven_multilingual_v2',

  async synthesize({ text, voice, model, apiKey }) {
    if (!apiKey) throw new Error('ElevenLabs API key no configurada');
    if (!text || !text.trim()) return null;

    const voiceId = voice || 'rachel';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: model || 'eleven_multilingual_v2',
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`ElevenLabs error ${res.status}: ${err}`);
    }

    return Buffer.from(await res.arrayBuffer());
  },
};
