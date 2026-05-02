import { LLMProvider } from "./base.js";

/**
 * OpenRouter — OpenAI-compatible API, no extra SDK needed.
 * Provides access to hundreds of models via a single API key.
 */
export class OpenRouterProvider extends LLMProvider {
  constructor(config = {}) {
    super("openrouter", config);
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = config.baseUrl || "https://openrouter.ai/api/v1";
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "openai/gpt-5-mini";
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yabby.local",
        "X-Title": "Yabby",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens,
      }),
    });
    if (!response.ok) {
      const err = new Error(`OpenRouter: ${response.status} ${response.statusText}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    const choice = data.choices[0];
    return {
      text: choice.message.content,
      usage: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
    };
  }

  async getModels() {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.data || []).slice(0, 50).map(m => m.id);
  }
}
