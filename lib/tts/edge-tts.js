/* ═══════════════════════════════════════════════════════
   YABBY — Edge TTS Provider (free Microsoft TTS)
   ═══════════════════════════════════════════════════════ */

import { log } from "../logger.js";
import { spawn } from "child_process";

export class EdgeTTSProvider {
  async speak(text, opts = {}) {
    const voice = opts.voice || "fr-FR-DeniseNeural";
    const rate = opts.rate || "+0%";

    return new Promise((resolve, reject) => {
      const chunks = [];
      const child = spawn("npx", ["--yes", "edge-tts", "--voice", voice, "--rate", rate, "--text", text, "--write-media", "-"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", () => {}); // suppress npx noise

      child.on("close", (code) => {
        if (code !== 0 || chunks.length === 0) {
          return reject(new Error(`edge-tts exited with code ${code}`));
        }
        resolve({ audio: Buffer.concat(chunks), contentType: "audio/mpeg" });
      });

      child.on("error", reject);
    });
  }

  async listVoices() {
    return new Promise((resolve) => {
      const chunks = [];
      const child = spawn("npx", ["--yes", "edge-tts", "--list-voices"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk) => chunks.push(chunk));

      child.on("close", () => {
        const output = Buffer.concat(chunks).toString();
        const voices = [];
        for (const line of output.split("\n")) {
          const match = line.match(/^Name:\s+(.+)/);
          if (match) {
            const name = match[1].trim();
            const lang = name.split("-").slice(0, 2).join("-");
            voices.push({ id: name, name, language: lang });
          }
        }
        // Filter to French voices by default
        resolve(voices.filter(v => v.language.startsWith("fr")));
      });

      child.on("error", () => resolve([]));
    });
  }
}
