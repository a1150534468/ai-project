import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

export type { PrismaClient } from "@prisma/client";
export { getRedis } from "./redis.js";
