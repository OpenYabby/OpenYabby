import { log } from "../logger.js";

/**
 * Channel Debouncer
 * Batching intelligent de messages pour réduire spam et coûts LLM
 *
 * Usage:
 * const debouncer = new ChannelDebouncer({
 *   channel: "whatsapp",
 *   buildKey: (msg) => `${msg.from}:${msg.channelId}`,
 *   shouldDebounce: (msg) => !msg.media && msg.text.length < 10,
 *   onFlush: async (batch) => await processMessage(batch.at(-1)),
 *   debounceMs: 2000
 * });
 *
 * debouncer.push(incomingMessage);
 */
export class ChannelDebouncer {
  constructor({
    channel,
    buildKey,
    shouldDebounce,
    onFlush,
    debounceMs = 2000
  }) {
    if (!channel) throw new Error("channel is required");
    if (!buildKey) throw new Error("buildKey function is required");
    if (!shouldDebounce) throw new Error("shouldDebounce function is required");
    if (!onFlush) throw new Error("onFlush function is required");

    this.channel = channel;
    this.buildKey = buildKey;
    this.shouldDebounce = shouldDebounce;
    this.onFlush = onFlush;
    this.debounceMs = debounceMs;

    // State
    this.batches = new Map();  // key → [messages]
    this.timers = new Map();   // key → timer handle
  }

  /**
   * Push un message dans le debouncer
   * Soit bypass immédiatement, soit batch avec timer
   */
  push(message) {
    // Check si doit être debounced
    if (!this.shouldDebounce(message)) {
      // Bypass: traiter immédiatement
      log(`[DEBOUNCER:${this.channel}] Bypass debounce (media or important)`);
      this.onFlush([message]);
      return;
    }

    // Build unique key pour ce batch
    const key = this.buildKey(message);

    // Add to batch
    if (!this.batches.has(key)) {
      this.batches.set(key, []);
    }
    this.batches.get(key).push(message);

    const batchSize = this.batches.get(key).length;

    // Clear existing timer (si existe)
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // Set new timer
    const timer = setTimeout(async () => {
      await this.flush(key);
    }, this.debounceMs);

    this.timers.set(key, timer);

    log(`[DEBOUNCER:${this.channel}] Batched message (key: ${key}, batch size: ${batchSize}, debounce: ${this.debounceMs}ms)`);
  }

  /**
   * Flush un batch (traiter le dernier message)
   */
  async flush(key) {
    const batch = this.batches.get(key);
    if (!batch || batch.length === 0) {
      return;
    }

    log(`[DEBOUNCER:${this.channel}] Flushing batch (key: ${key}, ${batch.length} message(s))`);

    // ⚠️ CRITICAL: AWAIT onFlush avant cleanup pour éviter race conditions
    await this.onFlush(batch);

    // Cleanup APRÈS fin de onFlush
    this.batches.delete(key);

    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    log(`[DEBOUNCER:${this.channel}] Batch flushed and cleaned up for ${key}`);
  }

  /**
   * Flush tous les batches en attente
   * Utile lors du shutdown
   */
  flushAll() {
    log(`[DEBOUNCER:${this.channel}] Flushing all batches (${this.batches.size} pending)`);

    for (const key of this.batches.keys()) {
      this.flush(key);
    }
  }

  /**
   * Get stats pour monitoring
   */
  getStats() {
    return {
      channel: this.channel,
      pendingBatches: this.batches.size,
      totalPendingMessages: Array.from(this.batches.values()).reduce((sum, batch) => sum + batch.length, 0)
    };
  }
}
