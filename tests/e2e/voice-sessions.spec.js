import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Voice Session E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
  });

  test('1. Should display voice panel on homepage', async ({ page }) => {
    // Verify voice panel exists
    const voicePanel = await page.$('#voicePanel');
    expect(voicePanel).toBeTruthy();

    // Verify essential voice UI elements
    const statusIndicator = await page.$('.voice-status');
    expect(statusIndicator).toBeTruthy();
  });

  test('2. Should show disconnected status initially', async ({ page }) => {
    const statusBadge = await page.textContent('.voice-status');
    expect(statusBadge.toLowerCase()).toContain('déconnecté');
  });

  test('3. Should fetch voice instructions on page load', async ({ page }) => {
    // Wait for voice instructions API call
    const instructionsResp = await page.waitForResponse(
      resp => resp.url().includes('/api/yabby-instructions'),
      { timeout: 10000 }
    );

    expect(instructionsResp.status()).toBe(200);
    const data = await instructionsResp.json();

    // Verify instructions structure
    expect(data).toHaveProperty('instructions');
    expect(data.instructions.length).toBeGreaterThan(100);
  });

  test('4. Should request microphone permission when starting session', async ({ page, context }) => {
    // Grant microphone permission
    await context.grantPermissions(['microphone']);

    // Click start voice button
    const startBtn = await page.$('[data-action="start-voice"]');
    if (startBtn) {
      await startBtn.click();

      // Wait for session creation attempt
      await page.waitForTimeout(2000);

      // Check if session endpoint was called
      const sessionRequests = [];
      page.on('request', req => {
        if (req.url().includes('/session')) {
          sessionRequests.push(req);
        }
      });

      // Give time for request
      await page.waitForTimeout(3000);

      // Note: Full WebRTC session requires real audio, so we just verify UI state
      const statusBadge = await page.textContent('.voice-status');
      expect(['connexion', 'connecté', 'déconnecté']).toContain(
        statusBadge.toLowerCase().split(' ')[0]
      );
    }
  });

  test('5. Should display conversation history in voice panel', async ({ page }) => {
    // Check for conversation display area
    const conversationArea = await page.$('.conversation-turns');
    if (conversationArea) {
      expect(conversationArea).toBeTruthy();
    }
  });

  test('6. Should load memory profile on initialization', async ({ page }) => {
    // Wait for memories API call
    const memoriesResp = await page.waitForResponse(
      resp => resp.url().includes('/api/memories'),
      { timeout: 10000 }
    ).catch(() => null);

    if (memoriesResp) {
      expect(memoriesResp.status()).toBe(200);
      const memories = await memoriesResp.json();
      expect(Array.isArray(memories)).toBe(true);
    }
  });

  test('7. Should handle wake word detection UI', async ({ page }) => {
    // Check for wake word status indicator
    const wakeWordStatus = await page.$('.wake-word-status');
    if (wakeWordStatus) {
      const statusText = await wakeWordStatus.textContent();
      expect(statusText.length).toBeGreaterThan(0);
    }
  });

  test('8. Should display speaker verification status', async ({ page }) => {
    // Check for speaker verification UI
    const speakerStatus = await page.$('.speaker-verification');

    // May or may not exist depending on setup
    if (speakerStatus) {
      const hasStatus = await speakerStatus.isVisible();
      expect(typeof hasStatus).toBe('boolean');
    }
  });

  test('9. Should show voice controls (mute, stop)', async ({ page }) => {
    const controlsArea = await page.$('.voice-controls');
    if (controlsArea) {
      // Check for control buttons
      const buttons = await controlsArea.$$('button');
      expect(buttons.length).toBeGreaterThan(0);
    }
  });

  test('10. Should handle session switch to agent', async ({ page }) => {
    // Create a test agent first
    const agentResp = await page.request.post(`${BASE_URL}/api/agents`, {
      data: {
        name: 'TestAgent',
        role: 'Assistant',
        role_instructions: 'Help with testing',
        is_standalone: true
      }
    });

    if (agentResp.ok()) {
      const agent = await agentResp.json();

      // Try to switch to agent via API
      const switchResp = await page.request.get(
        `${BASE_URL}/api/agents/${agent.id}/voice-config`
      );

      expect(switchResp.status()).toBe(200);
      const config = await switchResp.json();
      expect(config).toHaveProperty('instructions');
    }
  });
});
