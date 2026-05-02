import { Router } from "express";
import { speak, listVoices, listProviderNames } from "../lib/tts/index.js";

const router = Router();

// POST /api/tts/speak — generate speech audio
router.post("/api/tts/speak", async (req, res) => {
  try {
    const { text, provider, voice, rate } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });

    const result = await speak(text, { provider, voice, rate });
    res.setHeader("Content-Type", result.contentType);
    res.send(result.audio);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tts/voices — list available voices
router.get("/api/tts/voices", async (req, res) => {
  try {
    const provider = req.query.provider || "system";
    const voices = await listVoices(provider);
    res.json({ provider, voices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tts/providers — list TTS providers
router.get("/api/tts/providers", (_req, res) => {
  res.json({ providers: listProviderNames() });
});

export default router;
