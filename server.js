import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Database imports
import pool, { query as pgQuery } from "./db/pg.js";
import { redis } from "./db/redis.js";
import {
  getConversation, saveLastResponseId, addTurn,
  updateSummary, resetConversation,
  getOrCreateAgentConversation, getAllTurns, DEFAULT_CONV_ID,
} from "./db/queries/conversations.js";
import { updateTaskStatus, recoverOrphanedTasks, getTask } from "./db/queries/tasks.js";
import { acquireLock, releaseLock } from "./db/queries/guilock.js";

// Lib modules
import { log, sseClients, emitConversationUpdate } from "./lib/logger.js";
import { processHandles, killProcessTree } from "./lib/spawner.js";
import { buildVoiceInstructions, buildAgentVoiceInstructions } from "./lib/prompts.js";
import { extractMemories, getMemoryProfile, clearMemories } from "./lib/memory.js";
import { loadConfig, getConfig, onConfigChange } from "./lib/config.js";
import { getPromptFragments, serverMsg } from "./lib/i18n.js";
import { getAgent, findAgentByName } from "./db/queries/agents.js";
import { getProject } from "./db/queries/projects.js";

// Route modules
import tasksRouter from "./routes/tasks.js";
import projectsRouter from "./routes/projects.js";
import agentsRouter from "./routes/agents.js";
import skillsRouter from "./routes/skills.js";
import messagesRouter from "./routes/messages.js";
import configRouter from "./routes/config.js";
import authRouter from "./routes/auth.js";
import providersRouter from "./routes/providers.js";

// Relay tunnel client
import { startTunnel } from "./lib/tunnel.js";

// Auth middleware
import { optionalAuth } from "./lib/auth.js";

// Providers
import { initProviders } from "./lib/providers/index.js";

// Agent bus & orchestrator
import { initBus, closeBus } from "./lib/agent-bus.js";
import { initOrchestrator, closeOrchestrator } from "./lib/orchestrator.js";

// Scheduler
import { init as initScheduler, shutdown as shutdownScheduler } from "./lib/scheduler.js";
import scheduledTasksRouter from "./routes/scheduled-tasks.js";

// Thread bindings sweeper
import { startThreadBindingSweeper } from "./lib/channels/thread-binding-manager.js";
import { startHeapMonitor } from "./lib/heap-monitor.js";

// Channels
import { initChannels, closeChannels } from "./lib/channels/index.js";
import channelsRouter from "./routes/channels.js";

// Plugins
import { loadPlugins } from "./lib/plugins/index.js";
import { getAllTools, getToolsForProject, getToolsForUser } from "./lib/plugins/tool-registry.js";
import pluginsRouter from "./routes/plugins.js";

// MCP
import mcpRouter from "./routes/mcp.js";

// Connectors
import connectorsRouter from "./routes/connectors.js";
import { reconnectAll as reconnectConnectors, getConnectorSummary, getAllowedToolNamesForProject } from "./lib/connectors/manager.js";

// TTS
import ttsRouter from "./routes/tts.js";

// Health
import healthRouter from "./routes/health.js";

// Usage analytics
import usageRouter from "./routes/usage.js";

// Preview
import previewRouter from "./routes/preview.js";

// Speaker verification
import speakerRouter from "./routes/speaker.js";

// Plan reviews
import planReviewsRouter from "./routes/plan-reviews.js";
import projectQuestionsRouter from "./routes/project-questions.js";
import presentationsRouter from "./routes/presentations.js";

// Generic tool executor
import toolsRouter from "./routes/tools.js";

// Media + Imagegen
import mediaRouter from "./routes/media.js";
import imagegenRouter from "./routes/imagegen.js";

// System management
import systemRouter from "./routes/system.js";
import voiceRouter from "./routes/voice.js";

// WebSocket
import { initWebSocket, broadcastWs, closeWebSocket } from "./lib/ws-gateway.js";
import { setWsBroadcast } from "./lib/logger.js";

const app = express();
const PORT = process.env.PORT || 3000;

const SUMMARY_EVERY = 6;

// Accept raw SDP posted from the browser
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ["application/sdp", "text/plain"], limit: "5mb" }));

// Log every request
app.use((req, _res, next) => {
  log(`${req.method} ${req.url}`);
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Serve new SPA from /public/
app.use(express.static(join(__dirname, "public")));

// SSE endpoint
app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  log("[SSE] Client connected (" + sseClients.size + " total)");

  req.on("close", () => {
    sseClients.delete(res);
    log("[SSE] Client disconnected (" + sseClients.size + " remaining)");
  });
});

// Auth routes — always accessible (login, logout, me, setup)
app.use(authRouter);

// Auth middleware — gates all routes registered AFTER this point.
// EXEMPT by registration order: SSE (/api/logs/stream), auth routes, /session (registered below).
app.use(optionalAuth);

// Mount route modules (protected by optionalAuth when auth is enabled)
app.use(tasksRouter);
app.use(projectsRouter);
app.use(agentsRouter);
app.use(skillsRouter);
app.use(messagesRouter);
app.use(scheduledTasksRouter);
app.use(configRouter);
app.use(providersRouter);
app.use(channelsRouter);
app.use(pluginsRouter);
app.use(mcpRouter);
app.use(connectorsRouter);
app.use(ttsRouter);
app.use(healthRouter);
app.use("/api/usage", usageRouter);
app.use(previewRouter);
app.use(speakerRouter);
app.use(mediaRouter);
app.use(imagegenRouter);
app.use(planReviewsRouter);
app.use(projectQuestionsRouter);
app.use(presentationsRouter);
app.use(toolsRouter);
app.use(systemRouter);
app.use(voiceRouter);

// ==================== CONVERSATION ENDPOINTS ====================

app.post("/api/conversation-state", async (req, res) => {
  const { lastResponseId } = req.body;
  if (!lastResponseId) return res.status(400).json({ error: "Missing lastResponseId" });
  try {
    const changed = await saveLastResponseId(lastResponseId);
    if (changed) log("[CONV-STATE] Updated lastResponseId:", lastResponseId);
    res.json({ ok: true });
  } catch (err) {
    log("[CONV-STATE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversation-state/turn", async (req, res) => {
  const { role, text, mediaAssetIds } = req.body;
  if (!role || (!text && (!mediaAssetIds || !mediaAssetIds.length))) return res.status(400).json({ error: "Missing role or text" });
  try {
    const { turnCount, turnsSinceSummary } = await addTurn(role, text || "", DEFAULT_CONV_ID, "web", mediaAssetIds || []);
    if (turnsSinceSummary >= SUMMARY_EVERY && turnCount >= 4) {
      refreshMemories().catch(err => log("[MEMORY] Error:", err.message));
    }
    log("[CONV-TURN]", role, ":", text.slice(0, 100));

    // Emit conversation update for channel sync (both user and assistant)
    emitConversationUpdate(DEFAULT_CONV_ID, turnCount);

    res.json({ ok: true, turnCount });
  } catch (err) {
    log("[CONV-TURN] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversation-state", async (_req, res) => {
  try {
    const state = await getConversation(undefined, 50);  // Fetch all active turns for UI display
    res.json(state);
  } catch (err) {
    log("[CONV-STATE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/memories", async (_req, res) => {
  try {
    const profile = await getMemoryProfile();
    res.json({ profile });
  } catch (err) {
    log("[MEMORY] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/conversation-state", async (_req, res) => {
  try {
    await resetConversation();
    await clearMemories();
    log("[CONV-STATE] Reset (including memories)");
    res.json({ ok: true });
  } catch (err) {
    log("[CONV-STATE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== AGENT CHAT PERSISTENCE ====================

app.get("/api/agent-chats/:agentId", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const offset = parseInt(req.query.offset) || 0;
    const convId = await getOrCreateAgentConversation(req.params.agentId);

    // Filter out raw task results (they are reformulated by the speaker) — filtered in SQL
    // so that `limit` reflects the number of UI-visible turns
    const turns = await getAllTurns(convId, limit, offset, ['agent_task']);

    res.json({ conversationId: convId, turns, hasMore: turns.length === limit });
  } catch (err) {
    log("[AGENT-CHAT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent-chats/:agentId/turn", async (req, res) => {
  const { role, text, mediaAssetIds } = req.body;
  if (!role || (!text && (!mediaAssetIds || !mediaAssetIds.length))) return res.status(400).json({ error: "Missing role or text" });
  try {
    const convId = await getOrCreateAgentConversation(req.params.agentId);
    const { turnCount } = await addTurn(role, text || "", convId, "web", mediaAssetIds || []);
    emitConversationUpdate(convId, turnCount); // ✅ FIX 1: Enable live updates for agent chats
    log("[AGENT-CHAT-TURN]", req.params.agentId, role, ":", text.slice(0, 100));
    res.json({ ok: true, turnCount, conversationId: convId });
  } catch (err) {
    log("[AGENT-CHAT-TURN] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/yabby-chat", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const offset = parseInt(req.query.offset) || 0;
    log(`[YABBY-CHAT] limit=${limit} offset=${offset}`);
    const turns = await getAllTurns(DEFAULT_CONV_ID, limit, offset);
    res.json({ turns, hasMore: turns.length === limit });
  } catch (err) {
    log("[YABBY-CHAT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== WAKE WORD ====================

// Get agent voice instructions for voice session switching
app.get("/api/agents/:id/voice-config", async (req, res) => {
  try {
    let agent = await getAgent(req.params.id);
    if (!agent) agent = await findAgentByName(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    let projectContext = "";
    if (agent.projectId) {
      const project = await getProject(agent.projectId);
      if (project) {
        projectContext = `Projet: ${project.name}\n${project.description || ""}\n${project.context || ""}`;
      }
    }

    const instructions = buildAgentVoiceInstructions(agent, projectContext);
    res.json({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      projectId: agent.projectId,
      instructions,
    });
  } catch (err) {
    log("[AGENT-VOICE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get Yabby's voice instructions (for back_to_yabby)
app.get("/api/yabby-instructions", async (req, res) => {
  const now = new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" });
  let instructions = buildVoiceInstructions(true, now); // isResume=true so no intro
  try {
    const { getConnectorSummary } = await import("./lib/connectors/manager.js");
    const connSummary = await getConnectorSummary();
    if (connSummary) instructions += `\n\nCONNECTEURS DISPONIBLES:\n${connSummary}`;
  } catch {}
  res.json({ instructions });
});

app.get("/api/wake-debug", (req, res) => {
  log("[WAKE-DEBUG]", req.query.msg || "ping");
  res.json({ ok: true });
});

app.post("/api/wake-word", async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let audioBuffer = Buffer.concat(chunks);

    // Accept base64-encoded audio from mobile clients
    const contentType = req.headers["content-type"] || "audio/webm";
    if (contentType.includes("application/base64")) {
      audioBuffer = Buffer.from(audioBuffer.toString(), 'base64');
    }

    // Reject very short clips
    if (audioBuffer.length < 2000) return res.json({ wake: false });

    // Detect format from Content-Type
    const isWav = contentType.includes("wav") || contentType.includes("base64");
    const filename = isWav ? "wake.wav" : "wake.webm";
    const mimeType = isWav ? "audio/wav" : "audio/webm";

    const boundary = "----WakeWordBoundary" + Date.now();
    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    formParts.push(audioBuffer);
    formParts.push("\r\n");
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`);
    const wakeWordLang = getConfig("voice")?.language || "fr";
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${wakeWordLang}\r\n`);
    // No `prompt` here on purpose: passing "Yabby" as a prompt biases Whisper
    // to hallucinate the wake word on silence/background noise, producing
    // false-positive wakes. The regex below is permissive enough to catch
    // real pronunciations without needing the prompt.
    formParts.push(`--${boundary}--\r\n`);

    const bodyParts = formParts.map(p => typeof p === "string" ? Buffer.from(p) : p);
    const body = Buffer.concat(bodyParts);

    const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!whisperResp.ok) {
      const errText = await whisperResp.text();
      log("[WAKE] Whisper error:", errText.slice(0, 200));
      return res.json({ wake: false });
    }

    const result = await whisperResp.json();
    const transcript = (result.text || "").toLowerCase();
    log("[WAKE] Transcript:", transcript);

    // Track usage (Whisper pricing is per minute)
    // Rough estimate: 60KB ≈ 1 minute of audio
    const audioSizeKB = audioBuffer.length / 1024;
    const estimatedDurationMinutes = audioSizeKB / 360;

    try {
      const { logUsage } = await import("./db/queries/usage.js");
      await logUsage({
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        inputTokens: 0,
        outputTokens: 0,
        context: "wake_word",
        extra: { audio_minutes: estimatedDurationMinutes }
      });
    } catch (err) {
      log("[WAKE] Failed to log usage:", err.message);
    }

    // Flexible matching for wake word variations
    // Matches: yabby, yabi, jabi, yépi, yébi, etc.
    // Pattern: word boundary + y/j + vowel + one or more p/b + vowel + optional e
    const wake = /\b[yj][aéeè][pb]+[iy]e?\b/i.test(transcript);
    res.json({ wake, transcript });
  } catch (err) {
    log("[WAKE] Error:", err.message);
    res.json({ wake: false });
  }
});

// Wake word validation for calibration (detailed feedback)
app.post("/api/wake-word/validate", async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let audioBuffer = Buffer.concat(chunks);

    // Client-side should pre-filter, but double-check
    if (audioBuffer.length < 2000) {
      return res.json({
        valid: false,
        reason: 'too_short',
        details: { audioSize: audioBuffer.length }
      });
    }

    const contentType = req.headers["content-type"] || "audio/wav";
    const isWav = contentType.includes("wav");
    const filename = isWav ? "calibrate.wav" : "calibrate.webm";
    const mimeType = isWav ? "audio/wav" : "audio/webm";

    // Call Whisper (same as /api/wake-word)
    const boundary = "----CalibrationBoundary" + Date.now();
    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    formParts.push(audioBuffer);
    formParts.push("\r\n");
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nfr\r\n`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nYabby\r\n`);
    formParts.push(`--${boundary}--\r\n`);

    const bodyParts = formParts.map(p => typeof p === "string" ? Buffer.from(p) : p);
    const body = Buffer.concat(bodyParts);

    const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!whisperResp.ok) {
      const errText = await whisperResp.text();
      log("[CALIBRATE] Whisper error:", errText.slice(0, 200));
      return res.json({ valid: false, reason: 'whisper_error' });
    }

    const result = await whisperResp.json();
    const transcript = (result.text || "").toLowerCase().trim();

    // Flexible matching for wake word variations (same as main wake-word endpoint)
    const wakeRegex = /\b[yj][aéeè][pb]+[iy]e?\b/i;
    const valid = wakeRegex.test(transcript);
    const matchesYabby = valid;  // For backwards compatibility
    const matchesJabi = valid;

    // Log usage
    const audioSizeKB = audioBuffer.length / 1024;
    const estimatedDurationMinutes = audioSizeKB / 360;
    try {
      const { logUsage } = await import("./db/queries/usage.js");
      await logUsage({
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        inputTokens: 0,
        outputTokens: 0,
        context: "calibration",
        extra: { audio_minutes: estimatedDurationMinutes }
      });
    } catch (err) {
      log("[CALIBRATE] Failed to log usage:", err.message);
    }

    res.json({
      valid,
      transcript,
      reason: valid ? 'success' : 'wrong_word',
      details: {
        matchesYabby,
        matchesJabi,
        audioSize: audioBuffer.length,
        duration: estimatedDurationMinutes * 60
      }
    });
  } catch (err) {
    log("[CALIBRATE] Error:", err.message);
    res.json({ valid: false, reason: 'error', error: err.message });
  }
});

// Speaker verification — proxied to Python microservice (fail-open if down)

// ==================== GUI LOCK ====================

app.post("/api/gui-lock/acquire", async (req, res) => {
  const { task_id } = req.body;
  log("[GUI-LOCK] Acquire request from:", task_id);
  if (!task_id) return res.status(400).json({ error: "Missing task_id" });

  const isTaskRunning = (id) => processHandles.has(id);
  const result = await acquireLock(task_id, isTaskRunning);
  if (result.acquired) {
    log("[GUI-LOCK] Acquired by:", task_id);
  } else {
    log("[GUI-LOCK] Denied for:", task_id, "held by:", result.held_by);
  }
  res.json(result);
});

app.post("/api/gui-lock/release", async (req, res) => {
  const { task_id } = req.body;
  log("[GUI-LOCK] Release request from:", task_id);
  const result = await releaseLock(task_id);
  if (result.released) {
    log("[GUI-LOCK] Released by:", task_id);
  } else {
    log("[GUI-LOCK] Nothing to release for:", task_id);
  }
  res.json(result);
});

// ==================== MEMORY (Mem0) ====================

async function refreshMemories() {
  const conv = await getConversation(undefined, 15);  // Only need last 10 turns + buffer
  const turns = conv.turns;
  if (turns.length < 2) return;

  const recentTurns = turns.slice(-10);
  log("[MEMORY] Extracting memories from", recentTurns.length, "turns...");

  await extractMemories(recentTurns);

  // Reset the turnsSinceSummary counter (reuse existing Redis key)
  await updateSummary("");
}

// ==================== REALTIME SESSION ====================

app.post("/session", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      log("[SESSION] ERROR: Missing OPENAI_API_KEY");
      return res.status(500).send("Missing OPENAI_API_KEY environment variable");
    }

    const sdp = req.body;
    log("[SESSION] Received SDP offer, length:", typeof sdp === "string" ? sdp.length : "NOT A STRING");

    if (!sdp || typeof sdp !== "string") {
      log("[SESSION] ERROR: Invalid SDP body, type:", typeof sdp);
      return res.status(400).send("Missing SDP offer in request body");
    }

    const model = req.header("X-Model") || "gpt-realtime";
    const voice = req.header("X-Voice") || "marin";
    const isResume = req.header("X-Resume") === "true";
    const projectId = req.header("X-Project-Id") || null;
    const textOnly = req.header("X-Text-Only") === "true";  // Text-only mode
    log("[SESSION] Model:", model, "| Voice:", voice, "| Resume:", isResume, "| Project:", projectId || "global", "| TextOnly:", textOnly);

    // Read voice config early (needed for locale)
    const voiceConfig = getConfig("voice");
    const generalConfig = getConfig("general");
    const langLocaleMap = { fr: "fr-FR", en: "en-US", es: "es-ES", de: "de-DE" };
    const uiLanguage = generalConfig.uiLocale || generalConfig.language;
    const dateLocale = langLocaleMap[uiLanguage] || langLocaleMap[voiceConfig.language] || "fr-FR";
    const now = new Date().toLocaleString(dateLocale, { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" });

    const rawInstructions = req.header("X-Instructions");
    let instructions = rawInstructions
      ? decodeURIComponent(rawInstructions)
      : buildVoiceInstructions(isResume, now);

    // Add note if text-only mode
    if (textOnly) {
      instructions += `\n\n**CURRENT MODE:** You are in text-only mode (no voice). You CANNOT hear the user vocally — they are typing in the chat. Your voice is on standby — if the user says "Yabby", you will switch to full voice mode with microphone and audio. For now, you can only read their written messages and respond with text only.`;
      log("[SESSION] Added text-only mode note to instructions");
    }

    // Fetch memory profile and connector summary in parallel (P3)
    const [profile, connSummary] = await Promise.all([
      getMemoryProfile().catch(err => { log("[SESSION] Mem0 profile unavailable:", err.message); return null; }),
      getConnectorSummary().catch(err => { log("[SESSION] Connector summary unavailable:", err.message); return null; }),
    ]);

    if (profile) {
      const pf = getPromptFragments();
      const cappedProfile = profile.length > 1500 ? profile.slice(0, 1500) + "\n..." : profile;
      instructions += `\n\n${pf.userProfile}:\n${cappedProfile}`;
      log("[SESSION] Injected Mem0 profile into instructions");
    }
    if (connSummary) {
      const pf = getPromptFragments();
      instructions += `\n\n${pf.connectors}:\n${connSummary}`;
      log("[SESSION] Injected connector summary into instructions");
    }

    // Inject conversation history for context continuity (Phase 1)
    let conversationContext = '';
    try {
      const convResp = await fetch(`http://localhost:${PORT}/api/conversations/default`);
      if (convResp.ok) {
        const convData = await convResp.json();
        if (convData.turns && convData.turns.length > 0) {
          // Get last 15 turns for context
          const recentTurns = convData.turns.slice(-15);
          const turnsSummary = recentTurns
            .map(t => `- ${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.slice(0, 200)}`)
            .join('\n');
          conversationContext = `\n\n## CONVERSATION HISTORY\n\nLast 15 exchanges from this conversation:\n${turnsSummary}\n\nUse this history to understand the context of the user's requests.`;
          log(`[SESSION] Injected ${recentTurns.length} conversation turns`);
        }
      }
    } catch (err) {
      log('[SESSION] Failed to fetch conversation history:', err.message);
    }

    instructions += conversationContext;

    // Inject recent running tasks (Phase 2)
    const m = serverMsg();
    let taskContext = '';
    try {
      const tasksResp = await fetch(`http://localhost:${PORT}/api/tasks/recent?hours=1&limit=10`);
      if (tasksResp.ok) {
        const tasksData = await tasksResp.json();
        const runningTasks = (tasksData.tasks || []).filter(t => t.status === 'running' || t.status === 'done' || t.status === 'paused');

        if (runningTasks.length > 0) {
          const taskList = runningTasks
            .map(t => {
              const elapsed = Math.round((Date.now() - new Date(t.startTime).getTime()) / 1000);
              const timeStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}min`;
              // Extract meaningful description from title or result
              let desc = t.title || 'Task';
              if (!t.title && t.result) {
                // Extract first meaningful line from result (skip empty lines)
                const firstLine = t.result.split('\n').find(line => line.trim().length > 0);
                if (firstLine) {
                  desc = firstLine.slice(0, 80);
                }
              }
              return `- ${t.id}: "${desc}" (${t.status}, ${m.agoSuffix} ${timeStr})`;
            })
            .join('\n');

          taskContext = `\n\n## ${m.recentTasks}\n\n${m.recentTasksIntro}\n${taskList}\n\n${m.recentTasksHint}`;
          log(`[SESSION] Injected ${runningTasks.length} recent tasks`);
        }
      }
    } catch (err) {
      log('[SESSION] Failed to fetch recent tasks:', err.message);
    }

    instructions += taskContext;

    // Inject project context if session is scoped to a project (Phase 3)
    let projectContext = '';
    if (projectId) {
      try {
        const projectResp = await fetch(`http://localhost:${PORT}/api/projects/${projectId}`);
        if (projectResp.ok) {
          const project = await projectResp.json();

          projectContext = `\n\n## CURRENT PROJECT\n\nYou are working on the project: **${project.name}**\n`;

          if (project.goal) {
            projectContext += `Goal: ${project.goal}\n`;
          }

          if (project.leadAgentName) {
            projectContext += `Project lead: ${project.leadAgentName}\n`;
          }

          if (project.status) {
            projectContext += `Status: ${project.status}\n`;
          }

          // Add agents if any
          const agentsResp = await fetch(`http://localhost:${PORT}/api/agents?project_id=${projectId}`);
          if (agentsResp.ok) {
            const agentsData = await agentsResp.json();
            const agents = agentsData.agents || [];
            if (agents.length > 0) {
              const agentList = agents.map(a => `  - ${a.name} (${a.role})`).join('\n');
              projectContext += `\nTeam:\n${agentList}\n`;
            }
          }

          projectContext += `\nAll your actions (tasks, created agents) are linked to this project.`;
          log(`[SESSION] Injected project context: ${project.name}`);
        }
      } catch (err) {
        log('[SESSION] Failed to fetch project context:', err.message);
      }
    }

    instructions += projectContext;

    log("[SESSION] Instructions length:", instructions.length);

    // Scope connector tools to project if specified
    let tools;
    if (projectId) {
      try {
        const allowedNames = await getAllowedToolNamesForProject(projectId);
        tools = getToolsForProject(allowedNames);
        log(`[SESSION] Scoped tools for project ${projectId}: ${tools.length} tools`);
      } catch (err) {
        log("[SESSION] Could not scope tools:", err.message);
        tools = getToolsForUser();
      }
    } else {
      // User sessions (voice/text) get limited tools - must delegate via yabby_execute
      tools = getToolsForUser();
      log(`[SESSION] User tools (no CLI task management): ${tools.length} tools`);
    }

    // Apply voice config for noise reduction & VAD settings
    const noiseRed = voiceConfig.noiseReduction || "near_field";
    const vadType = voiceConfig.turnDetection || "server_vad";

    const session = {
      type: "realtime",
      model,
      instructions,
      tools,
    };

    // Configure audio according to mode
    if (textOnly || voiceConfig.micEnabled === false) {
      // Mode texte seul: ne pas configurer audio (le client enverra modalities via DataChannel)
      log("[SESSION] Creating text-only session (no audio config)");
    } else {
      // Mode vocal: audio input + output
      session.audio = {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe", language: voiceConfig.language || "fr" },
          ...(noiseRed !== "off" ? { noise_reduction: { type: noiseRed } } : {}),
          turn_detection: vadType === "semantic_vad"
            ? { type: "semantic_vad" }
            : {
                type: "server_vad",
                threshold: 0.85,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
        },
        output: { voice: voiceConfig.voice || voice },
      };
      log("[SESSION] Creating voice session (audio enabled - noise_reduction:", noiseRed, "turn_detection:", vadType, ")");
    }

    const formData = new FormData();
    formData.set("sdp", sdp);
    formData.set("session", JSON.stringify(session));

    log("[SESSION] Calling OpenAI /v1/realtime/calls ...");
    const openaiResp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    log("[SESSION] OpenAI response status:", openaiResp.status);
    const responseText = await openaiResp.text();
    log("[SESSION] OpenAI response length:", responseText.length);

    if (!openaiResp.ok) {
      log("[SESSION] ERROR from OpenAI (status " + openaiResp.status + "):", responseText.slice(0, 2000));
      log("[SESSION] Session JSON sent:", JSON.stringify(session).slice(0, 500));
      return res.status(openaiResp.status).send(responseText);
    }

    log("[SESSION] SUCCESS - returning SDP answer to browser");
    res.setHeader("Content-Type", "application/sdp");
    res.send(responseText);
  } catch (error) {
    log("[SESSION] EXCEPTION:", error.message, error.stack);
    res.status(500).send(error.message || "Internal server error");
  }
});

// ==================== SESSION RELOAD ====================

app.post("/api/session/reload", (_req, res) => {
  const tools = getToolsForUser();
  res.json({ tools: tools.map(t => t.name), count: tools.length });
});

// ==================== SPA FALLBACK ====================
// Any non-API route serves the SPA shell (for hash-based routing)
app.get(/^\/(?!api|claude|session).*/, (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

// ==================== STARTUP & SHUTDOWN ====================

async function startup() {
  // Run base schema first (conversations, tasks, conversation_turns)
  try {
    await pgQuery(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE TABLE IF NOT EXISTS conversations (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        summary          TEXT NOT NULL DEFAULT '',
        last_response_id TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id               BIGSERIAL PRIMARY KEY,
        conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role             VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
        text             TEXT NOT NULL,
        ts               BIGINT NOT NULL,
        active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_turns_conv_active ON conversation_turns (conversation_id, active) WHERE active = TRUE;
      CREATE INDEX IF NOT EXISTS idx_turns_conv_created ON conversation_turns (conversation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id                  VARCHAR(8) PRIMARY KEY,
        session_id          UUID NOT NULL,
        status              VARCHAR(20) NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'done', 'error', 'paused', 'killed', 'paused_llm_limit')),
        result              TEXT,
        error               TEXT,
        task_instruction    TEXT,
        llm_limit_reset_at  TEXT,
        paused_at           TIMESTAMPTZ,
        start_time          BIGINT NOT NULL,
        elapsed             INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_paused_llm_limit ON tasks(status) WHERE status = 'paused_llm_limit';
    `);
  } catch (err) {
    if (!err.message?.includes("already exists")) {
      log("[STARTUP] Base schema note:", err.message);
    }
  }

  // Auto-run migrations if needed
  for (const migFile of ["002_projects_agents.js", "003_skills_deps.js", "004_hierarchical.js", "005_chat_persistence.js", "006_scheduled_tasks.js", "007_config.js", "008_auth.js", "009_usage.js", "010_channels.js", "011_connectors.js", "012_plan_reviews.js", "013_project_questions.js", "014_presentations.js", "015_whatsapp_settings.js", "016_unique_agent_names.js", "017_agent_task_queue.js", "017_thread_bindings.js", "018_agent_whatsapp_groups.js", "019_deduplicate_whatsapp.js", "020_yabby_super_agent.js", "021_project_questions_queue.js", "022_task_speaker_context.js", "023_conversation_source.js", "024_llm_limit_tasks.js", "025_fix_agent_name_uniqueness.js", "026_task_phase.js", "027_qa_browser_session_skill.js", "028_cli_system_prompt.js", "029_agent_workspace_path.js", "030_plan_review_shown.js", "031_queue_task_title.js", "032_multi_agent_task_queue.js", "033_media_assets.js", "034_channel_pairings.js", "035_runner_session_parity.js", "036_agent_runner_sessions.js", "037_presentations_demo.js", "038_thread_owner.js", "039_channel_containers.js", "040_tasks_fk_set_null.js", "041_plan_review_pending_emission.js"]) {
    try {
      const { run } = await import(`./db/migrations/${migFile}`);
      await run();
    } catch (err) {
      if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
        log(`[STARTUP] Migration ${migFile} note:`, err.message);
      }
    }
  }

  // Ensure default conversation row exists (seed)
  try {
    await pgQuery("INSERT INTO conversations (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT (id) DO NOTHING");
  } catch {}

  // Check speaker verification service health
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const speakerHealth = await fetch('http://localhost:3001/health', {
      signal: controller.signal
    }).then(r => r.json());

    clearTimeout(timeoutId);
    log('[STARTUP] ✅ Speaker verification service: RUNNING');
    log(`[STARTUP]    Model: ${speakerHealth.model || 'ECAPA-TDNN'}`);
  } catch (err) {
    log('[STARTUP] ⚠️  Speaker verification service: NOT RUNNING');
    log('[STARTUP]    Voice detection will work but without speaker filtering');
    log('[STARTUP]    To enable speaker verification:');
    log('[STARTUP]      Terminal 1: npm start');
    log('[STARTUP]      Terminal 2: npm run speaker');
    log('[STARTUP]    Or use: npm run dev (starts both)');
  }

  // Load config from DB (falls back to defaults if empty)
  try {
    await loadConfig();
    log("[STARTUP] Config loaded");
  } catch (err) {
    log("[STARTUP] Config load note:", err.message);
  }

  // Initialize Yabby Workspace structure (root + Group Projects/ + Independent Tasks/ + yabby/)
  // Also migrate legacy ~/Desktop/Yabby Projects/ if present
  try {
    const { initWorkspaceStructure, migrateOldSandbox } = await import('./lib/sandbox.js');
    await initWorkspaceStructure();
    await migrateOldSandbox();
  } catch (err) {
    log('[STARTUP] Workspace init note:', err.message);
  }

  // Seed process.env from saved API keys (so direct process.env reads work)
  const _envKeyMap = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", openrouter: "OPENROUTER_API_KEY" };
  try {
    const llm = getConfig("llm");
    if (llm?.providers) {
      for (const [name, cfg] of Object.entries(llm.providers)) {
        if (cfg.apiKey && _envKeyMap[name] && !process.env[_envKeyMap[name]]) {
          process.env[_envKeyMap[name]] = cfg.apiKey;
          log(`[STARTUP] Seeded ${_envKeyMap[name]} from DB config`);
        }
      }
    }
  } catch {}

  // Init LLM providers
  try {
    initProviders();
  } catch (err) {
    log("[STARTUP] Providers init note:", err.message);
  }

  // Re-init providers when LLM config changes (e.g., new API key from onboarding)
  onConfigChange((key) => {
    if (key === "llm") {
      log("[CONFIG] LLM config changed, re-initializing providers");
      initProviders();
    }
  });

  // Init messaging channels (Telegram, Slack, Discord)
  try {
    await initChannels();
  } catch (err) {
    log("[STARTUP] Channels init note:", err.message);
  }

  // Load plugins
  try {
    await loadPlugins();
  } catch (err) {
    log("[STARTUP] Plugins init note:", err.message);
  }

  // Init agent messaging bus
  try {
    await initBus();
  } catch (err) {
    log("[STARTUP] Agent bus init note:", err.message);
  }

  // Init orchestrator (auto-triggers lead review on sub-agent completion)
  try {
    await initOrchestrator();
  } catch (err) {
    log("[STARTUP] Orchestrator init note:", err.message);
  }

  // ========================================
  // RESUME RUNNING TASKS
  // ========================================
  let tasksToResume = [];

  // 1. PRIORITY: Snapshot file (clean shutdown)
  try {
    const { readFile, unlink } = await import('fs/promises');
    const data = await readFile('.running-tasks.json', 'utf-8');
    tasksToResume = JSON.parse(data);
    log(`[STARTUP] Found ${tasksToResume.length} tasks in shutdown snapshot - resuming...`);

    // Delete the file after reading
    await unlink('.running-tasks.json');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`[STARTUP] Error reading snapshot:`, err.message);
    }
  }

  // 2. FALLBACK: Database (hard crash without clean shutdown)
  if (tasksToResume.length === 0) {
    const orphaned = await recoverOrphanedTasks();

    // Only resume "running" tasks
    // ("paused" tasks are either voluntary or from a previous shutdown already handled)
    tasksToResume = orphaned.filter(t => t.status === 'running');

    if (tasksToResume.length > 0) {
      log(`[STARTUP] Found ${tasksToResume.length} running tasks in DB (crash recovery) - resuming...`);
    }
  }

  // 3. PAUSE all tasks that were running at crash/shutdown — don't auto-resume.
  //    Auto-resuming 8+ tasks simultaneously spawns 50+ MCP servers and saturates
  //    the Mac. The user chooses when to resume each task from the UI.
  if (tasksToResume.length > 0) {
    log(`[STARTUP] Found ${tasksToResume.length} task(s) interrupted by shutdown — marking as paused. Resume manually from UI.`);
    for (const task of tasksToResume) {
      try {
        await updateTaskStatus(task.id, "paused", null, "Paused at server restart — resume manually");
      } catch (err) {
        log(`[STARTUP] Failed to pause task ${task.id}: ${err.message}`);
      }
    }
  } else {
    log(`[STARTUP] No tasks to resume`);
  }

  // ========================================
  // RESUME TASK QUEUES
  // ========================================
  log("[STARTUP] Checking for pending agent task queues...");

  try {
    const { processAgentQueue } = await import('./lib/agent-task-processor.js');

    // Find all agents with pending tasks in their queue
    const agentsWithQueue = await pgQuery(`
      SELECT DISTINCT agent_id, COUNT(*) as pending_count
      FROM agent_task_queue
      WHERE status = 'pending'
      GROUP BY agent_id
      ORDER BY pending_count DESC
    `);

    if (agentsWithQueue.rows.length > 0) {
      log(`[STARTUP] Found ${agentsWithQueue.rows.length} agent(s) with pending queue tasks`);

      for (const row of agentsWithQueue.rows) {
        const agentId = row.agent_id;
        const count = parseInt(row.pending_count);

        log(`[STARTUP] 📋 Agent ${agentId} has ${count} pending task(s) - resuming queue processing`);

        // Resume queue processing (async, non-blocking)
        processAgentQueue(agentId).catch(err => {
          log(`[STARTUP] ❌ Failed to resume queue for agent ${agentId}:`, err.message);
        });
      }

      log(`[STARTUP] ✅ Queue processing resumed for ${agentsWithQueue.rows.length} agent(s)`);
    } else {
      log("[STARTUP] No pending queue tasks found");
    }
  } catch (err) {
    log("[STARTUP] ❌ Error checking agent queues:", err.message);
  }

  // Init scheduler (after migrations + orphan recovery)
  try {
    await initScheduler();
  } catch (err) {
    log("[STARTUP] Scheduler init note:", err.message);
  }

  // Start thread binding sweeper (cleanup every 5 min)
  try {
    startThreadBindingSweeper(300000);  // 5 minutes
    log("[STARTUP] Thread binding sweeper started (5 min interval)");
  } catch (err) {
    log("[STARTUP] Thread binding sweeper init error:", err.message);
  }

  // Heap monitor — warns + forces GC before OOM crashes
  try {
    startHeapMonitor();
  } catch (err) {
    log("[STARTUP] Heap monitor init error:", err.message);
  }

  // Media retention job (every 6 hours)
  setInterval(async () => {
    try {
      const { runRetention } = await import("./lib/media/retention.js");
      await runRetention();
    } catch (err) {
      log("[RETENTION] Error:", err.message);
    }
  }, 6 * 60 * 60 * 1000);
  log("[STARTUP] Media retention scheduled (every 6h)");


  // Ensure /tmp/yabby-files exists for filesystem connector
  try {
    const { mkdir } = await import("fs/promises");
    await mkdir("/tmp/yabby-files", { recursive: true });
  } catch {}

  // Reconnect previously active connectors
  try {
    await reconnectConnectors();
  } catch (err) {
    log("[STARTUP] Connector reconnect note:", err.message);
  }

  // Kill any stale process holding the port before listening
  try {
    const { execSync } = await import('child_process');
    const pids = execSync(`lsof -ti :${PORT}`, { encoding: 'utf8' }).trim();
    if (pids) {
      log(`[STARTUP] Port ${PORT} in use by PID(s): ${pids.replace(/\n/g, ', ')} — killing...`);
      execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 500)); // Brief wait for port release
    }
  } catch {
    // No process on port — good
  }

  const server = app.listen(PORT, '0.0.0.0', async () => {
    log("===========================================");
    log("Server listening on http://0.0.0.0:" + PORT);
    log("Local access: http://localhost:" + PORT);
    log("Claude CLI:", process.env.CLAUDE_CMD || "claude");
    log("Project root:", process.env.CLAUDE_PROJECT_ROOT || process.cwd());
    log("Multi-task: start_task / check_tasks / continue_task / pause_task / kill_task");
    log("Projects: create_project / assign_agent / talk_to_agent / project_status");
    log("Phase 2: skills / templates / agent-messages / sandboxes");
    log("Database: PostgreSQL + Redis connected");
    log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "set (" + process.env.OPENAI_API_KEY.slice(0, 5) + "...)" : "NOT SET");
    log("===========================================");

    // Open browser automatically
    try {
      const { exec } = await import('child_process');
      exec(`open http://localhost:${PORT}`);
    } catch {}


    // Init WebSocket gateway (attach to HTTP server)
    try {
      await initWebSocket(server);
      setWsBroadcast(broadcastWs);
    } catch (err) {
      log("[STARTUP] WebSocket init note:", err.message);
    }

    // Start relay tunnel (connect to relay.openyabby.com)
    if (process.env.ENABLE_TUNNEL === 'true') {
      startTunnel();
    }
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[SHUTDOWN] ${signal} — graceful shutdown...`);

  // 1. CAPTURE the "running" state BEFORE any modification
  const runningTasks = [];
  for (const [taskId, child] of processHandles) {
    try {
      const task = await getTask(taskId);
      if (task && task.status === 'running') {
        runningTasks.push({
          id: taskId,
          session_id: task.sessionId,
          agent_id: task.agentId,
          project_id: task.projectId,
          title: task.title,
        });
      }
    } catch (err) {
      log(`[SHUTDOWN] Error reading task ${taskId}:`, err.message);
    }
  }

  // 2. Save BEFORE modifying anything
  if (runningTasks.length > 0) {
    try {
      const { writeFile } = await import('fs/promises');
      await writeFile(
        '.running-tasks.json',
        JSON.stringify(runningTasks, null, 2)
      );
      log(`[SHUTDOWN] Saved ${runningTasks.length} running tasks to .running-tasks.json`);
    } catch (err) {
      log(`[SHUTDOWN] Failed to save running tasks:`, err.message);
    }
  }

  // 3. Send SIGTERM to the whole process group of each task (Claude CLI + MCP descendants)
  for (const [taskId, child] of processHandles) {
    try {
      killProcessTree(child, "SIGTERM");
    } catch (err) {
      log(`[SHUTDOWN] Error killing task ${taskId}:`, err.message);
    }
  }

  // 4. Wait 2s for processes to terminate gracefully, then SIGKILL any survivors
  await new Promise(resolve => setTimeout(resolve, 2000));
  for (const [taskId, child] of processHandles) {
    try { killProcessTree(child, "SIGKILL"); } catch {}
  }

  // 5. Mark tasks as "paused"
  for (const [taskId] of processHandles) {
    await updateTaskStatus(taskId, "paused", "Server shutting down");
  }

  // 6. Clean up
  shutdownScheduler();
  await closeWebSocket();
  await closeChannels();
  await closeBus();
  await closeOrchestrator();

  await pool.end();
  await redis.quit();

  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Last-resort cleanup: if Node exits for any reason (uncaught exception,
// panic, parent dies), synchronously kill every child process group.
// This prevents MCP server + Chrome orphans accumulating across restarts.
process.on("exit", () => {
  for (const [, child] of processHandles) {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
});
// Errors from fetch()/undici can surface asynchronously after the await
// already handled them locally (e.g. OpenAI/network drops mid-upload).
// Don't crash the whole server for those — just log and continue.
function isRecoverableError(err) {
  if (!err) return false;
  const code = err?.code || err?.cause?.code;
  const recoverableCodes = new Set([
    'UND_ERR_SOCKET',         // undici: socket closed
    'UND_ERR_CONNECT_TIMEOUT',// undici: connect timeout
    'UND_ERR_HEADERS_TIMEOUT',// undici: response headers timeout
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]);
  if (recoverableCodes.has(code)) return true;
  // undici "terminated" with no other code = same kind of issue
  if (err?.name === 'TypeError' && /terminated|fetch failed/i.test(err?.message || '')) return true;
  return false;
}

process.on("uncaughtException", (err) => {
  if (isRecoverableError(err)) {
    console.error("[NETWORK-ERROR] Recoverable async error (continuing):", err?.message || err);
    return;
  }
  console.error("[CRASH] Uncaught exception:", err);
  for (const [, child] of processHandles) {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  }
  process.exit(1);
});

// Same logic for unhandled promise rejections — don't crash on network blips.
process.on("unhandledRejection", (reason) => {
  if (isRecoverableError(reason)) {
    console.error("[NETWORK-ERROR] Recoverable promise rejection (continuing):", reason?.message || reason);
    return;
  }
  console.error("[UNHANDLED-REJECTION]", reason);
  // Do NOT exit — log and let the app keep running. Real bugs will surface
  // via uncaughtException above.
});

startup().catch((err) => {
  console.error("[STARTUP] Failed:", err.message, err.stack);
  process.exit(1);
});
