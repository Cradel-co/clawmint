'use strict';

module.exports = {
  name: 'openai-tts',
  label: 'OpenAI TTS',
  type: 'cloud',
  voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  defaultVoice: 'nova',
  models: ['tts-1', 'tts-1-hd'],
  defaultModel: 'tts-1',

  async synthesize({ text, voice, model, apiKey }) {
    if (!apiKey) throw new Error('OpenAI API key no configurada');
    if (!text || !text.trim()) return null;

    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'tts-1',
        input: text,
        voice: voice || 'nova',
        response_format: 'opus',
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`OpenAI TTS error ${res.status}: ${err}`);
    }

    return Buffer.from(await res.arrayBuffer());
  },
};
