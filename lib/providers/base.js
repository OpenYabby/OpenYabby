/**
 * Base LLM Provider — abstract class with retry logic and usage logging.
 * All providers extend this and implement _complete() and optionally _stream(), _embed(), getModels().
 */
import { logUsage } from "../../db/queries/usage.js";

export class LLMProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.enabled = config.enabled !== false;
  }

  /** Complete a chat — delegates to _complete with retry */
  async complete(messages, opts = {}) {
    const result = await this._callWithRetry(() => this._complete(messages, opts));
    // Log usage asynchronously (don't block response)
    if (result.usage) {
      logUsage({
        provider: this.name,
        model: opts.model || this.config.defaultModel || "unknown",
        inputTokens: result.usage.input || 0,
        outputTokens: result.usage.output || 0,
        context: opts.context || "chat",
      }).catch(() => {});
    }
    return result;
  }

  /** Stream a chat — delegates to _stream (no retry on streams) */
  async stream(messages, opts = {}) {
    return this._stream(messages, opts);
  }

  /** Embed text — delegates to _embed with retry */
  async embed(text, opts = {}) {
    return this._callWithRetry(() => this._embed(text, opts));
  }

  /** Test connectivity */
  async test() {
    try {
      const models = await this.getModels();
      return { success: true, models };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Subclass must implement ──

  async _complete(/* messages, opts */) {
    throw new Error(`${this.name}: _complete() not implemented`);
  }

  async _stream(/* messages, opts */) {
    throw new Error(`${this.name}: _stream() not implemented`);
  }

  async _embed(/* text, opts */) {
    throw new Error(`${this.name}: _embed() not implemented`);
  }

  async getModels() {
    return [];
  }

  // ── Retry logic: exponential backoff on 429/5xx ──

  async _callWithRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        const status = err.status || err.statusCode;
        if (status === 429 || (status >= 500 && status < 600)) {
          const retryAfter = err.headers?.["retry-after"];
          const delay = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.min(1000 * Math.pow(2, i), 8000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${this.name}: max retries exceeded`);
  }
}
