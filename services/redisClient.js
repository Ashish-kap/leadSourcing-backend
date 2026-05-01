import Redis from "ioredis";

function parseRedisConfig() {
  if (!process.env.REDIS_HOST) {
    return { host: "localhost", port: 6379 };
  }
  try {
    const url = new URL(process.env.REDIS_HOST);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10) || 6379,
      password: url.password ? url.password.replace(/^default:/, "") : undefined,
    };
  } catch {
    return { host: process.env.REDIS_HOST, port: 6379 };
  }
}

export function createRedisClient() {
  return new Redis(parseRedisConfig());
}
