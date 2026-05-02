/**
 * Voice-side endpoints used by public/js/voice.js.
 *
 * Currently exposes the hallucination classifier so the front end can
 * detect (post-hoc) when the LLM voice response claims an action without
 * having called yabby_execute. Logged as a warning only — same behaviour
 * as the channel handler (lib/channels/handler.js) which uses the
 * identical classifier from lib/hallucination-detector.js.
 */

import { Router } from "express";
import { detectActionClaim } from "../lib/hallucination-detector.js";
import { log } from "../lib/logger.js";
import { redis, KEY } from "../db/redis.js";

const router = Router();

router.post("/api/voice/detect-hallucination", async (req, res) => {
  const text = String(req.body?.text || "");
  if (!text) return res.json({ claimsAction: false });
  try {
    const claimsAction = await detectActionClaim(text);
    if (claimsAction) {
      log(`[VOICE-HALLUCINATION] ⚠️  Response claimed action without tool call: "${text.substring(0, 120)}${text.length > 120 ? '…' : ''}"`);
    }
    res.json({ claimsAction });
  } catch (err) {
    log(`[VOICE-HALLUCINATION] Detector error (non-fatal): ${err.message}`);
    res.json({ claimsAction: false });
  }
});

/**
 * Voice activity state — `active=true` means the Realtime mic is open and
 * the model will hear/respond in real time. `active=false` means the page
 * is in wake-word standby (suspended) or fully idle. The client refreshes
 * this every 30s while active so a missed disconnect expires after 60s.
 *
 * Read by lib/agent-task-processor.js to decide whether to skip the polished
 * follow-up: only skip when the voice is genuinely active (Realtime will
 * speak the result). When suspended, we keep the polish so other surfaces
 * still get a clean answer.
 */
router.post("/api/voice/state", async (req, res) => {
  try {
    const active = req.body?.active === true;
    if (active) {
      await redis.set(KEY("voice:active"), "1");
    } else {
      await redis.del(KEY("voice:active"));
    }
    res.json({ ok: true, active });
  } catch (err) {
    log(`[VOICE-STATE] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
