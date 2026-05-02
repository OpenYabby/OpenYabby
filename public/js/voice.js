/* ═══════════════════════════════════════════════════════
   YABBY — Voice Module
   ═══════════════════════════════════════════════════════
   Extracted from original index.html.
   WebRTC + DataChannel + wake word + noise filter + tool dispatch.
   All DOM manipulation replaced with state.set() calls.
   All inline fetch() replaced with api.js imports.
*/

import { state } from './state.js';
import { api } from './api.js';
import { t } from './i18n.js';

// ── Connection state ──
let pc = null;
let dc = null;
let localStream = null;
let connected = false;

// ── Auto-reconnect ──
let lastResponseId = null;
let autoReconnect = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 3000;
let isReconnecting = false;

// ── Inactivity detection ──
let audioContext = null;
let micMonitorInterval = null;
let inactivityTimer = null;
let isSuspended = false;
let persistentMicStream = null;
const activeTaskIds = new Set();
const INACTIVITY_TIMEOUT = 600000; // 10 min
const INACTIVITY_TIMEOUT_BUSY = 600000; // 10 min when tasks are running
const SILENCE_THRESHOLD = 0.05;
const SPEECH_FRAMES_NEEDED = 3;

// ── Chat streaming state ──
let currentAssistantText = "";
let isStreaming = false;

// ── Per-turn tool-call tracker (post-hoc hallucination check) ──
// Set to true when a function_call lands in the current response, reset on
// response.created. Mirrors the channel handler's post-hoc classifier
// (lib/channels/handler.js) — uses lib/hallucination-detector.js server-side
// to decide if a text-only reply was a false claim.
let currentResponseHadToolCall = false;

// One-shot flag: when true, the very NEXT assistant turn produced by Realtime
// will NOT be persisted to DEFAULT_CONV_ID. Used for handleSSEPlanReview where
// the spoken reply is contextual to the modal that's about to open and would
// otherwise be forwarded by notification-listener to every connected channel
// (WhatsApp/Telegram/...) as a confusing "go look on screen" message. The
// flag is consumed by saveTurn the first time it sees role='assistant'.
let skipNextAssistantPersist = false;

// ── Noise filter ──
const NOISE_PATTERNS = /^(ok|okay|oui|non|ah|oh|eh|hm+|mh+|mm+|hein|bah|bon|ben|euh|bof|ouais|mouais|pff+|tss+|ha+|hé|ho|psst|chut|wow|waouh|super|merci|d'accord|voilà|c'est bon|allez|exactement|absolument|parfait|génial|cool|nice|top|bien|oh là là|purée|mince|zut|nan|nah|no|yes|yeah|yep|nope|sure|right|fine|great|hmm+|uh+|um+|ça va|ca va|très bien|et toi|comment tu vas|comment ça va)[\s.,!?]*$/i;
const SHORT_NOISE_MAX_WORDS = 3;
let lastUserItemId = null;
let noiseFilterActive = true;

// ── Agent voice switching ──
let currentVoiceAgent = null;
let yabbyInstructions = null;

// ── Wake word detection (Silero VAD) ──
let isCheckingWakeWord = false;
let micVAD = null;

// ── URL config ──
const BACKEND_URL = '/session';
const STATE_API = '/api/conversation-state';

// ── Voice activity ping ──
// Tells the server whether Realtime is actively listening/speaking so the
// agent-task-processor knows when to skip its polished follow-up. Called
// only on state transitions (connect, suspend, idle) — no heartbeat.
function pushVoiceState(active) {
  fetch("/api/voice/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  }).catch(() => {});
}

// ═══════════════════════════════════════
//   Audio helpers (Silero VAD pipeline)
// ═══════════════════════════════════════

/** Convert Float32Array PCM samples to a WAV Blob */
function float32ToWav(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Check speaker verification — returns true if not enrolled or verified */
async function checkSpeakerVerification(wavBlob) {
  try {
    const { enrolled } = await fetch("/api/speaker/status").then(r => r.json());
    if (!enrolled) return true;
    const { verified } = await fetch("/api/speaker/verify", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wavBlob,
    }).then(r => r.json());
    return verified;
  } catch {
    return true; // fail open
  }
}

// ═══════════════════════════════════════
//   Chat message helpers (via state)
// ═══════════════════════════════════════

function addChatMessage(role, text, mediaAssetIds = []) {
  state.push('chatMessages', { role, text, timestamp: Date.now(), mediaAssetIds });
}

function getOrCreateStreamingBubble() {
  if (!isStreaming) {
    isStreaming = true;
    currentAssistantText = "";
    state.push('chatMessages', { role: 'assistant', text: '', streaming: true, timestamp: Date.now() });
  }
}

function updateStreamingText(delta) {
  getOrCreateStreamingBubble();
  currentAssistantText += delta;
  // Update the last message in place
  const msgs = state.get('chatMessages');
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.streaming) {
      last.text = currentAssistantText;
      state.set('chatMessages', [...msgs]); // trigger re-render
    }
  }
}

function finalizeAssistantBubble(fullText) {
  if (!isStreaming) return;
  isStreaming = false;
  const msgs = state.get('chatMessages');
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.streaming) {
      last.streaming = false;
      if (fullText) last.text = fullText;
      state.set('chatMessages', [...msgs]);
    }
  }
  currentAssistantText = "";
}

function removeStreamingBubble() {
  if (!isStreaming) return;
  isStreaming = false;
  const msgs = state.get('chatMessages');
  if (msgs.length > 0 && msgs[msgs.length - 1].streaming) {
    msgs.pop();
    state.set('chatMessages', [...msgs]);
  }
  currentAssistantText = "";
}

// ═══════════════════════════════════════
//   Activity helpers (via state)
// ═══════════════════════════════════════

function addActivity(text, type) {
  state.prepend('activities', { text, type: type || '', time: Date.now() }, 200);
}

// ═══════════════════════════════════════
//   Conversation state persistence
// ═══════════════════════════════════════

async function saveResponseId(responseId) {
  if (responseId === lastResponseId) return;
  lastResponseId = responseId;
  try {
    await fetch(STATE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastResponseId: responseId })
    });
  } catch {}
}

async function loadResponseId() {
  try {
    const resp = await fetch(STATE_API);
    const data = await resp.json();
    if (data.lastResponseId) {
      lastResponseId = data.lastResponseId;
      console.log("[Yabby] Loaded previous responseId:", lastResponseId);
    }
    if (data.summary) {
      console.log("[Yabby] Loaded summary:", data.summary.slice(0, 100));
    }
    if (data.turns?.length) {
      console.log("[Yabby] Loaded", data.turns.length, "conversation turns");
    }
  } catch {}
}

async function saveTurn(role, text, mediaAssetIds = []) {
  if ((!text || text.trim().length === 0) && !mediaAssetIds.length) return;
  // Consume the one-shot voice-only flag: if the immediately preceding
  // injection (e.g. handleSSEPlanReview) marked the next assistant reply as
  // voice-only, skip the DB persist + SSE refresh + cross-channel forward
  // for this single turn. The reply still played out loud to the user.
  if (role === 'assistant' && skipNextAssistantPersist) {
    skipNextAssistantPersist = false;
    console.log('[voice] assistant reply persistence skipped (voice-only)');
    return;
  }
  try {
    await fetch(STATE_API + "/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, text: (text || "").trim(), mediaAssetIds })
    });
  } catch {}
}

/**
 * Post-hoc hallucination check, mirrors lib/channels/handler.js logic:
 * if the LLM produced a text response without calling any tool but the
 * text claims an action was performed, log a warning server-side. No retry.
 */
async function checkResponseForHallucination(text) {
  if (!text || text.trim().length < 5) return;
  if (currentResponseHadToolCall) return; // tool was called, no hallucination
  try {
    await fetch("/api/voice/detect-hallucination", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch {}
}

// ═══════════════════════════════════════
//   Inactivity & Suspend
// ═══════════════════════════════════════

function resetInactivityTimer() {
  if (!autoReconnect || isSuspended) return;
  clearTimeout(inactivityTimer);
  const timeout = activeTaskIds.size > 0 ? INACTIVITY_TIMEOUT_BUSY : INACTIVITY_TIMEOUT;
  inactivityTimer = setTimeout(() => {
    if (pc && pc.connectionState === "connected") {
      console.log(`[Yabby] ${timeout / 1000}s inactivity — suspending session`);
      suspendSession();
    }
  }, timeout);
}

function clearInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = null;
}

async function suspendSession() {
  if (isSuspended) return;
  isSuspended = true;
  pushVoiceState(false);
  activeTaskIds.clear();
  persistentMicStream = localStream;
  localStream = null;
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  const remoteAudio = document.getElementById("remoteAudio");
  if (remoteAudio) remoteAudio.srcObject = null;
  connected = false;

  state.set('voiceStatus', 'suspended');
  state.set('voiceStatusText', t('voice.standby'));

  // Persist suspended state so it survives page reload
  try { localStorage.setItem('yabby_suspended', '1'); localStorage.removeItem('yabby_connected'); } catch {}

  clearInactivityTimer();
  startMicMonitor();
}

// ═══════════════════════════════════════
//   Wake word detection
// ═══════════════════════════════════════

export async function startWakeWordListening() {
  console.log("[Yabby] startWakeWordListening called, guards:", { persistentMicStream: !!persistentMicStream, connected, isSuspended, textOnlyMode });

  // ✅ NOUVEAU: Autoriser en mode texte seul (même si connected)
  if (persistentMicStream) return;  // Ne pas recréer si déjà actif
  if (connected && !textOnlyMode) return;  // Bloquer seulement si vocal actif

  isSuspended = false;
  try {
    persistentMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    });

    // ✅ NOUVEAU: Ne pas changer le status si déjà en texte seul
    if (!textOnlyMode) {
      state.set('voiceStatus', 'suspended');
      state.set('voiceStatusText', t('voice.sayYabbyToStart') || 'Say "Yabby" to start...');
    }

    isSuspended = true;
    startMicMonitor();
    console.log("[Yabby] Wake word listening started, mic active");
    fetch("/api/wake-debug?msg=monitor_started").catch(() => {});
  } catch (err) {
    console.log("[Yabby] Mic access denied for wake word:", err.message);
    state.set('voiceStatus', 'idle');
    state.set('voiceStatusText', t('voice.clickToStart') || 'Click to start');
    fetch("/api/wake-debug?msg=mic_denied_" + encodeURIComponent(err.message)).catch(() => {});
  }
}

export async function resumeFromWakeWord() {
  console.log("[Yabby] Wake word detected — starting session");

  // ✅ NOUVEAU: Si en mode texte seul, fermer session avant de reconnecter
  if (textOnlyMode) {
    console.log("[Yabby] Transitioning from text-only to voice mode");
    textOnlyMode = false;  // Désactiver mode texte

    // Fermer la session texte actuelle
    if (dc) {
      try { dc.close(); } catch {}
      dc = null;
    }
    if (pc) {
      try { pc.close(); } catch {}
      pc = null;
    }
  }

  isSuspended = false;
  try { localStorage.removeItem('yabby_suspended'); } catch {}
  stopMicMonitor();
  if (persistentMicStream) {
    persistentMicStream.getTracks().forEach(t => t.stop());
    persistentMicStream = null;
  }
  reconnectAttempts = 0;
  await connect();  // ✅ Reconnecte en mode vocal (textOnlyMode = false)
}

async function startMicMonitor() {
  if (!persistentMicStream) return;

  // Destroy previous VAD instance
  if (micVAD) {
    try { micVAD.destroy(); } catch {}
    micVAD = null;
  }

  // Check if Silero VAD is available (loaded from CDN)
  if (typeof window.vad === "undefined" || !window.vad.MicVAD) {
    console.warn("[Wake] Silero VAD not loaded — CDN scripts missing");
    return;
  }

  try {
    micVAD = await window.vad.MicVAD.new({
      stream: persistentMicStream,
      ortConfig: (ort) => { ort.env.wasm.wasmPaths = "/vendor/"; },
      baseAssetPath: "/vendor/",

      onSpeechStart: () => {
        console.log("[Wake] Silero VAD: speech started");
        fetch("/api/wake-debug?msg=vad_speech_start").catch(() => {});
      },

      onSpeechEnd: async (audio) => {
        // audio is Float32Array at 16kHz
        if (isCheckingWakeWord) return;

        console.log("[Wake] Silero VAD: speech ended, samples:", audio.length);
        fetch("/api/wake-debug?msg=vad_speech_end_" + audio.length).catch(() => {});

        // Skip very short utterances (< 0.2s = 3200 samples at 16kHz)
        if (audio.length < 3200) {
          console.log("[Wake] Too short, skipping");
          return;
        }

        const wavBlob = float32ToWav(audio, 16000);
        isCheckingWakeWord = true;

        try {
          // Speaker verification gate (returns true if not enrolled)
          const speakerOk = await checkSpeakerVerification(wavBlob);
          if (!speakerOk) {
            console.log("[Wake] Speaker verification rejected");
            isCheckingWakeWord = false;
            return;
          }

          // Wake word transcription
          const resp = await fetch("/api/wake-word", {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: wavBlob,
          });
          const result = await resp.json();
          console.log("[Wake word]", result);

          if (result.wake) {
            state.set('voiceStatusText', t('voice.yabbyDetected') || 'Yabby detected — resuming...');
            resumeFromWakeWord();
            return;
          }
        } catch (err) {
          console.log("[Wake word] Error:", err.message);
        }

        await new Promise(r => setTimeout(r, 1500));
        isCheckingWakeWord = false;
      },

      onVADMisfire: () => {
        console.log("[Wake] Silero VAD misfire (too short)");
        fetch("/api/wake-debug?msg=vad_misfire").catch(() => {});
      },
    });

    micVAD.start();
    console.log("[Wake] Silero VAD started");
  } catch (err) {
    console.error("[Wake] Silero VAD init failed:", err);
    setTimeout(() => startMicMonitor(), 3000);
  }
}

function stopMicMonitor() {
  if (micVAD) {
    try { micVAD.destroy(); } catch {}
    micVAD = null;
  }
  isCheckingWakeWord = false;
}

// ═══════════════════════════════════════
//   Connection management
// ═══════════════════════════════════════

function cleanupConnection() {
  pushVoiceState(false);
  clearInactivityTimer();
  stopMicMonitor();
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) { try { pc.close(); } catch {} pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (persistentMicStream) {
    persistentMicStream.getTracks().forEach(t => t.stop());
    persistentMicStream = null;
  }
  const remoteAudio = document.getElementById("remoteAudio");
  if (remoteAudio) remoteAudio.srcObject = null;
  isSuspended = false;
}

function scheduleReconnect() {
  if (!autoReconnect || isReconnecting) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    state.set('voiceStatusText', t('voice.reconnectFailed') || 'Reconnection failed. Click to retry.');
    reconnectAttempts = 0;
    return;
  }

  isReconnecting = true;
  reconnectAttempts++;
  const delay = RECONNECT_BASE_DELAY * reconnectAttempts;
  state.set('voiceStatusText', t('voice.reconnectingIn', { seconds: delay / 1000 }));

  setTimeout(async () => {
    isReconnecting = false;
    if (!autoReconnect) return;
    await connect();
  }, delay);
}

// ═══════════════════════════════════════
//   CONNECT — main WebRTC setup
// ═══════════════════════════════════════

export async function connect() {
  try {
    state.set('voiceStatus', 'connecting');
    state.set('voiceStatusText', t('voice.connecting'));
    autoReconnect = true;

    const isResume = !!lastResponseId;

    // In text-only mode, use a silent audio track instead of the microphone
    if (textOnlyMode) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      localStream = dest.stream;
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }

    pc = new RTCPeerConnection();

    // In text-only mode, don't play remote audio (no voice responses)
    if (!textOnlyMode) {
      const remoteAudio = document.getElementById("remoteAudio");
      const remoteStream = new MediaStream();
      if (remoteAudio) remoteAudio.srcObject = remoteStream;
      pc.ontrack = (e) => remoteStream.addTrack(e.track);
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        connected = true;
        reconnectAttempts = 0;
        // ✅ En mode texte seul, garder status suspended (jaune) + activer wake word
        if (textOnlyMode) {
          state.set('voiceStatus', 'suspended');
          state.set('voiceStatusText', t('voice.chatConnected') || 'Chat connected — say "Yabby" to activate voice');
          isSuspended = true;  // ✅ Activer wake word monitoring
          // ✅ Démarrer monitoring seulement si pas déjà actif
          if (!persistentMicStream) {
            startWakeWordListening();
          } else {
            console.log("[Yabby] Wake word already active, keeping it");
          }
        } else {
          state.set('voiceStatus', 'connected');
          state.set('voiceStatusText', isResume ? (t('voice.reconnected') || 'Reconnected — conversation in progress...') : (t('voice.listening') || 'Speak, I\'m listening...'));
          pushVoiceState(true);
        }
        // Persist connected state for page reload recovery
        try { localStorage.setItem('yabby_connected', '1'); localStorage.removeItem('yabby_suspended'); } catch {}
        resetInactivityTimer();
      }
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        if (!isSuspended) {
          connected = false;
          state.set('voiceStatus', 'idle');
          if (autoReconnect) {
            state.set('voiceStatusText', t('voice.connectionLost'));
            cleanupConnection();
            scheduleReconnect();
          }
        }
      }
    };

    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    dc = pc.createDataChannel("oai-events");

    dc.onopen = async () => {
      console.log("[Yabby] Data channel open" + (textOnlyMode ? " (text-only)" : ""));

      // Fetch configured voice language
      let voiceLang = "fr";
      try {
        const cfg = await api.config.getAll();
        voiceLang = cfg.voice?.language || cfg.general?.uiLocale || cfg.general?.language || "fr";
      } catch (e) { console.warn("[Yabby] Could not fetch voice language config:", e.message); }

      // In text-only mode, disable audio input (turn detection off)
      if (textOnlyMode) {
        dc.send(JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: {
                turn_detection: null
              }
            },
            modalities: ["text"]
          }
        }));
      } else {
        // Enable input audio transcription + VAD settings
        dc.send(JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: {
                transcription: { model: "gpt-4o-mini-transcribe", language: voiceLang },
                noise_reduction: { type: "near_field" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.85,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 800,
                }
              }
            }
          }
        }));
      }

      // If resuming, inject saved context
      if (isResume) {
        try {
          const stateResp = await fetch(STATE_API);
          const stateData = await stateResp.json();

          let contextParts = [];
          try {
            const memResp = await fetch("/api/memories");
            const memData = await memResp.json();
            if (memData.profile) {
              contextParts.push("User profile:\n" + memData.profile);
            }
          } catch (memErr) {
            console.log("[Yabby] Could not load memories:", memErr.message);
          }

          const recentTurns = (stateData.turns || []).slice(-6);
          if (recentTurns.length > 0) {
            const transcript = recentTurns.map(t =>
              (t.role === "user" ? "User" : "Yabby") + ": " + t.text
            ).join("\n");
            contextParts.push("Recent exchanges:\n" + transcript);
          }

          if (contextParts.length > 0) {
            dc.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "[RESUME CONTEXT — DO NOT REPLY TO THIS MESSAGE]\n\n" + contextParts.join("\n\n") + "\n\nThe conversation is resuming now. You already know this information — do not repeat it, do not recap anything. Simply wait for me to speak." }]
              }
            }));
            console.log("[Yabby] Injected context block for resume (" + contextParts.length + " parts)");
          }
        } catch (err) {
          console.log("[Yabby] Resume context failed:", err.message);
        }
      }
    };

    // ═══ DataChannel message handler (all tool dispatch) ═══
    dc.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        resetInactivityTimer();

        if (msg.type === "input_audio_buffer.speech_started") {
          resetInactivityTimer();
        }

        // Track user audio items for noise filter
        if (msg.type === "conversation.item.created" && msg.item?.role === "user") {
          lastUserItemId = msg.item.id;
        }

        // Track response IDs for conversation continuity
        if (msg.type === "response.done" && msg.response?.id) {
          saveResponseId(msg.response.id);
          finalizeAssistantBubble();
        }

        // Streaming audio transcript
        if ((msg.type === "response.audio_transcript.delta" || msg.type === "response.output_audio_transcript.delta") && msg.delta) {
          updateStreamingText(msg.delta);
        }

        // Streaming text response
        if (msg.type === "response.text.delta" && msg.delta) {
          updateStreamingText(msg.delta);
        }

        // Audio transcript done — finalize bubble
        if ((msg.type === "response.audio_transcript.done" || msg.type === "response.output_audio_transcript.done") && msg.transcript) {
          saveTurn("assistant", msg.transcript);
          finalizeAssistantBubble(msg.transcript);
          checkResponseForHallucination(msg.transcript);
        }

        // Text response done (text-only mode) — finalize bubble
        if (msg.type === "response.text.done" && msg.text) {
          saveTurn("assistant", msg.text);
          finalizeAssistantBubble(msg.text);
          checkResponseForHallucination(msg.text);
        }

        // Track whether the current response included a tool call. Reset on a
        // new response so the check at the end is per-turn. Mirrors the
        // post-hoc classifier used in lib/channels/handler.js.
        if (msg.type === "response.created") {
          currentResponseHadToolCall = false;
        }
        if (msg.type === "response.function_call_arguments.done") {
          currentResponseHadToolCall = true;
        }

        // User transcript + NOISE FILTER
        if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
          const transcript = msg.transcript.trim();
          const wordCount = transcript.split(/\s+/).filter(w => w.length > 0).length;
          const isNoise = noiseFilterActive && (
            NOISE_PATTERNS.test(transcript) ||
            (wordCount <= 2 && !/yabby|lance|crée|vérifie|check|continue|pause|stop|kill|annule|projet|agent|tâche|parle|donne|montre|ouvre|ferme|cherche|fais|dis|aide|veille|launch|create|verify|cancel|project|task|talk|give|show|open|close|search|do|say|help|watch/i.test(transcript)) ||
            transcript.length === 0
          );

          if (isNoise) {
            console.log("[NoiseFilter] Blocked:", JSON.stringify(transcript), `(${wordCount} words)`);
            dc.send(JSON.stringify({ type: "response.cancel" }));
            removeStreamingBubble();
          } else {
            saveTurn("user", transcript);
            addChatMessage("user", transcript);
          }
        }

        // ═══ TOOL CALLS ═══
                if (msg.type === "response.function_call_arguments.done") {
                  const { call_id, name, arguments: argsStr } = msg;
                  const args = JSON.parse(argsStr);
                  let output = "";
                  let data = null;
                  const agentLabel = currentVoiceAgent?.name || "Yabby";

                  try {
                    // Voice only has 3 tools: yabby_execute, yabby_intervention, sleep_mode.
                    // sleep_mode is handled locally (suspend session). The other two
                    // go through the unified tools endpoint.
                    if (name === "sleep_mode") {
                      console.log("[sleep_mode] Yabby going to sleep");
                      output = JSON.stringify({ status: "sleeping" });
                      dc.send(JSON.stringify({
                        type: "conversation.item.create",
                        item: { type: "function_call_output", call_id, output }
                      }));
                      dc.send(JSON.stringify({ type: "response.create" }));
                      setTimeout(() => suspendSession(), 5000);
                      return;
                    }

                    // yabby_execute / yabby_intervention (or any plugin/MCP tool) go through the unified endpoint
                    state.set('voiceStatusText', `${agentLabel} exécute ${name}...`);
                    console.log(`[${name}] Args:`, args);

                    // Context is always scoped to the Yabby super-agent for voice.
                    // Backend reads context.agentId (camelCase) — see routes/tools.js resolveAgentScope.
                    const toolContext = {
                      source: 'voice',
                      agentId: 'yabby-000000',
                      projectId: null,
                      conversationId: '00000000-0000-0000-0000-000000000001', // DEFAULT_CONV_ID
                      lastUserMessage: args.instruction || args.task || args.input || '',
                    };

                    const res = await fetch('/api/tools/execute', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ toolName: name, args, context: toolContext })
                    });

                    data = await res.json();

                    if (data.error) {
                      throw new Error(data.error);
                    }

                    // Track active tasks — reset inactivity on EITHER an
                    // immediate task_id (direct spawn) OR a queue_id (task
                    // enqueued, will spawn shortly). Without this, when the
                    // CLI path returns only a queue_id the session could
                    // time out before the spawn actually happens.
                    if (['yabby_execute', 'yabby_intervention'].includes(name)
                        && (data.task_id || data.queue_id)) {
                      if (data.task_id) activeTaskIds.add(data.task_id);
                      resetInactivityTimer();
                    }

                    output = JSON.stringify(data);
                  } catch (err) {
                    output = JSON.stringify({ error: err.message });
                  }

                  console.log("[Tool result]", output.slice(0, 300));

                  // ✅ NOUVEAU: Détecter et afficher les suggestions contextuelles
                  if (data && data._suggestions) {
                    console.log("[Suggestions]", data._suggestions);

                    // Injecter les suggestions dans le DataChannel pour que l'AI les annonce
                    setTimeout(() => {
                      if (dc && dc.readyState === "open" && connected) {
                        dc.send(JSON.stringify({
                          type: "conversation.item.create",
                          item: {
                            type: "message",
                            role: "user",
                            content: [{
                              type: "input_text",
                              text: `[CONTEXTUAL SUGGESTIONS — DO NOT REPEAT THIS PREAMBLE]\n\n${data._suggestions}\n\nAnnounce these suggestions to the user in a natural and concise manner.`
                            }]
                          }
                        }));
                        dc.send(JSON.stringify({ type: "response.create" }));
                      }
                    }, 1500);  // Delay pour éviter la collision avec response.create
                  }

                  const cappedOutput = output.length > 2000
                    ? output.slice(0, 2000) + "\n...(truncated, " + output.length + " chars total)"
                    : output;
                  dc.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: { type: "function_call_output", call_id, output: cappedOutput }
                  }));
                  dc.send(JSON.stringify({ type: "response.create" }));
                }
      } catch {}
    };

    // ═══ SDP handshake ═══
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const fetchHeaders = {
      "Content-Type": "application/sdp",
      "X-Voice": "marin",
      "X-Model": "gpt-realtime"
    };
    if (isResume) {
      fetchHeaders["X-Resume"] = "true";
    }
    // ✅ NOUVEAU: Indiquer mode texte seul au serveur
    if (textOnlyMode) {
      fetchHeaders["X-Text-Only"] = "true";
    }

    const resp = await fetch(BACKEND_URL, {
      method: "POST",
      headers: fetchHeaders,
      body: offer.sdp
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText);
    }

    const answerSdp = await resp.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (err) {
    state.set('voiceStatusText', `${t('voice.errorPrefix')} : ${err.message || err}`);
    cleanupConnection();
    connected = false;
    state.set('voiceStatus', 'idle');
    if (autoReconnect) {
      scheduleReconnect();
    }
  }
}

// ═══════════════════════════════════════
//   DISCONNECT
// ═══════════════════════════════════════

export function disconnect() {
  autoReconnect = false;
  reconnectAttempts = 0;
  isReconnecting = false;
  isSuspended = false;
  cleanupConnection();
  connected = false;
  state.set('voiceStatus', 'idle');
  state.set('voiceStatusText', '');
  // Clear persisted connection state
  try { localStorage.removeItem('yabby_connected'); localStorage.removeItem('yabby_suspended'); } catch {}
  startWakeWordListening();
}

// ═══════════════════════════════════════
//   SEND TEXT MESSAGE (from chat input)
// ═══════════════════════════════════════

export async function sendTextMessage(text, mediaAssetIds = []) {
  if (!text.trim() && !mediaAssetIds.length) return;

  const trimmedText = text.trim();

  // Si DataChannel ouvert, utiliser WebRTC (voix connectée)
  if (dc && dc.readyState === "open") {
    addChatMessage("user", trimmedText, mediaAssetIds);
    saveTurn("user", trimmedText, mediaAssetIds);

    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: trimmedText }]
      }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));

    resetInactivityTimer();
    return;
  }

  // ✅ NOUVEAU: Connecter en mode texte seul si idle
  console.log("[SEND-TEXT] Not connected — connecting in text-only mode");
  addChatMessage("user", trimmedText, mediaAssetIds);
  saveTurn("user", trimmedText, mediaAssetIds);

  // Activer flag texte seul temporairement
  const wasTextOnly = textOnlyMode;
  textOnlyMode = true;

  try {
    // ✅ CORRECTION: Toujours connecter en mode texte, même si isSuspended
    // (ne PAS appeler resumeFromWakeWord car ça bascule en mode vocal)
    await connect();  // ✅ Utilisera textOnlyMode = true

    // Attendre que le DataChannel soit ouvert (max 5s)
    const maxWait = 5000;
    const start = Date.now();
    while ((!dc || dc.readyState !== "open") && (Date.now() - start < maxWait)) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Si DataChannel ouvert, envoyer
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: trimmedText }]
        }
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
      resetInactivityTimer();
    } else {
      // Timeout - afficher erreur
      console.error("[SEND-TEXT] Timeout waiting for DataChannel connection");
      addChatMessage("error", t('voice.cannotConnect'));
    }
  } finally {
    // Restaurer le flag original (sauf si config le force)
    if (!wasTextOnly) {
      // Vérifier si config force texte seul
      try {
        const config = await api.config.getAll();
        if (config.voice?.micEnabled !== false) {
          textOnlyMode = false;
        }
      } catch {
        textOnlyMode = false;
      }
    }
  }
}

// ═══════════════════════════════════════
//   SSE integration (task/heartbeat/speaker notifications → voice)
// ═══════════════════════════════════════

export function handleSSETask(data) {
  const { taskId, type, detail } = data;
  const id = taskId?.slice(0, 6) || "?";

  resetInactivityTimer();

  if (type === "tool_use" || type === "runner_tool_use") {
    addActivity(`[${id}] 🔧 ${detail.tool}: ${(detail.detail || "").slice(0, 120)}`, 'act-tool');
    state.set('voiceStatusText', `🔧 ${detail.tool}...`);
  } else if (type === "claude_text" || type === "runner_text") {
    addActivity(`[${id}] 💬 ${(detail.text || "").slice(0, 120)}`, 'act-claude');
  } else if (type === "status") {
    addActivity(`[${id}] ${detail.status} (${detail.elapsed}s)`, 'act-status');

    if (detail.status === "done") {
      activeTaskIds.delete(taskId);
      resetInactivityTimer();
      state.set('voiceStatusText', t('voice.taskDone'));
      // Voice announcement is handled by handleSSESpeakerNotify (the curated
      // path the spawner gates on top-level / non-discovery completions).
      // Injecting here too would bill a second Realtime turn and announce
      // sub-agent completions the spawner deliberately chose not to surface.
    }

    if (detail.status === "error") {
      activeTaskIds.delete(taskId);
      resetInactivityTimer();
      state.set('voiceStatusText', t('voice.errorBadge'));
      // Voice announcement handled by handleSSESpeakerNotify on top-level
      // failures (spawner emits speaker_notify type='error' for those).
    }

    if (detail.status === "killed" || detail.status === "paused") {
      activeTaskIds.delete(taskId);
      resetInactivityTimer();
    }
  } else if (type === "stderr") {
    addActivity(`[${id}] ${(detail.text || "").slice(0, 120)}`, 'act-error');
  }
}

export function handleSSEHeartbeat(data) {
  addActivity(`[${data.agentId?.slice(0, 6) || "?"}] ♥ ${data.status} ${data.progress}% — ${(data.summary || "").slice(0, 80)}`, 'act-status');
}

export function handleSSESpeakerNotify(data) {
  addActivity(`[NOTIF] ${data.agentName || "Agent"}: ${data.message.slice(0, 120)}`, 'act-claude');
  resetInactivityTimer();

  const prefix = data.type === "complete" ? t('toast.notifComplete')
    : data.type === "blocker" ? t('toast.notifBlocker')
    : data.type === "milestone" ? t('toast.notifMilestone')
    : t('toast.notifProgress');

  const notificationText = `🔔 ${prefix}: ${data.agentName || "Agent"} (${data.agentRole || ""}) ${t('toast.notifReports')}:\n\n${data.message}`;

  addChatMessage("assistant", notificationText);

  // Send via DataChannel for voice announcement if connected
  if (dc && dc.readyState === "open" && connected) {
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[PROJECT LEAD NOTIFICATION — DO NOT REPEAT THIS PREAMBLE]\n${prefix}: ${data.agentName || "Agent"} (${data.agentRole || ""}) reports: ${data.message}\n\nSummarize this notification to the user in 2 sentences max.` }]
      }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }
}

/**
 * Handle system update instruction
 */
export function handleSystemUpdate(event) {
  const { updateType, message } = event;

  console.log(`[VOICE] System update received: ${updateType}`);
  addActivity(`[SYSTEM UPDATE] ${updateType}: ${message.slice(0, 100)}`, 'act-system');

  // If active voice session, inject as system message
  if (dc && dc.readyState === 'open' && connected) {
    // Inject as user message so LLM sees it
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[MISE À JOUR SYSTÈME]\n${message}`
        }]
      }
    }));

    // Trigger response so Yabby acknowledges
    dc.send(JSON.stringify({ type: "response.create" }));

    console.log(`[VOICE] Update injected into conversation`);
  } else {
    console.log(`[VOICE] No active session, update stored for next session`);
  }

  // Store in localStorage for next session
  if (updateType === 'voice_instruction') {
    const updates = JSON.parse(localStorage.getItem('yabby_pending_updates') || '[]');
    updates.push({ ...event, receivedAt: Date.now() });
    localStorage.setItem('yabby_pending_updates', JSON.stringify(updates));
  }
}

export function handleSSEPlanReview(data) {
  addActivity(`[PLAN] ${data.agentName || 'Agent'}: Plan submitted for review`, 'act-claude');
  resetInactivityTimer();

  // Announce via voice. When the backend supplied a `planSummary` (a short
  // voice-friendly synopsis of the plan in the user's language), instruct
  // Realtime to speak it almost verbatim — that's what the user wants to
  // hear. Otherwise fall back to the generic "plan is ready" prompt.
  if (dc && dc.readyState === "open" && connected) {
    const projectName = data.projectName || "";
    const summary = (typeof data.planSummary === 'string' && data.planSummary.trim()) ? data.planSummary.trim() : null;

    const promptText = summary
      ? `[PLAN NOTIFICATION — DO NOT REPEAT THIS PREAMBLE]\nThe project lead has submitted a plan for project "${projectName}" and the plan is displayed on screen for review. Speak this brief to the user, in the same language and meaning, naturally as if you were briefing them yourself (you may lightly adjust phrasing for spoken flow but keep all content):\n\n"${summary}"`
      : `[PLAN NOTIFICATION — DO NOT REPEAT THIS PREAMBLE]\nThe project lead has submitted a plan for project "${projectName}". The plan is displayed on screen for review. Tell the user: "The project plan is ready. You can review it on screen and approve, revise, or cancel it."`;

    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: promptText }]
      }
    }));
    // Mark the next assistant reply as voice-only so it doesn't get
    // persisted into DEFAULT_CONV_ID and forwarded to channels (it's a
    // contextual brief that only makes sense alongside the on-screen modal).
    skipNextAssistantPersist = true;
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // Open the plan review modal — guard against double-open if one is already
  // active (SSE reconnection, multiple tabs, etc.). The backend also sets
  // shown_as_modal=TRUE after this first emission so page reloads won't retrigger.
  if (state.get('planReviewActive')) {
    console.log('[plan-review] Modal already active, skipping auto-open for', data.reviewId);
    return;
  }
  import('./components/plan-review.js').then(({ openPlanReviewModal }) => {
    openPlanReviewModal(data);
  });
}

export function handleSSEProjectQuestion(data) {
  // ⛔ Removed duplicate addActivity() - already added in sse.js:172
  // addActivity(`[QUESTION] ${data.agentName || 'Agent'}: ${(data.question || '').slice(0, 80)}`, 'act-claude');
  resetInactivityTimer();

  // Inject question into voice stream (voice-only mode, no modal)
  if (dc && dc.readyState === "open" && connected) {
    const text = `[PROJECT QUESTION — DO NOT REPEAT THIS PREAMBLE]\n\nThe project lead "${data.agentName || 'Lead'}" is asking a question for project "${data.projectName || ''}":\n\n"${data.question}"\n\nAsk this question to the user and wait for their answer. When they respond, use the answer_project_question tool with question_id "${data.questionId}" and their exact answer.`;

    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // ⚠️ NO AUTOMATIC MODAL - Questions are now handled sequentially via voice stream
  // Users can still view pending questions via GET /api/project-questions if needed
}

// ═══════════════════════════════════════
//   Init — called once from app.js
// ═══════════════════════════════════════

let textOnlyMode = false;

export async function initVoice() {
  loadResponseId();

  // Check if mic is enabled in config
  try {
    const config = await api.config.getAll();
    if (config.voice?.micEnabled === false) {
      console.log("[Yabby] Mic disabled in config — text-only mode (WebRTC sans micro)");
      textOnlyMode = true;
      state.set('micDisabled', true);
      state.set('voiceStatus', 'idle');
      state.set('voiceStatusText', t('voice.textModeIdle'));

      window.addEventListener("beforeunload", () => {
        autoReconnect = false;
        cleanupConnection();
      });

      console.log("[Yabby] Voice module initialized (text-only)");
      return;
    }
  } catch {
    // Config fetch failed — proceed with default (mic enabled)
  }

  // Check persisted state for page reload recovery
  const wasSuspended = localStorage.getItem('yabby_suspended') === '1';
  const wasConnected = localStorage.getItem('yabby_connected') === '1';

  if (wasConnected && !wasSuspended) {
    // Was fully connected before reload — auto-reconnect immediately
    console.log("[Yabby] Restoring connected state from before page reload");
    connect();
  } else {
    // Normal init: start wake word listening (suspended state)
    startWakeWordListening();
  }

  window.addEventListener("beforeunload", () => {
    autoReconnect = false;
    cleanupConnection();
  });

  console.log("[Yabby] Voice module initialized" + (wasConnected ? " (auto-reconnecting)" : ""));
}

export function isTextOnlyMode() {
  return textOnlyMode;
}

// ═══════════════════════════════════════
//   Exported helpers for orb click
// ═══════════════════════════════════════

export function getVoiceState() {
  return { connected, isSuspended };
}

export async function handleSSEConversationUpdate(data) {
  console.log("[Yabby] Conversation updated from external source (e.g. WhatsApp)");

  // Pull lastResponseId from full conversation-state (needed for voice resume)
  try {
    const resp = await fetch(STATE_API);
    const convData = await resp.json();
    if (convData.lastResponseId) {
      lastResponseId = convData.lastResponseId;
    }
  } catch (err) {
    console.error("[Yabby] Failed to load conversation-state:", err);
  }

  // Reload chatMessages WITH the same pagination window the user has loaded,
  // PLUS whatever new turns were added since we last fetched. Without the
  // `data.turnCount` bump the refetch would return the same N turns (shifted
  // forward), which causes a silent window-shift bug in voice-panel.js Case B.
  try {
    const PAGE_SIZE = 10;
    const currentMessages = state.get('chatMessages') || [];
    // Request enough to cover: existing window + any new turns the server
    // told us about via `data.turnCount`. Fall back to current length + 10
    // to buffer against slightly-stale counts.
    const bufferedLimit = Math.max(
      PAGE_SIZE,
      currentMessages.length + 10,
      Number(data?.turnCount) || 0
    );
    const chat = await api.conversation.getYabbyChat({ limit: bufferedLimit, offset: 0 });
    const turns = (chat?.turns || []).map(t => ({
      role: t.role,
      text: t.text,
      timestamp: t.ts,
      mediaAssetIds: t.mediaAssetIds || [],
      source: t.source || null,
    }));
    console.log("[Yabby] Updating chat with", turns.length, "turns (windowed)");
    state.set('chatMessages', turns);
    state.set('yabbyChatMeta', {
      offset: turns.length,
      hasMore: chat?.hasMore === true,
      loading: false,
    });
  } catch (err) {
    console.error("[Yabby] Failed to reload yabby chat:", err);
  }

  // Dispatch event for voice-panel to refresh display
  state.dispatchEvent(new CustomEvent('conversation_updated', { detail: data }));

  // If voice is active AND the latest turn comes from an external channel
  // (WhatsApp/Telegram/etc.), inject it into Realtime so Yabby answers it
  // out loud, just like a webapp message. The handler.js voice-active
  // bypass guarantees no parallel gpt-5-mini reply will fire.
  try {
    if (!dc || dc.readyState !== "open" || !connected || isSuspended) return;
    const chatMessages = state.get('chatMessages') || [];
    const last = chatMessages[chatMessages.length - 1];
    if (!last || last.role !== "user") return;
    const externalSources = new Set(["whatsapp", "telegram", "discord", "slack", "signal"]);
    if (!externalSources.has(last.source)) return;
    const text = (last.text || "").trim();
    if (!text) return;
    console.log(`[Yabby] Injecting external channel turn (${last.source}) into Realtime: "${text.slice(0, 60)}…"`);
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  } catch (err) {
    console.error("[Yabby] Failed to inject external turn into Realtime:", err);
  }
}
