import { query } from "../../db/pg.js";
import { log } from "../logger.js";

/**
 * Thread Binding Manager
 * Gère les bindings persistants entre threads de conversation et agents
 */
export class ThreadBindingManager {
  constructor({ channel, accountId }) {
    this.channel = channel;
    this.accountId = accountId;
    this.cache = new Map();
  }

  /**
   * Créer un binding thread ↔ agent
   */
  async bindThread({
    threadId,
    conversationId,
    agentId,
    sessionKey,
    idleTimeoutMs = 86400000,  // 24h par défaut
    maxAgeMs = 604800000,       // 7 jours max
    metadata = {},
    ownerUserId = null,         // Single-owner per thread (migration 038)
    ownerUserName = null,
  }) {
    // Check si existe déjà
    const existing = await this.getByThreadId(threadId);
    if (existing) {
      // Touch activity et retourner
      await this.touchActivity(threadId);
      log(`[THREAD-BINDING] Thread ${threadId} already bound to agent ${existing.agent_id}, touched activity`);
      return existing;
    }

    // Créer nouveau binding
    try {
      const result = await query(
        `INSERT INTO channel_thread_bindings
          (channel_name, account_id, thread_id, conversation_id, target_kind, agent_id, session_key, idle_timeout_ms, max_age_ms, metadata, owner_user_id, owner_user_name)
         VALUES ($1, $2, $3, $4, 'agent', $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [this.channel, this.accountId, threadId, conversationId, agentId, sessionKey, idleTimeoutMs, maxAgeMs, JSON.stringify(metadata), ownerUserId, ownerUserName]
      );

      const binding = result.rows[0];
      this.cache.set(threadId, binding);

      log(`[THREAD-BINDING] Created: ${threadId} → agent ${agentId} (channel: ${this.channel}, owner: ${ownerUserId || 'none'})`);
      return binding;
    } catch (err) {
      log(`[THREAD-BINDING] Error creating binding: ${err.message}`);
      throw err;
    }
  }

  /**
   * Supprimer un binding
   */
  async unbindThread(threadId, reason = "manual") {
    try {
      const result = await query(
        `DELETE FROM channel_thread_bindings
         WHERE channel_name = $1 AND account_id = $2 AND thread_id = $3
         RETURNING *`,
        [this.channel, this.accountId, threadId]
      );

      if (result.rows.length > 0) {
        const binding = result.rows[0];
        this.cache.delete(threadId);
        log(`[THREAD-BINDING] Unbound ${threadId} (reason: ${reason}, agent: ${binding.agent_id})`);
        return binding;
      }

      return null;
    } catch (err) {
      log(`[THREAD-BINDING] Error unbinding: ${err.message}`);
      throw err;
    }
  }

  /**
   * Récupérer binding par threadId
   */
  async getByThreadId(threadId) {
    // Check cache d'abord
    if (this.cache.has(threadId)) {
      return this.cache.get(threadId);
    }

    // Query DB
    try {
      const result = await query(
        `SELECT * FROM channel_thread_bindings
         WHERE channel_name = $1 AND account_id = $2 AND thread_id = $3`,
        [this.channel, this.accountId, threadId]
      );

      if (result.rows.length > 0) {
        const binding = result.rows[0];
        this.cache.set(threadId, binding);
        return binding;
      }

      return null;
    } catch (err) {
      log(`[THREAD-BINDING] Error getting binding: ${err.message}`);
      return null;
    }
  }

  /**
   * Récupérer binding par agentId
   */
  async getByAgentId(agentId) {
    try {
      const result = await query(
        `SELECT * FROM channel_thread_bindings
         WHERE agent_id = $1`,
        [agentId]
      );

      return result.rows[0] || null;
    } catch (err) {
      log(`[THREAD-BINDING] Error getting binding by agent: ${err.message}`);
      return null;
    }
  }

  /** Get ALL bindings for an agent (across all channels). */
  async getAllByAgentId(agentId) {
    try {
      const result = await query(
        `SELECT * FROM channel_thread_bindings WHERE agent_id = $1`,
        [agentId]
      );
      return result.rows;
    } catch (err) {
      log(`[THREAD-BINDING] Error getting all bindings by agent: ${err.message}`);
      return [];
    }
  }

  /**
   * Lister tous les bindings pour ce channel/account
   */
  async listBindings() {
    try {
      const result = await query(
        `SELECT * FROM channel_thread_bindings
         WHERE channel_name = $1 AND account_id = $2
         ORDER BY last_activity_at DESC`,
        [this.channel, this.accountId]
      );

      return result.rows;
    } catch (err) {
      log(`[THREAD-BINDING] Error listing bindings: ${err.message}`);
      return [];
    }
  }

  /**
   * Mettre à jour last_activity_at (reset idle timer)
   */
  async touchActivity(threadId) {
    try {
      await query(
        `UPDATE channel_thread_bindings
         SET last_activity_at = NOW(), updated_at = NOW()
         WHERE channel_name = $1 AND account_id = $2 AND thread_id = $3`,
        [this.channel, this.accountId, threadId]
      );

      // Invalider cache pour forcer re-fetch
      this.cache.delete(threadId);
    } catch (err) {
      log(`[THREAD-BINDING] Error touching activity: ${err.message}`);
    }
  }

  /**
   * Cleanup bindings expirés (idle ou max age dépassé)
   */
  async sweep() {
    try {
      const result = await query(
        `DELETE FROM channel_thread_bindings
         WHERE channel_name = $1 AND account_id = $2
         AND (
           last_activity_at < NOW() - (idle_timeout_ms || ' milliseconds')::INTERVAL
           OR bound_at < NOW() - (max_age_ms || ' milliseconds')::INTERVAL
         )
         RETURNING thread_id, agent_id, idle_timeout_ms, max_age_ms, last_activity_at, bound_at`,
        [this.channel, this.accountId]
      );

      if (result.rows.length > 0) {
        log(`[THREAD-BINDING] Swept ${result.rows.length} expired bindings for ${this.channel}:${this.accountId}`);

        result.rows.forEach(row => {
          this.cache.delete(row.thread_id);

          const idleExpired = new Date() - new Date(row.last_activity_at) > row.idle_timeout_ms;
          const ageExpired = new Date() - new Date(row.bound_at) > row.max_age_ms;

          log(`  - ${row.thread_id} (agent: ${row.agent_id}, reason: ${idleExpired ? 'idle' : 'max-age'})`);
        });
      }

      return result.rows.length;
    } catch (err) {
      log(`[THREAD-BINDING] Error during sweep: ${err.message}`);
      return 0;
    }
  }
}

/**
 * Factory pattern - Un manager par channel:accountId
 */
const managers = new Map();

export function getThreadManager(channel, accountId = "main") {
  const key = `${channel}:${accountId}`;

  if (!managers.has(key)) {
    managers.set(key, new ThreadBindingManager({ channel, accountId }));
  }

  return managers.get(key);
}

/**
 * Global sweep scheduler
 * Nettoie tous les bindings expirés toutes les X millisecondes
 */
export function startThreadBindingSweeper(intervalMs = 300000) {
  log(`[THREAD-BINDING] Starting global sweeper (interval: ${intervalMs}ms = ${intervalMs / 60000} min)`);

  const sweepInterval = setInterval(async () => {
    try {
      log("[THREAD-BINDING] Running global sweep...");

      // Sweep global (toutes les tables)
      const result = await query(`
        DELETE FROM channel_thread_bindings
        WHERE last_activity_at < NOW() - (idle_timeout_ms || ' milliseconds')::INTERVAL
           OR bound_at < NOW() - (max_age_ms || ' milliseconds')::INTERVAL
        RETURNING channel_name, account_id, thread_id, agent_id
      `);

      if (result.rows.length > 0) {
        log(`[THREAD-BINDING] Global sweep cleaned ${result.rows.length} bindings`);

        // Group par channel:account
        const grouped = {};
        result.rows.forEach(row => {
          const key = `${row.channel_name}:${row.account_id}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(row);
        });

        // Log par channel
        Object.entries(grouped).forEach(([key, rows]) => {
          log(`  - ${key}: ${rows.length} bindings swept`);
        });

        // Invalider caches
        result.rows.forEach(row => {
          const manager = managers.get(`${row.channel_name}:${row.account_id}`);
          if (manager) {
            manager.cache.delete(row.thread_id);
          }
        });
      } else {
        log("[THREAD-BINDING] Global sweep: no expired bindings");
      }
    } catch (err) {
      log(`[THREAD-BINDING] Error during global sweep: ${err.message}`);
    }
  }, intervalMs);

  // Retourner l'interval pour pouvoir l'arrêter si nécessaire
  return sweepInterval;
}
