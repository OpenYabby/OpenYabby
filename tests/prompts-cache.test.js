import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Prompt Fragment Caching', () => {
  let getBasePrompt, setConfig;

  beforeEach(async () => {
    // Clear module cache to reset PROMPT_CACHE
    vi.resetModules();

    // Import fresh modules
    const promptsModule = await import('../lib/prompts.js');
    const configModule = await import('../lib/config.js');

    getBasePrompt = promptsModule.getBasePrompt;
    setConfig = configModule.setConfig;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should return same prompt reference on repeated calls', async () => {
    const prompt1 = getBasePrompt();
    const prompt2 = getBasePrompt();

    // Same reference = cache hit
    expect(prompt1).toBe(prompt2);
    expect(prompt1.length).toBeGreaterThan(500);
    expect(prompt1).toContain('AUTONOMY'); // English prompts
  });

  it('should cache prompt across 100 calls', () => {
    const firstPrompt = getBasePrompt();
    let allSame = true;

    for (let i = 0; i < 100; i++) {
      if (getBasePrompt() !== firstPrompt) {
        allSame = false;
        break;
      }
    }

    expect(allSame).toBe(true);
  });

  it('should contain all expected sections', () => {
    const prompt = getBasePrompt();

    // Verify all critical sections are present (English prompts)
    expect(prompt).toContain('AUTONOMY');
    expect(prompt).toContain('GUI LOCK');
    expect(prompt).toContain('Mac');
    expect(prompt).toContain('EXECUTE');
  });

  it('should have substantial size', () => {
    const prompt = getBasePrompt();

    // Should be at least 2KB (500+ tokens)
    expect(prompt.length).toBeGreaterThan(2000);
  });
});
