import { describe, expect, it } from "vitest";
import { getS3 } from "./s3-provider.js";

const FULL_ENV = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_BUCKET: "test-bucket",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
} as NodeJS.ProcessEnv;

describe("getS3 provider", () => {
  it("配齐时返回进程级缓存的同一个客户端", () => {
    const env = { ...FULL_ENV };
    const first = getS3(env);
    expect(first.bucket).toBe("test-bucket");
    expect(getS3(env)).toBe(first);
  });

  it("未配置时显式抛错，且失败被记住（重复调用抛同一个错，不静默返回 null）", () => {
    const env = {} as NodeJS.ProcessEnv;
    let firstError: unknown;
    try {
      getS3(env);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toContain("S3_ENDPOINT");
    let secondError: unknown;
    try {
      getS3(env);
    } catch (error) {
      secondError = error;
    }
    expect(secondError).toBe(firstError);
  });

  it("不同 env 对象互不污染：一份坏配置不影响另一份好配置", () => {
    const bad = {} as NodeJS.ProcessEnv;
    expect(() => getS3(bad)).toThrow();
    expect(getS3({ ...FULL_ENV }).bucket).toBe("test-bucket");
  });
});
