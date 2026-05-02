/* ═══════════════════════════════════════════════════════
   YABBY — System TTS Provider (macOS `say` command)
   ═══════════════════════════════════════════════════════ */

import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";

export class SystemProvider {
  async speak(text, opts = {}) {
    const voice = opts.voice || "Thomas"; // French macOS voice
    const rate = opts.rate || 200;
    const outPath = join(tmpdir(), `yabby-tts-${randomUUID()}.aiff`);

    return new Promise((resolve, reject) => {
      const child = spawn("say", ["-v", voice, "-r", String(rate), "-o", outPath, text]);

      child.on("close", async (code) => {
        if (code !== 0) return reject(new Error(`say exited with code ${code}`));
        try {
          const audio = await readFile(outPath);
          await unlink(outPath).catch(() => {});
          resolve({ audio, contentType: "audio/aiff" });
        } catch (err) {
          reject(err);
        }
      });

      child.on("error", reject);
    });
  }

  async listVoices() {
    return new Promise((resolve) => {
      const chunks = [];
      const child = spawn("say", ["-v", "?"]);

      child.stdout.on("data", (chunk) => chunks.push(chunk));

      child.on("close", () => {
        const output = Buffer.concat(chunks).toString();
        const voices = [];
        for (const line of output.split("\n")) {
          const match = line.match(/^(\S+)\s+(\S+)\s+#/);
          if (match) {
            voices.push({ id: match[1], name: match[1], language: match[2] });
          }
        }
        resolve(voices.filter(v => v.language.startsWith("fr")));
      });

      child.on("error", () => resolve([]));
    });
  }
}
