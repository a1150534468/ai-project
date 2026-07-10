import { Redis } from "ioredis";

let redis: Redis | undefined;

export function getRedis(url = process.env.REDIS_URL): Redis {
  if (!url) throw new Error("REDIS_URL is required");
  if (!redis) redis = new Redis(url);
  return redis;
}
