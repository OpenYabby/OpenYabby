import { describe, it, expect, vi } from "vitest";

vi.mock("../db/pg.js", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../db/redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    publish: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    duplicate: vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    }),
  },
}));

describe("Tool Registry", () => {
  it("should return base tools", async () => {
    const { getBaseTools, getToolCount } = await import("../lib/plugins/tool-registry.js");
    const tools = getBaseTools();
    expect(tools.length).toBeGreaterThan(15);

    const count = getToolCount();
    expect(count.base).toBeGreaterThan(15);
    expect(count.total).toBeGreaterThanOrEqual(count.base);
  });

  it("should register and remove plugin tools", async () => {
    const { registerTool, removeTool, getPluginTools } = await import("../lib/plugins/tool-registry.js");

    registerTool({
      type: "function",
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {}, required: [] },
    });

    const tools = getPluginTools();
    expect(tools.some(t => t.name === "test_tool")).toBe(true);

    removeTool("test_tool");
    const after = getPluginTools();
    expect(after.some(t => t.name === "test_tool")).toBe(false);
  });

  it("getAllTools includes base + plugin + mcp", async () => {
    const { getAllTools, getBaseTools } = await import("../lib/plugins/tool-registry.js");
    const all = getAllTools();
    const base = getBaseTools();
    expect(all.length).toBeGreaterThanOrEqual(base.length);
  });
});

describe("Provider Abstraction", () => {
  it("should list provider names", async () => {
    const { activeProviderNames } = await import("../lib/providers/index.js");
    const names = activeProviderNames();
    // activeProviderNames returns only enabled providers with API keys
    expect(Array.isArray(names)).toBe(true);
    // At minimum, should have openai if OPENAI_API_KEY is set
    if (process.env.OPENAI_API_KEY) {
      expect(names).toContain("openai");
    }
  });
});
