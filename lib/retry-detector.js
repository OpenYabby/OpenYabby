/* ═══════════════════════════════════════════════════════
   YABBY — Retry Pattern Detector
   ═══════════════════════════════════════════════════════
   Detects infinite retry loops in task activity logs.
*/

import { log } from './logger.js';

/**
 * Only tools that interact with the OUTSIDE world are monitored — these are
 * where real loops happen (a failing bash command, a browser action that
 * never resolves, an MCP call hitting the same broken endpoint).
 *
 * Content-producing tools (Write, Edit, Read, Grep, Glob, TodoWrite,
 * WebFetch, WebSearch) are legitimately repetitive — an agent writing a
 * 10-section report will call Write 10 times. Excluding them eliminates
 * false positives without losing genuine loop detection.
 */
const MONITORED_TOOL_PREFIXES = ['Bash', 'mcp_', 'mcp__'];
function isMonitoredTool(toolName) {
  return MONITORED_TOOL_PREFIXES.some(p => toolName.startsWith(p));
}

/**
 * Analyze activity log for retry patterns
 * @param {string} activityLog - Full activity log
 * @returns {object} - { isStuck: boolean, pattern: string, count: number, suggestion: string }
 */
export function detectRetryLoop(activityLog) {
  if (!activityLog) return { isStuck: false };

  const lines = activityLog.split('\n');
  const recentTools = lines
    .filter(l => l.includes('TOOL:'))
    .slice(-30)
    .map(l => {
      const match = l.match(/TOOL:\s+(\w+)\s+→\s+({.*})/);
      if (!match) return null;
      const [_, toolName, argsJson] = match;
      if (!isMonitoredTool(toolName)) return null;
      try {
        const args = JSON.parse(argsJson);
        const normalizedCommand = args.command
          ? args.command.replace(/Date\.now\(\)/g, 'TIMESTAMP').replace(/sleep \d+/g, 'sleep N')
          : JSON.stringify(args);
        return { toolName, command: normalizedCommand };
      } catch {
        return { toolName, command: 'unparseable' };
      }
    })
    .filter(Boolean);

  if (recentTools.length < 10) return { isStuck: false };

  const commandCounts = {};
  for (const { toolName, command } of recentTools) {
    const key = `${toolName}:${command}`;
    commandCounts[key] = (commandCounts[key] || 0) + 1;
  }

  const maxRepeat = Object.entries(commandCounts)
    .sort((a, b) => b[1] - a[1])[0];

  if (!maxRepeat) return { isStuck: false };

  const [pattern, count] = maxRepeat;
  const threshold = 8;

  if (count >= threshold) {
    const [toolName] = pattern.split(':');
    let suggestion = 'Try a different approach or tool.';

    if (toolName === 'Bash' && pattern.includes('osascript')) {
      suggestion = '❌ AppleScript failing repeatedly. Switch to Chrome DevTools MCP tools (mcp_chrome-devtools_browser_*)';
    } else if (toolName === 'Bash' && pattern.includes('fetch')) {
      suggestion = 'Service Worker may be blocking. Try browser_evaluate with inline script injection.';
    } else if (toolName === 'Bash' && pattern.includes('sleep')) {
      suggestion = 'Waiting for async result that never arrives. Check if Promise resolved correctly.';
    }

    return {
      isStuck: true,
      pattern: pattern.slice(0, 100),
      count,
      threshold,
      suggestion,
    };
  }

  return { isStuck: false };
}

/**
 * Inject retry loop warning into task if detected
 */
export async function checkAndWarnRetryLoop(taskId, activityLog) {
  const analysis = detectRetryLoop(activityLog);

  if (analysis.isStuck) {
    log(`[RETRY-DETECTOR] ⚠️ Task ${taskId} stuck in loop: ${analysis.pattern.slice(0, 60)}... (${analysis.count}× repeated)`);
    log(`[RETRY-DETECTOR] 💡 Suggestion: ${analysis.suggestion}`);

    // Emit warning event to task's agent
    const { emitTaskEvent } = await import('./logger.js');
    emitTaskEvent({
      taskId,
      type: 'warning',
      message: `⚠️ RETRY LOOP DETECTED\n\nPattern: ${analysis.pattern.slice(0, 150)}\nRepeated: ${analysis.count} times (threshold: ${analysis.threshold})\n\n💡 ${analysis.suggestion}`,
    });

    return true;
  }

  return false;
}
