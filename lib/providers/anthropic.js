import { LLMProvider } from "./base.js";
import Anthropic from "@anthropic-ai/sdk";

export class AnthropicProvider extends LLMProvider {
  constructor(config = {}) {
    super("anthropic", config);
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: config.baseUrl || undefined,
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "claude-sonnet-4-5-20250929";
    // Convert OpenAI-format messages to Anthropic format
    const systemMsg = messages.find(m => m.role === "system");
    const chatMessages = messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));

    // Split system prompt into cacheable static + dynamic parts
    const { staticPart, dynamicPart } = this._splitPrompt(systemMsg?.content || "");

    let system;
    if (staticPart && dynamicPart) {
      // Use cache_control for static part (5-min cache, 90% discount on cache hits)
      system = [];
      if (staticPart.length > 1000) {
        system.push({
          type: "text",
          text: staticPart,
          cache_control: { type: "ephemeral" }
        });
      }
      if (dynamicPart) {
        system.push({
          type: "text",
          text: dynamicPart
        });
      }
    } else {
      // No split marker found - use full system prompt as-is
      system = systemMsg?.content || undefined;
    }

    const response = await this.client.messages.create({
      model,
      max_tokens: opts.maxTokens || 4096,
      system: system || undefined,
      messages: chatMessages,
    });

    // Log cache usage for monitoring
    if (response.usage?.cache_creation_input_tokens) {
      console.log(`[ANTHROPIC-CACHE] Created: ${response.usage.cache_creation_input_tokens} tokens`);
    }
    if (response.usage?.cache_read_input_tokens) {
      const saved = Math.round(response.usage.cache_read_input_tokens * 0.9);
      console.log(`[ANTHROPIC-CACHE] Read: ${response.usage.cache_read_input_tokens} tokens (saved ~${saved} tokens)`);
    }

    return {
      text: response.content[0]?.text || "",
      usage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        cacheCreation: response.usage?.cache_creation_input_tokens || 0,
        cacheRead: response.usage?.cache_read_input_tokens || 0,
      },
    };
  }

  /**
   * Split prompt on "## DYNAMIC CONTEXT" marker
   * @private
   */
  _splitPrompt(fullPrompt) {
    const marker = "\n## DYNAMIC CONTEXT\n";

    if (!fullPrompt || !fullPrompt.includes(marker)) {
      // No split - treat entire prompt as static (cacheable)
      return { staticPart: fullPrompt, dynamicPart: "" };
    }

    const [staticPart, dynamicPart] = fullPrompt.split(marker);
    return { staticPart, dynamicPart };
  }

  async getModels() {
    // Anthropic doesn't have a list models endpoint; return known models
    return [
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ];
  }
}
