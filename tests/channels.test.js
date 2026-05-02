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

describe("Channel Normalize", () => {
  it("should normalize a message", async () => {
    const { normalize } = await import("../lib/channels/normalize.js");
    const msg = normalize({
      channelName: "telegram",
      channelId: "123",
      userId: "user1",
      userName: "Test User",
      text: "Hello Yabby",
      isGroup: false,
    });

    expect(msg.channelName).toBe("telegram");
    expect(msg.userId).toBe("user1");
    expect(msg.text).toBe("Hello Yabby");
    expect(msg.isGroup).toBe(false);
  });
});

describe("Channel Base Adapter", () => {
  it("should check DM policy", async () => {
    const { ChannelAdapter } = await import("../lib/channels/base.js");
    const adapter = new ChannelAdapter("test", { dmPolicy: "closed", allowedUsers: ["user1"] });

    expect(adapter.isUserAllowed("user1")).toBe(true);
    expect(adapter.isUserAllowed("user2")).toBe(false);
  });

  it("should allow all users in open policy", async () => {
    const { ChannelAdapter } = await import("../lib/channels/base.js");
    const adapter = new ChannelAdapter("test", { dmPolicy: "open" });

    expect(adapter.isUserAllowed("anyone")).toBe(true);
  });
});
