/* ═══════════════════════════════════════════════════════
   YABBY — Heap monitor
   ═══════════════════════════════════════════════════════
   Watches V8 heap usage. When it crosses a threshold, forces
   a manual GC (requires --expose-gc) and logs warnings so we
   can spot leaks before OOM crashes.
*/

import { getHeapStatistics } from "node:v8";
import { log } from "./logger.js";

const CHECK_INTERVAL_MS = 60_000;       // every minute
const WARN_RATIO = 0.70;
const FORCE_GC_RATIO = 0.80;
const CRIT_RATIO = 0.90;

const fmtMb = (bytes) => (bytes / 1024 / 1024).toFixed(0) + " MB";

let monitorTimer = null;
let heapLimit = 0;
let lastWarnRatio = 0;

function tryForceGc() {
  if (typeof global.gc === "function") {
    const before = process.memoryUsage().heapUsed;
    global.gc();
    const after = process.memoryUsage().heapUsed;
    log(`[HEAP-MONITOR] GC freed ${fmtMb(before - after)}`);
  } else {
    log(`[HEAP-MONITOR] global.gc unavailable (start with --expose-gc)`);
  }
}

export function startHeapMonitor() {
  heapLimit = getHeapStatistics().heap_size_limit;
  log(`[HEAP-MONITOR] Started. Heap limit: ${fmtMb(heapLimit)}`);

  monitorTimer = setInterval(() => {
    const m = process.memoryUsage();
    const ratio = m.heapUsed / heapLimit;

    if (ratio >= CRIT_RATIO) {
      log(`[HEAP-MONITOR] 🔴 CRITICAL ${(ratio * 100).toFixed(0)}% — heap=${fmtMb(m.heapUsed)}/${fmtMb(heapLimit)} rss=${fmtMb(m.rss)} ext=${fmtMb(m.external)}`);
      tryForceGc();
    } else if (ratio >= FORCE_GC_RATIO) {
      log(`[HEAP-MONITOR] ⚠ ${(ratio * 100).toFixed(0)}% — forcing GC`);
      tryForceGc();
    } else if (ratio >= WARN_RATIO && ratio - lastWarnRatio > 0.05) {
      log(`[HEAP-MONITOR] heap=${fmtMb(m.heapUsed)}/${fmtMb(heapLimit)} (${(ratio * 100).toFixed(0)}%)`);
      lastWarnRatio = ratio;
    } else if (ratio < WARN_RATIO) {
      lastWarnRatio = 0; // reset so we re-warn if we cross again
    }
  }, CHECK_INTERVAL_MS);

  monitorTimer.unref?.();
}

export function stopHeapMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
