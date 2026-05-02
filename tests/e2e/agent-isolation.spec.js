import { test, expect } from '@playwright/test';

/**
 * Per-agent conversation isolation — Playwright headless e2e regression net.
 *
 * These tests cover the runtime behavior of the per-agent isolation fix
 * (sections F.1 tests 1–5).
 *
 * Prerequisites:
 *   - Yabby server running on http://localhost:3000 (npm start)
 *   - PostgreSQL + Redis running
 *   - WhatsApp does NOT need to be connected — the tests tolerate 503 from
 *     /api/agents/whatsapp-thread when WhatsApp is offline (common in CI).
 *
 * The tests create a real standalone agent, hit real HTTP endpoints, and
 * verify DB-backed behavior via follow-up GET requests. The only "browser"
 * tests use headless Chromium via the Playwright `page` fixture to prove the
 * SSE conversation_update listener is wired up correctly.
 *
 * All tests clean up their own fixtures in afterAll.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const YABBY_DEFAULT_CONV_ID = '00000000-0000-0000-0000-000000000001';

test.describe('Per-agent conversation isolation — runtime e2e', () => {
  let testAgentId;
  let testAgentName;

  test.beforeAll(async ({ request }) => {
    // Agent names must be globally unique (enforced by DB constraint, surfaced
    // as HTTP 409). Use a timestamped name so parallel/repeated test runs
    // never collide.
    testAgentName = `TestAgent${Date.now()}`;

    const resp = await request.post(`${BASE_URL}/api/agents`, {
      data: {
        name: testAgentName,
        role: 'QA Engineer',
        role_instructions: 'Test agent created by agent-isolation.spec.js. Safe to delete.'
      }
    });

    if (resp.status() !== 200) {
      const body = await resp.text();
      throw new Error(`Failed to create test agent: ${resp.status()} ${body}`);
    }

    const agent = await resp.json();
    testAgentId = agent.id;
    expect(testAgentId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (testAgentId) {
      // Soft-delete the test agent so re-runs are clean.
      await request.delete(`${BASE_URL}/api/agents/${testAgentId}`);
    }
  });

  // ==========================================================================
  // Test 1 — getBinding typo regression
  // ==========================================================================
  test('1. POST /api/agents/whatsapp-thread is idempotent and never wipes data', async ({ request }) => {
    // First call: may create, return existing, or 503 if WhatsApp is offline.
    const firstResp = await request.post(`${BASE_URL}/api/agents/whatsapp-thread`, {
      data: { agent_id: testAgentId }
    });

    // 200 = WhatsApp connected and group created/verified.
    // 503 = WhatsApp not connected (acceptable in CI — the point of this test
    //       is that the call MUST NOT throw 500 'getBinding is not a function'
    //       and MUST NOT delete rows).
    expect([200, 503]).toContain(firstResp.status());

    // Snapshot the agent's conversation BEFORE the second call
    const beforeResp = await request.get(`${BASE_URL}/api/agent-chats/${testAgentId}`);
    expect(beforeResp.status()).toBe(200);
    const beforeData = await beforeResp.json();
    const turnCountBefore = beforeData.turns.length;
    const convIdBefore = beforeData.conversationId;
    expect(convIdBefore).toBeTruthy();
    expect(convIdBefore).not.toBe(YABBY_DEFAULT_CONV_ID);

    // Second call: MUST be idempotent — same behavior as first call, no 500,
    // no data loss.
    const secondResp = await request.post(`${BASE_URL}/api/agents/whatsapp-thread`, {
      data: { agent_id: testAgentId }
    });
    expect([200, 503]).toContain(secondResp.status());

    // Verify the conversation row is still alive with the same ID and at
    // least the same turn count. (It may have grown if the setup task ran to
    // completion between the two snapshots — that's fine, it must never shrink.)
    const afterResp = await request.get(`${BASE_URL}/api/agent-chats/${testAgentId}`);
    expect(afterResp.status()).toBe(200);
    const afterData = await afterResp.json();
    expect(afterData.conversationId).toBe(convIdBefore);           // ✅ same row
    expect(afterData.turns.length).toBeGreaterThanOrEqual(turnCountBefore);  // ✅ no wipe
  });

  // ==========================================================================
  // Test 2 — Per-agent isolation via web chat
  // ==========================================================================
  test('2. POST /api/agents/:id/message routes to the agent conversation, not Yabby main', async ({ request }) => {
    const uniqueText = `isolation-probe-${Date.now()}`;

    // Send a message TO the agent's web endpoint
    const msgResp = await request.post(`${BASE_URL}/api/agents/${testAgentId}/message`, {
      data: { text: uniqueText }
    });

    // The endpoint calls the LLM inline — allow up to 60s for the round trip.
    expect(msgResp.status()).toBe(200);
    const msgData = await msgResp.json();
    expect(msgData.conversationId).toBeTruthy();

    // ✅ CRITICAL: conversation is NOT Yabby's main conversation
    expect(msgData.conversationId).not.toBe(YABBY_DEFAULT_CONV_ID);

    // Wait briefly for any async DB writes to settle
    await new Promise(r => setTimeout(r, 500));

    // The user turn MUST appear in the agent's conversation
    const agentChatResp = await request.get(`${BASE_URL}/api/agent-chats/${testAgentId}?limit=50`);
    expect(agentChatResp.status()).toBe(200);
    const agentChat = await agentChatResp.json();
    const agentTexts = agentChat.turns.map(t => t.text).join(' | ');
    expect(agentTexts).toContain(uniqueText);                // ✅ user message in agent conv

    // The user turn MUST NOT appear in the Yabby main conversation
    const yabbyResp = await request.get(`${BASE_URL}/api/yabby-chat?limit=50`);
    expect(yabbyResp.status()).toBe(200);
    const yabby = await yabbyResp.json();
    const yabbyTexts = JSON.stringify(yabby.turns);
    expect(yabbyTexts).not.toContain(uniqueText);            // ✅ NO leak into Yabby chat
  });

  // ==========================================================================
  // Test 3 — DIAG prefix removal regression
  // ==========================================================================
  test('3. Web message endpoint does not write DIAG prefixes anywhere', async ({ request }) => {
    const uniqueText = `diag-probe-${Date.now()}`;
    const msgResp = await request.post(`${BASE_URL}/api/agents/${testAgentId}/message`, {
      data: { text: uniqueText }
    });
    expect(msgResp.status()).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    const agentChatResp = await request.get(`${BASE_URL}/api/agent-chats/${testAgentId}?limit=50`);
    const agentChat = await agentChatResp.json();
    const allText = JSON.stringify(agentChat.turns);

    // No DIAG prefix in any turn
    expect(allText).not.toContain('DIAG 1:');
    expect(allText).not.toContain('DIAG 2:');
  });

  // ==========================================================================
  // Test 4 — Live SSE refresh of agent chat window via headless Chromium
  // ==========================================================================
  test('4. SSE conversation_update fires for the agent conversation', async ({ page }) => {
    // First get the agent's conversation ID so we know what to match.
    const convResp = await page.request.get(`${BASE_URL}/api/agent-chats/${testAgentId}`);
    const convData = await convResp.json();
    const agentConvId = convData.conversationId;
    expect(agentConvId).toBeTruthy();
    expect(agentConvId).not.toBe(YABBY_DEFAULT_CONV_ID);

    // Open an EventSource in the page that listens for conversation_update.
    // We capture the events in a page-side array that we can read back after.
    // Note: we use 'domcontentloaded' (not 'networkidle') because the SSE
    // EventSource connection keeps the network permanently active, so
    // 'networkidle' would never resolve.
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      window.__capturedSSE = [];
      const es = new EventSource('/api/logs/stream');
      es.addEventListener('conversation_update', (e) => {
        try {
          window.__capturedSSE.push(JSON.parse(e.data));
        } catch (err) {
          window.__capturedSSE.push({ error: err.message, raw: e.data });
        }
      });
      window.__testEventSource = es;
    });

    // Give the EventSource a moment to connect
    await page.waitForTimeout(500);

    // Send a message via the API — this should trigger a conversation_update
    // SSE event for the agent's conversation.
    const uniqueText = `sse-probe-${Date.now()}`;
    const msgResp = await page.request.post(`${BASE_URL}/api/agents/${testAgentId}/message`, {
      data: { text: uniqueText }
    });
    expect(msgResp.status()).toBe(200);

    // Wait for the SSE event to arrive (handleChannelMessage writes the user
    // and assistant turns and emits conversation_update for each).
    await page.waitForTimeout(3000);

    // Read back the captured events
    const seenEvents = await page.evaluate(() => window.__capturedSSE || []);

    // At least one conversation_update for THIS agent's conversation must have fired
    const matching = seenEvents.filter(e => e && e.conversationId === agentConvId);
    expect(matching.length).toBeGreaterThan(0);

    // Cleanup
    await page.evaluate(() => {
      if (window.__testEventSource) window.__testEventSource.close();
    });
  });

  // ==========================================================================
  // Test 5 — agent_task source visibility regression
  // ==========================================================================
  test('5. Turns with source=whatsapp ARE visible in /api/agent-chats UI endpoint', async ({ request }) => {
    // This test guards the change from source='agent_task' to source='whatsapp'
    // in sendResultToWhatsAppThread. The handleChannelMessage path at
    // lib/channels/handler.js writes with source='whatsapp' — so posting via
    // /api/agents/:id/message exercises the same code path that
    // sendResultToWhatsAppThread uses after the fix.
    const uniqueText = `whatsapp-source-${Date.now()}`;

    const msgResp = await request.post(`${BASE_URL}/api/agents/${testAgentId}/message`, {
      data: { text: uniqueText }
    });
    expect(msgResp.status()).toBe(200);

    await new Promise(r => setTimeout(r, 500));

    // Both user + assistant turns should be visible in the UI endpoint
    // (which filters out source='agent_task'). If the filter were to strip
    // source='whatsapp' rows, this test would fail.
    const chatResp = await request.get(`${BASE_URL}/api/agent-chats/${testAgentId}?limit=50`);
    const chat = await chatResp.json();

    const userTurnsWithProbe = chat.turns.filter(t => t.role === 'user' && t.text === uniqueText);
    expect(userTurnsWithProbe.length).toBe(1);          // ✅ user turn visible
    expect(chat.turns.some(t => t.role === 'assistant')).toBe(true);  // ✅ assistant turn visible
  });

  // ==========================================================================
  // Test 6 — Yabby main conversation untouched regression check
  // ==========================================================================
  test('6. Sending messages to an agent does not modify Yabby main conversation', async ({ request }) => {
    // Snapshot Yabby main conv BEFORE any interaction with our test agent
    const yabbyBeforeResp = await request.get(`${BASE_URL}/api/yabby-chat?limit=100`);
    const yabbyBefore = await yabbyBeforeResp.json();
    const yabbyTurnCountBefore = yabbyBefore.turns.length;

    // Fire several messages at the agent
    const probes = [
      `yabby-untouched-a-${Date.now()}`,
      `yabby-untouched-b-${Date.now()}`,
      `yabby-untouched-c-${Date.now()}`
    ];
    for (const probe of probes) {
      const r = await request.post(`${BASE_URL}/api/agents/${testAgentId}/message`, {
        data: { text: probe }
      });
      expect(r.status()).toBe(200);
    }

    await new Promise(r => setTimeout(r, 1000));

    // Yabby main conv turn count must be unchanged and none of our probes leaked
    const yabbyAfterResp = await request.get(`${BASE_URL}/api/yabby-chat?limit=100`);
    const yabbyAfter = await yabbyAfterResp.json();
    expect(yabbyAfter.turns.length).toBe(yabbyTurnCountBefore);

    const yabbyText = JSON.stringify(yabbyAfter.turns);
    for (const probe of probes) {
      expect(yabbyText).not.toContain(probe);
    }
  });
});
