/* ═══════════════════════════════════════════════════════
   YABBY — CogniCore Experience API Routes
   ═══════════════════════════════════════════════════════
   REST endpoints that proxy to the CogniCore Python service.
   Exposes experience data to the web UI and external consumers.
*/

import { Router } from "express";
import { log } from "../lib/logger.js";
import {
  storeExperience,
  queryExperience,
  generateReflection,
  recordTrajectoryStep,
  replayTrajectory,
  getAgentStats,
  getGlobalStats,
  checkHealth,
} from "../lib/experience/client.js";

const router = Router();

// ─── Health ──────────────────────────────────────────────

router.get("/health", async (req, res) => {
  const health = await checkHealth();
  if (!health) {
    return res.json({ status: "unavailable", message: "CogniCore service not running" });
  }
  res.json(health);
});

// ─── Store Experience ────────────────────────────────────

router.post("/record", async (req, res) => {
  try {
    const result = await storeExperience(req.body);
    if (!result) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(result);
  } catch (err) {
    log(`[EXPERIENCE-API] POST /record failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Query Experiences ───────────────────────────────────

router.post("/query", async (req, res) => {
  try {
    const { query, agentId, projectId, category, outcomeFilter, includeFixes, limit } = req.body;
    const result = await queryExperience(query, {
      agentId,
      projectId,
      category,
      outcomeFilter,
      includeFixes,
      limit,
    });
    if (!result) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(result);
  } catch (err) {
    log(`[EXPERIENCE-API] POST /query failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Generate Reflection ─────────────────────────────────

router.post("/reflect", async (req, res) => {
  try {
    const { agentId, category, taskContext } = req.body;
    const result = await generateReflection(agentId, category, taskContext);
    if (!result) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(result);
  } catch (err) {
    log(`[EXPERIENCE-API] POST /reflect failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Trajectory ──────────────────────────────────────────

router.post("/trajectory/step", async (req, res) => {
  try {
    const result = await recordTrajectoryStep(req.body);
    if (!result) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(result);
  } catch (err) {
    log(`[EXPERIENCE-API] POST /trajectory/step failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post("/trajectory/replay", async (req, res) => {
  try {
    const { trajectoryId, includeToolResults, maxSteps } = req.body;
    const result = await replayTrajectory(trajectoryId, {
      includeToolResults,
      maxSteps,
    });
    if (!result) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(result);
  } catch (err) {
    log(`[EXPERIENCE-API] POST /trajectory/replay failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats ───────────────────────────────────────────────

router.get("/stats", async (req, res) => {
  try {
    const stats = await getGlobalStats();
    if (!stats) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(stats);
  } catch (err) {
    log(`[EXPERIENCE-API] GET /stats failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get("/agent/:agentId/stats", async (req, res) => {
  try {
    const stats = await getAgentStats(req.params.agentId);
    if (!stats) {
      return res.status(503).json({ error: "CogniCore service unavailable" });
    }
    res.json(stats);
  } catch (err) {
    log(`[EXPERIENCE-API] GET /agent/:id/stats failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
