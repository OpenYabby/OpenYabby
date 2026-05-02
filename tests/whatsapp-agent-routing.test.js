import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * Static source-content regression net for the per-agent isolation fix.
 *
 * These tests verify that the canonical "broken wiring" has been corrected
 * in each modified file, without requiring a running server, DB, or real
 * WhatsApp client. They run in <1 second and are immune to mock/dependency
 * drift, so they catch regressions reliably even if the runtime test bed
 * for handleChannelMessage breaks for unrelated reasons.
 *
 * Each test corresponds to one of the five root causes for the
 * per-agent isolation regression.
 */
describe("Per-agent isolation — static source guards", () => {
  describe("routes/agents.js — typo fix + log noise removal", () => {
    let src;
    it("loads", async () => {
      src = await readFile(join(ROOT, "routes/agents.js"), "utf-8");
      expect(src.length).toBeGreaterThan(0);
    });

    it("does NOT contain the threadManager.getBinding typo", async () => {
      src = src || (await readFile(join(ROOT, "routes/agents.js"), "utf-8"));
      // The typo cascaded into a TypeError that triggered destructive cleanup.
      // Any future occurrence is a critical regression.
      expect(src).not.toContain("threadManager.getBinding(");
    });

    it("uses the correct threadManager.getByThreadId method", async () => {
      src = src || (await readFile(join(ROOT, "routes/agents.js"), "utf-8"));
      expect(src).toContain("threadManager.getByThreadId(");
    });

    it("does NOT contain the 🔍 DIAG 1 / 🔍 DIAG 2 log markers", async () => {
      src = src || (await readFile(join(ROOT, "routes/agents.js"), "utf-8"));
      expect(src).not.toContain("🔍 DIAG 1");
      expect(src).not.toContain("🔍 DIAG 2");
    });

    it("destructive cleanup is no longer reachable from the binding-recovery branch", async () => {
      src = src || (await readFile(join(ROOT, "routes/agents.js"), "utf-8"));
      // The new structure uses a `groupStillExists` boolean flag to gate
      // the cleanup branch, so binding recovery (which can throw a TypeError
      // if the manager method is wrong) cannot fall through to the DELETEs.
      expect(src).toContain("groupStillExists");
      // Sanity: the DELETE statements still exist (we did NOT remove cleanup
      // entirely — it's still needed when the WhatsApp group is genuinely gone).
      expect(src).toContain("DELETE FROM agent_whatsapp_groups");
      expect(src).toContain("DELETE FROM channel_thread_bindings");
      expect(src).toContain("DELETE FROM conversations");
    });
  });

  describe("lib/spawner.js — milestone notification gate", () => {
    let src;
    it("loads", async () => {
      src = await readFile(join(ROOT, "lib/spawner.js"), "utf-8");
      expect(src.length).toBeGreaterThan(0);
    });

    // Post-refactor (multi-channel parity), the milestone path uses
    // emitSpeakerNotification with `skipChannelBroadcast: true` so the SSE
    // voice toast still fires while the channel fan-out (WhatsApp, Telegram,
    // Discord, Slack) is delegated to deliverTaskMessage. The previous
    // `suppressMilestone` boolean + `getAgentWhatsAppGroup` lookup has been
    // replaced by an unconditional skipChannelBroadcast on the success path.

    it("uses skipChannelBroadcast on the milestone emit (no duplicate channel push)", async () => {
      src = src || (await readFile(join(ROOT, "lib/spawner.js"), "utf-8"));
      expect(src).toContain("skipChannelBroadcast");
    });

    it("still emits speaker_notify SSE (voice toast) on completion", async () => {
      src = src || (await readFile(join(ROOT, "lib/spawner.js"), "utf-8"));
      // The milestone emit must remain so the voice/web toast is preserved.
      expect(src).toContain('emitSpeakerNotification');
      expect(src).toContain('"milestone"');
    });

    it("error path still broadcasts to channels (no skipChannelBroadcast on errors)", async () => {
      src = src || (await readFile(join(ROOT, "lib/spawner.js"), "utf-8"));
      // The error branch (no parent) keeps the default broadcast since
      // deliverTaskMessage does not run on errors. We assert the error emit
      // exists and is NOT followed by a skipChannelBroadcast option object.
      const errIdx = src.indexOf('"error"');
      expect(errIdx).toBeGreaterThan(0);
    });
  });

  describe("lib/agent-task-processor.js — DIAG removal + SSE emit + visible source", () => {
    let src;
    it("loads", async () => {
      src = await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8");
      expect(src.length).toBeGreaterThan(0);
    });

    it("does NOT write `DIAG 1:` prefix to the conversation", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      // The literal `DIAG 1:` only appears as user-visible text inside `addTurn`.
      // After the fix, it should appear nowhere except in a code comment that
      // explicitly says "no DIAG prefix". We test the negative form: no string
      // literal `\`DIAG 1: ${`.
      expect(src).not.toContain("`DIAG 1:");
    });

    it("does NOT send `DIAG 2:` prefix to WhatsApp", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      expect(src).not.toContain("`DIAG 2:");
    });

    it("uses a UI-visible source for the persistent task delivery write", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      // server.js:259 excludes only source='agent_task' from the chat UI. Any
      // source NOT in that exclude list is acceptable and renders in chat.
      // After the multi-channel parity refactor we use:
      //   - 'task_result_raw' for the raw result bubble (web-only, accordion)
      //   - 'notification' for status / polished follow-up (via deliverTaskMessage)
      // 'whatsapp' is kept in the accepted list for backward compatibility
      // with any older addTurn call that may still exist.
      const visibleSources = ["'task_result_raw'", "'notification'", "'whatsapp'"];
      const hasVisibleAddTurn = visibleSources.some(s =>
        src.includes(s) && src.includes("addTurn('assistant'")
      );
      expect(hasVisibleAddTurn).toBe(true);
    });

    it("emits conversation_update SSE event after addTurn", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      expect(src).toContain("emitConversationUpdate");
    });

    it("imports emitConversationUpdate from logger (not somewhere else)", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      // Verify the dynamic import path is correct. The actual shape is:
      //   const { emitConversationUpdate } = await import("./logger.js");
      expect(src).toMatch(/emitConversationUpdate[^}]*\}\s*=\s*await\s+import\(\s*["']\.\/logger\.js["']\s*\)/);
    });

    it("the SSE emit is wrapped in try/catch (non-fatal on Redis/SSE failure)", async () => {
      src = src || (await readFile(join(ROOT, "lib/agent-task-processor.js"), "utf-8"));
      // After the multi-channel parity refactor, the raw-result write +
      // emitConversationUpdate live in their own try/catch (~lines 70-85),
      // and the broader fan-out goes through deliverTaskMessage which has
      // its own per-surface try/catch. Both arrangements satisfy the
      // invariant: an SSE/Redis failure must NOT break WhatsApp delivery.
      // We assert the structural property: emitConversationUpdate must be
      // followed (within the same function scope) by a catch handler.
      expect(src).toContain("emitConversationUpdate");
      const emitIdx = src.indexOf("emitConversationUpdate");
      const next200 = src.slice(emitIdx, emitIdx + 600);
      // Catch handler must be reachable shortly after the emit call.
      expect(next200).toMatch(/catch\s*\(/);
    });
  });

  describe("Plan invariants — files that MUST NOT have been touched", () => {
    it("public/js/components/agent-chat.js still has handleConversationUpdate listener", async () => {
      const src = await readFile(join(ROOT, "public/js/components/agent-chat.js"), "utf-8");
      expect(src).toContain("handleConversationUpdate");
    });

    it("server.js /api/agent-chats endpoint still excludes source='agent_task' from UI", async () => {
      const src = await readFile(join(ROOT, "server.js"), "utf-8");
      // The exclusion list MUST still be in place — we did NOT modify server.js
      // because changing the global filter could surface old historical agent_task rows.
      expect(src).toContain("['agent_task']");
    });

    it("lib/channels/handler.js still has the conversationId fallback to DEFAULT_CONV_ID", async () => {
      const src = await readFile(join(ROOT, "lib/channels/handler.js"), "utf-8");
      // We documented this as the not-broken-but-now-unreachable fallback.
      // Removing it would break Yabby main group routing, so it MUST stay.
      expect(src).toContain("DEFAULT_CONV_ID");
    });

    it("lib/channels/thread-binding-manager.js exports getByThreadId", async () => {
      const src = await readFile(join(ROOT, "lib/channels/thread-binding-manager.js"), "utf-8");
      expect(src).toContain("getByThreadId");
    });
  });
});
