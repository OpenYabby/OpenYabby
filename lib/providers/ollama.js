import { LLMProvider } from "./base.js";
import { Ollama } from "ollama";

export class OllamaProvider extends LLMProvider {
  constructor(config = {}) {
    super("ollama", config);
    this.client = new Ollama({
      host: config.baseUrl || process.env.OLLAMA_HOST || "http://localhost:11434",
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "llama3.2";
    const response = await this.client.chat({
      model,
      messages,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.maxTokens,
      },
    });
    return {
      text: response.message.content,
      usage: {
        input: response.prompt_eval_count || 0,
        output: response.eval_count || 0,
      },
    };
  }

  async _embed(text, opts = {}) {
    const model = opts.model || "nomic-embed-text";
    const response = await this.client.embed({ model, input: text });
    return response.embeddings[0];
  }

  async getModels() {
    const response = await this.client.list();
    return response.models.map(m => m.name).sort();
  }
}
