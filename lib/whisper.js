/* ═══════════════════════════════════════════════════════
   Whisper Transcription
   ═══════════════════════════════════════════════════════
   Transcribes audio files using OpenAI Whisper API.
*/

import { readFileSync } from "fs";
import { log } from "./logger.js";
import { getServerLanguage } from "./i18n.js";

/**
 * Transcribe audio file using OpenAI Whisper
 * @param {string} audioPath - Path to audio file
 * @param {string} language - Language code (default: "fr")
 * @returns {Promise<string>} Transcribed text
 */
export async function transcribeAudio(audioPath, language) {
  if (!language) {
    try { language = getServerLanguage(); } catch { language = "en"; }
  }
  try {
    const audioBuffer = readFileSync(audioPath);

    // Detect file extension and mime type from path
    const ext = audioPath.split(".").pop()?.toLowerCase() || "ogg";
    const mimeTypes = {
      ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav",
      m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
      flac: "audio/flac", mpeg: "audio/mpeg",
    };
    const mimeType = mimeTypes[ext] || "audio/ogg";
    const filename = `audio.${ext}`;

    // Prepare multipart form data
    const boundary = `----WebKitFormBoundary${Date.now()}`;
    const formParts = [];

    // Add audio file
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    formParts.push(audioBuffer);
    formParts.push(`\r\n`);

    // Add model
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`);

    // Add language
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);

    // End boundary
    formParts.push(`--${boundary}--\r\n`);

    // Build body
    const body = Buffer.concat([
      ...formParts.map(part => typeof part === 'string' ? Buffer.from(part, 'utf-8') : part)
    ]);

    // Call OpenAI Whisper API
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    return result.text || "";
  } catch (err) {
    log("[WHISPER] Transcription error:", err.message);
    throw err;
  }
}
