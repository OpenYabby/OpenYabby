import { LLMProvider } from "./base.js";
import Groq from "groq-sdk";

export class GroqProvider extends LLMProvider {
  constructor(config = {}) {
    super("groq", config);
    this.client = new Groq({
      apiKey: config.apiKey || process.env.GROQ_API_KEY,
      baseURL: config.baseUrl || undefined,
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "llama-3.3-70b-versatile";
    const params = {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens,
    };

    // Groq supports tool/function calling (OpenAI-compatible)
    if (opts.tools && opts.tools.length > 0) {
      params.tools = opts.tools;
      params.tool_choice = opts.toolChoice || "auto";
    }

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    return {
      text: choice.message.content,
      tool_calls: choice.message.tool_calls || undefined,
      usage: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
    };
  }

  async getModels() {
    const response = await this.client.models.list();
    return response.data.map(m => m.id).sort();
  }
}
