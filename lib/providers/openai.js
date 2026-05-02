import { LLMProvider } from "./base.js";
import OpenAI from "openai";

export class OpenAIProvider extends LLMProvider {
  constructor(config = {}) {
    super("openai", config);
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl || undefined,
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "gpt-4o";

    // gpt-5+ models use max_completion_tokens instead of max_tokens
    const isGpt5Plus = /^gpt-5|^o[1-9]|^o[1-9]-/.test(model);
    const tokenParam = isGpt5Plus ? 'max_completion_tokens' : 'max_tokens';

    const createOpts = {
      model,
      messages,
      [tokenParam]: opts.maxTokens,
    };

    // gpt-5+ only supports temperature=1 (default)
    if (!isGpt5Plus) {
      createOpts.temperature = opts.temperature ?? 0.7;
    }

    // Add tools if provided
    if (opts.tools && opts.tools.length > 0) {
      createOpts.tools = opts.tools;
      if (opts.toolChoice) {
        createOpts.tool_choice = opts.toolChoice;
      }
    }

    const response = await this.client.chat.completions.create(createOpts);
    const choice = response.choices[0];

    return {
      text: choice.message.content || null,
      tool_calls: choice.message.tool_calls || null,
      finish_reason: choice.finish_reason,
      usage: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
    };
  }

  async _stream(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "gpt-4o";
    const isGpt5Plus = /^gpt-5|^o[1-9]|^o[1-9]-/.test(model);
    const tokenParam = isGpt5Plus ? 'max_completion_tokens' : 'max_tokens';

    const streamOpts = {
      model,
      messages,
      [tokenParam]: opts.maxTokens,
      stream: true,
    };
    if (!isGpt5Plus) {
      streamOpts.temperature = opts.temperature ?? 0.7;
    }
    const stream = await this.client.chat.completions.create(streamOpts);
    return stream;
  }

  async _embed(text, opts = {}) {
    const model = opts.model || "text-embedding-3-small";
    const response = await this.client.embeddings.create({
      model,
      input: text,
    });
    return response.data[0].embedding;
  }

  async getModels() {
    const response = await this.client.models.list();
    return response.data
      .filter(m => m.id.startsWith("gpt") || m.id.includes("embed") || m.id.includes("o1") || m.id.includes("o3") || m.id.includes("o4"))
      .map(m => m.id)
      .sort();
  }
}
