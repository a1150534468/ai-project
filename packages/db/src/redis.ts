import { Redis } from "ioredis";
import { lazySingleton } from "./lazy-singleton.js";

const connectRedis = (url = process.env.REDIS_URL): Redis => {
  if (!url) throw new Error("REDIS_URL is required");
  return new Redis(url);
};

export const getRedis = lazySingleton(connectRedis);
