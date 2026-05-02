/* ═══════════════════════════════════════════════════════
   YABBY — OpenAI TTS Provider
   ═══════════════════════════════════════════════════════
   Uses gpt-4o-mini-tts — same voice engine as Realtime API,
   so previews sound like the actual conversation voice.
*/

import OpenAI from "openai";

// All voices supported by gpt-4o-mini-tts (matches Realtime API)
const OPENAI_TTS_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo",
  "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse",
];

export class OpenAITTSProvider {
  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async speak(text, opts = {}) {
    const voice = OPENAI_TTS_VOICES.includes(opts.voice) ? opts.voice : "coral";

    const response = await this.client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "mp3",
    });

    // Track TTS usage (pricing is per character)
    try {
      const { logUsage } = await import("../../db/queries/usage.js");
      await logUsage({
        provider: "openai",
        model: "gpt-4o-mini-tts",
        inputTokens: 0,
        outputTokens: 0,
        context: "tts",
        extra: { characters: text.length }
      });
    } catch (err) {
      console.log("[TTS] Failed to log usage:", err.message);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { audio: buffer, contentType: "audio/mpeg" };
  }

  async listVoices() {
    return OPENAI_TTS_VOICES.map(v => ({ id: v, name: v, language: "multi" }));
  }
}
