import { randomInt } from "node:crypto";

const UID_MIN = 10_000_000;
const UID_MAX_EXCLUSIVE = 100_000_000;
const MAX_ATTEMPTS = 10;

export function generateUid(): string {
  return String(randomInt(UID_MIN, UID_MAX_EXCLUSIVE));
}

export function generatePrefixedUid(code: string): string {
  return `${code}-${generateUid()}`;
}

async function findAvailableUid(
  candidate: () => string,
  exists: (uid: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const uid = candidate();
    if (!(await exists(uid))) return uid;
  }
  throw new Error("UID 生成多次冲突，请重试");
}

export function generateUniqueUid(exists: (uid: string) => Promise<boolean>): Promise<string> {
  return findAvailableUid(generateUid, exists);
}

export function generateUniquePrefixedUid(
  code: string,
  exists: (uid: string) => Promise<boolean>,
): Promise<string> {
  return findAvailableUid(() => generatePrefixedUid(code), exists);
}
