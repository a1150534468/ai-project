import { PrismaClient } from "@prisma/client";
import { lazySingleton } from "./lazy-singleton.js";

export const getPrisma = lazySingleton(() => new PrismaClient());

export type { PrismaClient } from "@prisma/client";
export { getRedis } from "./redis.js";
