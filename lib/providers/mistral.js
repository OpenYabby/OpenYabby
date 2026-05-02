import { LLMProvider } from "./base.js";
import { Mistral } from "@mistralai/mistralai";

export class MistralProvider extends LLMProvider {
  constructor(config = {}) {
    super("mistral", config);
    this.client = new Mistral({
      apiKey: config.apiKey || process.env.MISTRAL_API_KEY,
      serverURL: config.baseUrl || undefined,
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "mistral-large-latest";
    const response = await this.client.chat.complete({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens,
    });
    const choice = response.choices[0];
    return {
      text: choice.message.content,
      usage: {
        input: response.usage?.promptTokens || 0,
        output: response.usage?.completionTokens || 0,
      },
    };
  }

  async _embed(text, opts = {}) {
    const model = opts.model || "mistral-embed";
    const response = await this.client.embeddings.create({
      model,
      inputs: [text],
    });
    return response.data[0].embedding;
  }

  async getModels() {
    const response = await this.client.models.list();
    return response.data.map(m => m.id).sort();
  }
}
