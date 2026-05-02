/**
 * Yabby — Configuration Singleton
 *
 * In-memory cache backed by PostgreSQL config table.
 * Falls back to .env if config table is empty.
 * Hot-reloads via Redis pub/sub on "yabby:config-change".
 */

import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { getAllConfig, getConfigValue, setConfigValue } from "../db/queries/config.js";
import { redis } from "../db/redis.js";
import { log } from "./logger.js";

// ── Zod Schemas ──

const VoiceSchema = z.object({
  model: z.string().default("gpt-realtime"),
  voice: z.string().default("marin"),
  language: z.string().default("fr"),
  noiseReduction: z.enum(["near_field", "far_field", "off"]).default("near_field"),
  turnDetection: z.enum(["server_vad", "semantic_vad"]).default("server_vad"),
  micEnabled: z.boolean().default(true),
}).default({});

// CRITICAL: memory.model MUST stay "gpt-5-mini" — nano misses French names. See CLAUDE.md.
const MemorySchema = z.object({
  model: z.string().default("gpt-5-mini"),
  embedder: z.string().default("text-embedding-3-small"),
  extractEveryNTurns: z.number().min(1).default(6),
}).default({});

const AuthSchema = z.object({
  enabled: z.boolean().default(false),
  gatewayPassword: z.string().nullable().default(null),
  sessionTtlDays: z.number().min(1).default(7),
}).default({});

const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  enabled: z.boolean().default(false),
});

const LLMSchema = z.object({
  defaultProvider: z.string().default("openai"),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
}).default({});

const ChannelsSchema = z.object({}).passthrough().default({});
const TTSSchema = z.object({ defaultProvider: z.string().default("edge-tts") }).default({});
const MCPSchema = z.object({ servers: z.array(z.object({}).passthrough()).default([]) }).default({});
const TasksSchema = z.object({
  runner: z.enum(["claude", "codex", "aider", "goose", "cline", "continue", "custom"]).default("claude"),
  runnerPath: z.string().nullable().default(null),
  forwardUrl: z.string().nullable().default(null),
  verbose: z.boolean().default(false),
  // Runner parity v2 is enabled by default to preserve current behavior.
  // Set to false as an emergency rollback switch.
  enableRunnerParityV2: z.boolean().default(true),
}).default({});

const GeneralSchema = z.object({
  language: z.string().default("en"),
  uiLocale: z.string().default("en"),
}).default({});

const OnboardingSchema = z.object({
  completed: z.boolean().default(false),
  userName: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
}).default({});

const ProjectsSchema = z.object({
  // Root of Yabby Workspace (contains Group Projects/ and Independent Tasks/)
  // Group Projects: multi-agent projects
  // Independent Tasks: standalone agents + Yabby super agent (yabby/)
  sandboxRoot: z.string().default(join(homedir(), "Documents", "Yabby Workspace")),
  cleanOnArchive: z.boolean().default(false),
}).default({});

const MediaSchema = z.object({
  // Retention (days). null = keep forever.
  retentionDaysGenerated: z.number().min(1).nullable().default(30),
  retentionDaysInbound: z.number().min(1).nullable().default(null),
  // Ingest limits
  maxImageSizeMb: z.number().min(1).default(20),
  maxPdfSizeMb: z.number().min(1).default(50),
  maxImagesPerMessage: z.number().min(1).max(10).default(10),
}).default({});

const ImagegenSchema = z.object({
  // Auto-disabled on non-Darwin. User can also disable manually.
  enabled: z.boolean().default(process.platform === "darwin"),
  serviceUrl: z.string().default("http://localhost:3002"),
  defaultModel: z.string().default("stabilityai/sdxl-turbo"),
  defaultSize: z.string().regex(/^\d+x\d+$/).default("512x512"),
  defaultSteps: z.number().min(1).max(50).default(4),
  timeoutMs: z.number().min(1000).default(30000),
  maxQueueDepth: z.number().min(1).max(10).default(3),
}).default({});

const SCHEMAS = {
  general: GeneralSchema,
  voice: VoiceSchema,
  memory: MemorySchema,
  auth: AuthSchema,
  llm: LLMSchema,
  channels: ChannelsSchema,
  tts: TTSSchema,
  mcp: MCPSchema,
  tasks: TasksSchema,
  onboarding: OnboardingSchema,
  projects: ProjectsSchema,
  media: MediaSchema,
  imagegen: ImagegenSchema,
};

// ── In-memory cache ──

let configCache = {};
let loaded = false;
const changeListeners = [];

/**
 * Load all config from DB into memory. Falls back to .env-based defaults if table is empty.
 */
export async function loadConfig() {
  try {
    const dbConfig = await getAllConfig();
    if (Object.keys(dbConfig).length === 0) {
      log("[CONFIG] Config table empty, using .env defaults");
      configCache = {};
    } else {
      configCache = dbConfig;
      log(`[CONFIG] Loaded ${Object.keys(dbConfig).length} config keys from DB`);
    }
    // Seed auth gateway password from .env if configured there
    if (process.env.YABBY_AUTH_PASSWORD && !configCache.auth?.gatewayPassword) {
      const authCfg = getConfig("auth");
      authCfg.gatewayPassword = process.env.YABBY_AUTH_PASSWORD;
      if (process.env.YABBY_AUTH_ENABLED === "true") authCfg.enabled = true;
      configCache.auth = authCfg;
      log("[CONFIG] Auth seeded from .env (YABBY_AUTH_PASSWORD)");
    }

    loaded = true;

    // Subscribe to config changes from other processes
    const subscriber = redis.duplicate();
    await subscriber.connect();
    await subscriber.subscribe("yabby:config-change", (message) => {
      try {
        const { key, value } = JSON.parse(message);
        configCache[key] = value;
        log(`[CONFIG] Hot-reloaded: ${key}`);
        for (const cb of changeListeners) {
          try { cb(key, value); } catch {}
        }
      } catch {}
    });
  } catch (err) {
    log(`[CONFIG] Failed to load config: ${err.message}, using defaults`);
    configCache = {};
    loaded = true;
  }
}

/**
 * Get a config value by key. Returns validated value or schema default.
 */
export function getConfig(key) {
  const raw = configCache[key];
  const schema = SCHEMAS[key];

  if (schema) {
    try {
      return schema.parse(raw ?? undefined);
    } catch {
      return schema.parse(undefined);
    }
  }
  return raw ?? null;
}

/**
 * Set a config value. Validates against Zod schema if one exists.
 * Throws on validation failure.
 */
export async function setConfig(key, value) {
  const schema = SCHEMAS[key];
  if (schema) {
    const result = schema.safeParse(value);
    if (!result.success) {
      const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`Config validation failed for "${key}": ${errors}`);
    }
    value = result.data;
  }

  await setConfigValue(key, value);
  configCache[key] = value;
}

/**
 * Register a listener for config changes.
 */
export function onConfigChange(callback) {
  changeListeners.push(callback);
}

/**
 * Validate a config value without saving it.
 */
export function validateConfig(key, value) {
  const schema = SCHEMAS[key];
  if (!schema) return { valid: true, data: value };

  const result = schema.safeParse(value);
  if (result.success) return { valid: true, data: result.data };

  return {
    valid: false,
    errors: result.error.issues.map(i => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

/**
 * Get all config as a flat object.
 */
export function getAllConfigCached() {
  const result = {};
  for (const key of Object.keys(SCHEMAS)) {
    result[key] = getConfig(key);
  }
  return result;
}
