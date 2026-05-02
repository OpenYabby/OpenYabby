import { createClient } from "redis";

const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redis.on("error", (err) => {
  console.error("[REDIS] Error:", err.message);
});

await redis.connect();

// Create separate client for pub/sub (Redis requirement)
const pubsub = redis.duplicate();
await pubsub.connect();

const KEY = (suffix) => `yabby:${suffix}`;

export { redis, pubsub, KEY };
