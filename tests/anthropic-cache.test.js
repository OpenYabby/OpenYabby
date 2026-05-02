import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../lib/providers/anthropic.js';

describe('Anthropic Prompt Caching', () => {
  let provider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      apiKey: 'test-key'
    });
  });

  describe('_splitPrompt', () => {
    it('should split prompt on DYNAMIC CONTEXT marker', () => {
      const prompt = `
Static rules here
API documentation here

## DYNAMIC CONTEXT

Project: Test Project
Agent: agent-123
Role: Developer
`;

      const { staticPart, dynamicPart } = provider._splitPrompt(prompt);

      expect(staticPart).toContain('Static rules');
      expect(staticPart).toContain('API documentation');
      expect(staticPart).not.toContain('DYNAMIC CONTEXT');
      expect(staticPart).not.toContain('Project: Test Project');

      expect(dynamicPart).toContain('Project: Test Project');
      expect(dynamicPart).toContain('Agent: agent-123');
    });

    it('should treat entire prompt as static if no marker', () => {
      const prompt = 'Simple prompt with no marker';

      const { staticPart, dynamicPart } = provider._splitPrompt(prompt);

      expect(staticPart).toBe(prompt);
      expect(dynamicPart).toBe('');
    });

    it('should handle empty prompt', () => {
      const { staticPart, dynamicPart } = provider._splitPrompt('');

      expect(staticPart).toBe('');
      expect(dynamicPart).toBe('');
    });

    it('should handle null/undefined prompt', () => {
      const { staticPart, dynamicPart } = provider._splitPrompt(null);

      expect(staticPart).toBeNull();
      expect(dynamicPart).toBe('');
    });
  });

  describe('_complete with caching', () => {
    it('should add cache_control to static part when marker present', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response text' }],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation_input_tokens: 800,
          cache_read_input_tokens: 0
        }
      });

      provider.client.messages.create = mockCreate;

      // Create a long enough static part (> 1000 chars) to trigger caching
      const staticPart = 'API Documentation\n'.repeat(100);  // ~1800 chars
      const messages = [{
        role: 'system',
        content: `${staticPart}\n## DYNAMIC CONTEXT\nDynamic part with project-specific info`
      }, {
        role: 'user',
        content: 'Hello'
      }];

      await provider._complete(messages);

      const call = mockCreate.mock.calls[0][0];

      // Should have array of system blocks
      expect(call.system).toBeInstanceOf(Array);
      expect(call.system.length).toBe(2);

      // First block (static) should have cache_control
      expect(call.system[0]).toHaveProperty('cache_control');
      expect(call.system[0].cache_control.type).toBe('ephemeral');
      expect(call.system[0].text).toContain('API Documentation');

      // Second block (dynamic) should NOT have cache_control
      expect(call.system[1]).not.toHaveProperty('cache_control');
      expect(call.system[1].text).toContain('Dynamic part');
    });

    it('should use full system prompt when no marker present', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response' }],
        usage: {
          input_tokens: 500,
          output_tokens: 50
        }
      });

      provider.client.messages.create = mockCreate;

      const messages = [{
        role: 'system',
        content: 'Simple system prompt without marker'
      }, {
        role: 'user',
        content: 'Test'
      }];

      await provider._complete(messages);

      const call = mockCreate.mock.calls[0][0];

      // Should use string (not array) when no split
      expect(typeof call.system).toBe('string');
      expect(call.system).toBe('Simple system prompt without marker');
    });

    it('should skip cache_control for short static parts', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response' }],
        usage: {
          input_tokens: 200,
          output_tokens: 20
        }
      });

      provider.client.messages.create = mockCreate;

      const messages = [{
        role: 'system',
        content: `Short\n## DYNAMIC CONTEXT\nDynamic content here`
      }, {
        role: 'user',
        content: 'Hello'
      }];

      await provider._complete(messages);

      const call = mockCreate.mock.calls[0][0];

      // Should have only dynamic part (static too short to cache)
      expect(call.system).toBeInstanceOf(Array);
      expect(call.system.length).toBe(1);
      expect(call.system[0].text).toContain('Dynamic content');
    });

    it('should log cache creation events', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response' }],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation_input_tokens: 800,
          cache_read_input_tokens: 0
        }
      });

      provider.client.messages.create = mockCreate;

      await provider._complete([
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' }
      ]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ANTHROPIC-CACHE] Created: 800 tokens')
      );

      consoleSpy.mockRestore();
    });

    it('should log cache read events with savings', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response' }],
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000
        }
      });

      provider.client.messages.create = mockCreate;

      await provider._complete([
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' }
      ]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ANTHROPIC-CACHE] Read: 1000 tokens')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('saved ~900 tokens')
      );

      consoleSpy.mockRestore();
    });

    it('should return cache usage in response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ text: 'response' }],
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000
        }
      });

      provider.client.messages.create = mockCreate;

      const result = await provider._complete([
        { role: 'system', content: 'Test' },
        { role: 'user', content: 'Hello' }
      ]);

      expect(result.usage).toEqual({
        input: 200,
        output: 50,
        cacheCreation: 0,
        cacheRead: 1000
      });
    });
  });
});
