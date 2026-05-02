/* ═══════════════════════════════════════════════════════
   YABBY — Topbar system stats widget
   ═══════════════════════════════════════════════════════
   Polls /api/system/stats every 5s and updates the small
   CPU + tasks indicator next to the notification bell.
*/

const POLL_INTERVAL_MS = 5000;

async function fetchStats() {
  try {
    const resp = await fetch('/api/system/stats');
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function applyStats(data) {
  const wrap = document.getElementById('sysStats');
  const cpuEl = document.getElementById('sysCpu');
  const ramEl = document.getElementById('sysRam');
  const runEl = document.getElementById('sysRunning');
  const pauseEl = document.getElementById('sysPaused');
  if (!wrap || !cpuEl || !runEl || !pauseEl || !data) return;

  const cpuPct = data.cpu?.pct ?? 0;
  const ramPct = data.ram?.pct ?? 0;
  cpuEl.textContent = `${cpuPct}%`;
  if (ramEl) ramEl.textContent = `${ramPct}%`;
  runEl.textContent = String(data.tasks?.running ?? 0);
  pauseEl.textContent = String(data.tasks?.paused ?? 0);

  // Visual warning thresholds — highest of CPU/RAM drives the color
  const maxPct = Math.max(cpuPct, ramPct);
  wrap.classList.remove('warn', 'crit');
  if (maxPct >= 90) wrap.classList.add('crit');
  else if (maxPct >= 70) wrap.classList.add('warn');

  // Tooltip with detail
  const load = data.cpu?.load1 ?? 0;
  const cores = data.cpu?.cores ?? 0;
  const ramUsed = data.ram?.usedGb ?? 0;
  const ramTotal = data.ram?.totalGb ?? 0;
  wrap.title =
    `CPU ${cpuPct}% (load ${load} / ${cores} cores)\n` +
    `RAM ${ramPct}% (${ramUsed} / ${ramTotal} GB)\n` +
    `${data.tasks?.running ?? 0} running · ${data.tasks?.paused ?? 0} paused`;
}

export function initSystemStats() {
  // Initial fetch + interval
  const tick = async () => {
    const data = await fetchStats();
    if (data) applyStats(data);
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
