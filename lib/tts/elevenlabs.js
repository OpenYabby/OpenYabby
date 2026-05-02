/* ═══════════════════════════════════════════════════════
   YABBY — ElevenLabs TTS Provider
   ═══════════════════════════════════════════════════════ */

import { log } from "../logger.js";

export class ElevenLabsProvider {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY || "";
    this.baseUrl = "https://api.elevenlabs.io/v1";
  }

  async speak(text, opts = {}) {
    if (!this.apiKey) throw new Error("ELEVENLABS_API_KEY not set");

    const voiceId = opts.voice || "21m00Tcm4TlvDq8ikWAM"; // Rachel default
    const modelId = opts.model || "eleven_multilingual_v2";

    const resp = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`ElevenLabs error: ${err.slice(0, 200)}`);
    }

    // Track TTS usage (pricing is per character)
    try {
      const { logUsage } = await import("../../db/queries/usage.js");
      await logUsage({
        provider: "elevenlabs",
        model: modelId,
        inputTokens: 0,
        outputTokens: 0,
        context: "tts",
        extra: { characters: text.length }
      });
    } catch (err) {
      log("[TTS] Failed to log usage:", err.message);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    return { audio: buffer, contentType: "audio/mpeg" };
  }

  async listVoices() {
    if (!this.apiKey) return [];
    try {
      const resp = await fetch(`${this.baseUrl}/voices`, {
        headers: { "xi-api-key": this.apiKey },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.voices || []).map(v => ({
        id: v.voice_id,
        name: v.name,
        language: v.labels?.language || "multi",
      }));
    } catch {
      return [];
    }
  }
}
