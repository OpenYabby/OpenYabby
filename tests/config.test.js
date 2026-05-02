import { describe, it, expect, vi } from "vitest";

// Mock pool.query to avoid real DB connection
vi.mock("../db/pg.js", () => ({
  default: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock("../db/redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    duplicate: vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    }),
  },
}));

describe("Config System", () => {
  it("should export loadConfig function", async () => {
    const mod = await import("../lib/config.js");
    expect(typeof mod.loadConfig).toBe("function");
  });

  it("should export getConfig function", async () => {
    const mod = await import("../lib/config.js");
    expect(typeof mod.getConfig).toBe("function");
  });

  it("should export setConfig function", async () => {
    const mod = await import("../lib/config.js");
    expect(typeof mod.setConfig).toBe("function");
  });

  it("getConfig returns undefined for unknown keys", async () => {
    const { getConfig } = await import("../lib/config.js");
    const result = getConfig("nonexistent_key_12345");
    expect(result).toBeNull(); // getConfig returns null for unknown keys
  });
});
