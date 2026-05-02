import { redis, KEY } from "../redis.js";

const LOCK_KEY = KEY("gui_lock");
const LOCK_TTL = 300; // 5 minutes auto-expiry

export async function acquireLock(taskId, isTaskRunning) {
  const current = await redis.hGetAll(LOCK_KEY);

  // If lock exists but holder is no longer running, release it
  if (current.task_id && !isTaskRunning(current.task_id)) {
    await redis.del(LOCK_KEY);
  }

  // Re-check after potential cleanup
  const afterCleanup = await redis.hGetAll(LOCK_KEY);

  if (!afterCleanup.task_id) {
    // Lock is free — acquire it
    await redis.hSet(LOCK_KEY, { task_id: taskId, since: String(Date.now()) });
    await redis.expire(LOCK_KEY, LOCK_TTL);
    return { acquired: true };
  }

  if (afterCleanup.task_id === taskId) {
    // Already held by this task (idempotent)
    return { acquired: true };
  }

  return { acquired: false, held_by: afterCleanup.task_id };
}

export async function releaseLock(taskId) {
  const current = await redis.hGet(LOCK_KEY, "task_id");
  if (current === taskId) {
    await redis.del(LOCK_KEY);
    return { released: true };
  }
  return { released: false };
}

export async function forceReleaseLock() {
  await redis.del(LOCK_KEY);
}

export async function getLockState() {
  const data = await redis.hGetAll(LOCK_KEY);
  if (!data.task_id) {
    return { locked: false, taskId: null, since: null };
  }
  return { locked: true, taskId: data.task_id, since: parseInt(data.since) };
}
