// Tracks in-flight DB writes triggered by Claude CLI bg_task_started /
// bg_task_notification events so the spawner's close handler can wait for
// them to settle before declaring tasks orphaned and deleting the process
// handle. Without this, a child can exit before createBgTask() resolves,
// leaving an OS process running but no DB row for markOrphanedBgTasksDead
// to find on shutdown.

const pending = new Map(); // taskId -> Set<Promise>

export function trackBgWrite(taskId, promise) {
  let set = pending.get(taskId);
  if (!set) {
    set = new Set();
    pending.set(taskId, set);
  }
  const wrapped = Promise.resolve(promise).finally(() => set.delete(wrapped));
  set.add(wrapped);
}

export async function flushBgWrites(taskId) {
  const set = pending.get(taskId);
  if (!set || set.size === 0) {
    pending.delete(taskId);
    return;
  }
  await Promise.allSettled([...set]);
  pending.delete(taskId);
}

// Test helper. Not part of the public API.
export function _pendingSize(taskId) {
  return pending.get(taskId)?.size ?? 0;
}
