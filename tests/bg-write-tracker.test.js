import { describe, it, expect } from "vitest";

describe("bg-write-tracker", () => {
  it("flushBgWrites resolves only after all tracked promises settle", async () => {
    const { trackBgWrite, flushBgWrites } = await import("../lib/bg-write-tracker.js");

    let resolveA;
    let resolveB;
    const settled = [];
    const a = new Promise((r) => { resolveA = r; }).then(() => settled.push("a"));
    const b = new Promise((r) => { resolveB = r; }).then(() => settled.push("b"));

    trackBgWrite("task-1", a);
    trackBgWrite("task-1", b);

    let flushDone = false;
    const flushPromise = flushBgWrites("task-1").then(() => { flushDone = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(flushDone).toBe(false);

    resolveA();
    await new Promise((r) => setTimeout(r, 10));
    expect(flushDone).toBe(false);

    resolveB();
    await flushPromise;
    expect(flushDone).toBe(true);
    expect(settled).toEqual(["a", "b"]);
  });

  it("flushBgWrites tolerates rejected tracked promises (uses allSettled)", async () => {
    const { trackBgWrite, flushBgWrites } = await import("../lib/bg-write-tracker.js");

    const failing = Promise.reject(new Error("db down"));
    failing.catch(() => {}); // prevent unhandled rejection
    trackBgWrite("task-2", failing);

    await expect(flushBgWrites("task-2")).resolves.toBeUndefined();
  });

  it("flushBgWrites with no tracked writes resolves immediately", async () => {
    const { flushBgWrites } = await import("../lib/bg-write-tracker.js");
    await expect(flushBgWrites("task-never-tracked")).resolves.toBeUndefined();
  });

  it("tracker entries are scoped per taskId", async () => {
    const { trackBgWrite, flushBgWrites } = await import("../lib/bg-write-tracker.js");

    let resolveOther;
    const other = new Promise((r) => { resolveOther = r; });
    trackBgWrite("task-A", other);

    // Flushing a different taskId should not wait for task-A's promise.
    await expect(flushBgWrites("task-B")).resolves.toBeUndefined();

    // Cleanup so the promise doesn't dangle.
    resolveOther();
    await flushBgWrites("task-A");
  });

  it("flushBgWrites clears tracked promises after settling", async () => {
    const { trackBgWrite, flushBgWrites, _pendingSize } = await import("../lib/bg-write-tracker.js");

    trackBgWrite("task-3", Promise.resolve());
    trackBgWrite("task-3", Promise.resolve());
    expect(_pendingSize("task-3")).toBe(2);

    await flushBgWrites("task-3");
    expect(_pendingSize("task-3")).toBe(0);
  });
});
