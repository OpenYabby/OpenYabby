import { Router } from "express";
import { emitSystemUpdate } from "../lib/logger.js";
import { log } from "../lib/logger.js";
import { cpus, loadavg, totalmem, freemem, platform } from "os";
import { execSync } from "child_process";
import { processHandles } from "../lib/spawner.js";
import pool from "../db/pg.js";

const router = Router();

/**
 * Get instantaneous CPU usage on macOS via `top`.
 * Matches Activity Monitor's CPU %. Falls back to loadavg on other platforms
 * or when top is unavailable.
 */
function getMacCpuPct() {
  if (platform() !== "darwin") return null;
  try {
    const out = execSync("top -l 1 -n 0 -s 0", { encoding: "utf8", timeout: 800 });
    // Line looks like: "CPU usage: 11.60% user, 14.36% sys, 74.3% idle"
    const m = out.match(/CPU usage:\s+([\d.]+)%\s+user,\s+([\d.]+)%\s+sys,\s+([\d.]+)%\s+idle/);
    if (!m) return null;
    const user = Number(m[1]);
    const sys = Number(m[2]);
    return Math.round(user + sys);
  } catch {
    return null;
  }
}

/**
 * Get "real" used memory on macOS via vm_stat.
 * os.freemem() on macOS returns only fully-free pages, ignoring inactive/cached
 * memory that's effectively available. vm_stat gives us a breakdown that
 * matches Activity Monitor's "Memory Pressure" view.
 * Returns null if vm_stat is unavailable (non-macOS or sandboxed).
 */
function getMacMemoryStats() {
  if (platform() !== "darwin") return null;
  try {
    const out = execSync("vm_stat", { encoding: "utf8", timeout: 500 });
    const pageSize = Number((out.match(/page size of (\d+)/) || [])[1]) || 16384;
    const get = (label) => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const pages = {
      free: get("Pages free"),
      active: get("Pages active"),
      inactive: get("Pages inactive"),
      speculative: get("Pages speculative"),
      wired: get("Pages wired down"),
      purgeable: get("Pages purgeable"),
      compressed: get("Pages occupied by compressor"),
    };
    // Available = free + inactive (reclaimable) + speculative + purgeable
    const availableBytes = (pages.free + pages.inactive + pages.speculative + pages.purgeable) * pageSize;
    // Used = active + wired + compressed (the "real" memory pressure)
    const usedBytes = (pages.active + pages.wired + pages.compressed) * pageSize;
    const totalBytes = totalmem();
    return { usedBytes, availableBytes, totalBytes };
  } catch {
    return null;
  }
}

/**
 * GET /api/system/stats — lightweight stats for the topbar widget.
 * CPU load (1-min) + counts of running/paused tasks.
 */
router.get("/api/system/stats", async (_req, res) => {
  try {
    const cpuCount = cpus().length;
    const load1 = loadavg()[0];
    // Prefer macOS instantaneous CPU% (matches Activity Monitor).
    // Fallback to load-average-based % on other platforms or if top fails.
    const macCpu = getMacCpuPct();
    const cpuPct = macCpu !== null
      ? macCpu
      : Math.min(100, Math.round((load1 / cpuCount) * 100));

    // RAM usage — on macOS, prefer vm_stat (matches Activity Monitor).
    // os.freemem() on Darwin only counts fully-free pages and ignores the
    // large pool of reclaimable inactive memory → misleading 99% readings.
    const macMem = getMacMemoryStats();
    let totalBytes, usedBytes;
    if (macMem) {
      totalBytes = macMem.totalBytes;
      usedBytes = macMem.usedBytes;
    } else {
      totalBytes = totalmem();
      usedBytes = totalBytes - freemem();
    }
    const ramPct = Math.min(100, Math.round((usedBytes / totalBytes) * 100));
    const ramUsedGb = Number((usedBytes / 1024 / 1024 / 1024).toFixed(1));
    const ramTotalGb = Number((totalBytes / 1024 / 1024 / 1024).toFixed(1));

    // Count live task processes
    const running = processHandles.size;

    // Count paused tasks from DB (fast query)
    let paused = 0;
    try {
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('paused', 'paused_llm_limit')"
      );
      paused = rows[0]?.n || 0;
    } catch {}

    res.json({
      cpu: { pct: cpuPct, load1: Number(load1.toFixed(2)), cores: cpuCount },
      ram: { pct: ramPct, usedGb: ramUsedGb, totalGb: ramTotalGb },
      tasks: { running, paused },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/system/broadcast-update
 * Broadcast system update to all active voice clients
 * Body: { updateType, message, data }
 */
router.post("/api/system/broadcast-update", async (req, res) => {
  const { updateType, message, data } = req.body;

  if (!updateType || !message) {
    return res.status(400).json({ error: "Missing updateType or message" });
  }

  try {
    emitSystemUpdate(updateType, message, data || {});
    log(`[SYSTEM] Broadcast sent: ${updateType} - ${message}`);
    res.json({ ok: true, broadcast: true });
  } catch (err) {
    log(`[SYSTEM] Broadcast failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
