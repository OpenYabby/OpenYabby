import { LLMProvider } from "./base.js";
import { GoogleGenAI } from "@google/genai";

export class GoogleProvider extends LLMProvider {
  constructor(config = {}) {
    super("google", config);
    this.client = new GoogleGenAI({
      apiKey: config.apiKey || process.env.GOOGLE_API_KEY,
    });
  }

  async _complete(messages, opts = {}) {
    const model = opts.model || this.config.defaultModel || "gemini-2.0-flash";
    // Convert OpenAI-format messages to Google format
    const system = messages.find(m => m.role === "system")?.content;
    const contents = messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        // When content is already an array (multimodal from vision.js), pass
        // through as the Google parts[]. When it's a string, wrap as text part.
        parts: Array.isArray(m.content) ? m.content : [{ text: m.content }],
      }));

    const response = await this.client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: system || undefined,
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens,
      },
    });
    return {
      text: response.text || "",
      usage: {
        input: response.usageMetadata?.promptTokenCount || 0,
        output: response.usageMetadata?.candidatesTokenCount || 0,
      },
    };
  }

  async getModels() {
    return [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ];
  }
}
