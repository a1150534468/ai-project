import { randomInt } from "node:crypto";

/**
 * 生成 8 位随机 UID，范围 10000000–99999999
 * @returns 8 位纯数字字符串
 */
export function generateUid(): string {
  return String(randomInt(10_000_000, 100_000_000));
}

/**
 * 生成唯一的 UID，自动查重并重试
 * @param exists - 异步查重函数，返回 uid 是否已存在
 * @returns 确认不存在的 uid
 * @throws 当重试 10 次仍产生冲突时抛出错误
 */
export async function generateUniqueUid(exists: (uid: string) => Promise<boolean>): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const uid = generateUid();
    if (!(await exists(uid))) {
      return uid;
    }
  }
  throw new Error("UID 生成多次冲突，请重试");
}

/**
 * 生成 `<code>-<8位随机数字>`，如 AB-48210377
 * @param code - 渠道码（通常 2 位大写字母）
 * @returns 格式化的前缀 UID
 */
export function generatePrefixedUid(code: string): string {
  return `${code}-${String(randomInt(10_000_000, 100_000_000))}`;
}

/**
 * 生成唯一的前缀 UID，同渠道命名空间内查重重试
 * @param code - 渠道码
 * @param exists - 异步查重函数，返回 uid 是否已存在
 * @returns 确认不存在的前缀 uid
 * @throws 当重试 10 次仍产生冲突时抛出错误
 */
export async function generateUniquePrefixedUid(
  code: string,
  exists: (uid: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const uid = generatePrefixedUid(code);
    if (!(await exists(uid))) {
      return uid;
    }
  }
  throw new Error("UID 生成多次冲突，请重试");
}
