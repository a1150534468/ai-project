import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRequiredEnv,
  collectEnvProblems,
  OPTIONAL_FEATURE_ENV,
  REQUIRED_ENV,
  SERVER_REQUIRED_ENV,
  warnMissingOptionalEnv,
} from "./env.js";

const SRC_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));

/** 一份「全部合法」的最小 env，各用例在它上面只改自己关心的那一项。 */
function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost:5432/app",
    REDIS_URL: "redis://localhost:6379",
    SESSION_SECRET: "a".repeat(32),
    ADMIN_SESSION_SECRET: "b".repeat(32),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectEnvProblems", () => {
  it("全部合法时返回空数组", () => {
    expect(collectEnvProblems(SERVER_REQUIRED_ENV, validEnv())).toEqual([]);
  });

  it("缺项逐条报出，并带上 key 与用途提示", () => {
    const problems = collectEnvProblems(REQUIRED_ENV, {});
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("DATABASE_URL  缺失");
    expect(problems.join("\n")).toContain("REDIS_URL  缺失");
    expect(problems.join("\n")).toContain("SESSION_SECRET  缺失");
    // 提示语要能指路，不能只报 key 名
    expect(problems.join("\n")).toContain("Prisma datasource");
  });

  it("只有空白字符视为缺失", () => {
    expect(collectEnvProblems([{ key: "DATABASE_URL", hint: "x" }], { DATABASE_URL: "   " })).toHaveLength(1);
  });

  // 这是 8-17 那版漏掉的：非空但不足 32 字节，聚合校验放行，
  // 然后 authRoutes/adminRoutes 在注册期抛 —— 等于没做 fail-fast。
  it("密钥非空但短于 32 字节要报错（31 红 / 32 绿）", () => {
    const short = { ...validEnv(), SESSION_SECRET: "a".repeat(31) };
    const problems = collectEnvProblems(REQUIRED_ENV, short);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SESSION_SECRET  太短（31 字节 < 32）");

    const exact = { ...validEnv(), SESSION_SECRET: "a".repeat(32) };
    expect(collectEnvProblems(REQUIRED_ENV, exact)).toEqual([]);
  });

  it("没配 minLength 的项不做长度判定", () => {
    expect(collectEnvProblems(REQUIRED_ENV, { ...validEnv(), DATABASE_URL: "x" })).toEqual([]);
  });

  it("有等价回落 key 时不报缺失（BAILIAN_API_KEY 顶 EMBEDDING_API_KEY）", () => {
    const embedding = OPTIONAL_FEATURE_ENV.filter((item) => item.key === "EMBEDDING_API_KEY");
    expect(embedding).toHaveLength(1);
    expect(collectEnvProblems(embedding, {})).toHaveLength(1);
    expect(collectEnvProblems(embedding, { BAILIAN_API_KEY: "k" })).toEqual([]);
  });
});

describe("必需集的构成", () => {
  it("worker 用的 REQUIRED_ENV 不含只有 HTTP 服务需要的 ADMIN_SESSION_SECRET", () => {
    expect(REQUIRED_ENV.map((item) => item.key)).not.toContain("ADMIN_SESSION_SECRET");
    expect(SERVER_REQUIRED_ENV.map((item) => item.key)).toContain("ADMIN_SESSION_SECRET");
  });

  it("服务缺 ADMIN_SESSION_SECRET 时按不合法处理（缺失与过短都算）", () => {
    const { ADMIN_SESSION_SECRET: _drop, ...withoutAdmin } = validEnv();
    expect(collectEnvProblems(SERVER_REQUIRED_ENV, withoutAdmin)).toHaveLength(1);
    expect(collectEnvProblems(REQUIRED_ENV, withoutAdmin)).toEqual([]);
    const shortAdmin = { ...validEnv(), ADMIN_SESSION_SECRET: "b".repeat(31) };
    expect(collectEnvProblems(SERVER_REQUIRED_ENV, shortAdmin)[0]).toContain("ADMIN_SESSION_SECRET  太短");
  });

  // 下面两条是「源码级钉子」。这层聚合校验的价值全在被调用上：
  // 没有它们，任何人删掉入口里的 assertRequiredEnv() 或删掉一条必需项，
  // 整个仓库不会有任何测试变红 —— 那正是 P1.1 花力气消灭的那类无人看守代码。
  it("注册期就抛 ≥32 字节的密钥必须都在 SERVER_REQUIRED_ENV 里", () => {
    const registrationTimeChecks = ["auth/routes.ts", "admin/routes.ts"];
    const declared = new Map(SERVER_REQUIRED_ENV.map((item) => [item.key, item]));
    for (const relative of registrationTimeChecks) {
      const source = readFileSync(resolve(SRC_ROOT, relative), "utf8");
      const keys = [
        ...source.matchAll(/process\.env\.([A-Z][A-Z_0-9]+);?\n\s*if \(!secret \|\| secret\.length < 32\)/g),
      ].map((match) => match[1]);
      expect(keys.length, `${relative} 的注册期密钥校验形态变了，这条钉子需要同步`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(declared.get(key), `${relative} 注册期要求 ${key}，但它不在 SERVER_REQUIRED_ENV`).toMatchObject({
          minLength: 32,
        });
      }
    }
  });

  it("四个真实进程入口都调用了启动校验", () => {
    // 原本是五个，本地商家宣传剪辑的 worker 随模块在解耦 Phase 1 删掉了。
    const entries: ReadonlyArray<[file: string, call: string]> = [
      ["server.ts", "assertRequiredEnv(SERVER_REQUIRED_ENV)"],
      ["workers/combined-worker.ts", "assertRequiredEnv()"],
      ["workers/codex-pet-worker.ts", "assertRequiredEnv()"],
      ["workers/novel-worker.ts", "assertRequiredEnv()"],
    ];
    for (const [file, call] of entries) {
      // 先剥掉整行注释：否则把调用注释掉（而不是删掉）能骗过这条断言。
      const code = readFileSync(resolve(SRC_ROOT, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");
      expect(code, `${file} 少了 ${call}`).toContain(call);
    }
  });
});

describe("assertRequiredEnv", () => {
  it("不合法时打印每一条并 exit(1)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertRequiredEnv(SERVER_REQUIRED_ENV, { DATABASE_URL: "postgresql://x" });

    expect(exit).toHaveBeenCalledWith(1);
    const printed = error.mock.calls.map((args) => String(args[0])).join("\n");
    expect(printed).toContain("启动被拒绝");
    expect(printed).toContain("REDIS_URL");
    expect(printed).toContain("SESSION_SECRET");
    expect(printed).toContain("ADMIN_SESSION_SECRET");
    expect(printed).not.toContain("DATABASE_URL  缺失");
    expect(printed).toContain(".env.example");
  });

  it("合法时既不打印也不退出", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertRequiredEnv(SERVER_REQUIRED_ENV, validEnv());

    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("warnMissingOptionalEnv", () => {
  it("缺可选 key 时 warn，且不退出", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    warnMissingOptionalEnv({});

    expect(warn).toHaveBeenCalledTimes(OPTIONAL_FEATURE_ENV.length);
    const printed = warn.mock.calls.map((args) => String(args[0])).join("\n");
    expect(printed).toContain("MIMO_API_KEY");
    // 措辞别出现「可选配置缺失 X 缺失」这种复读（问题串里已经带了「缺失」）
    expect(printed).not.toMatch(/缺失[^\n]*缺失/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("配齐（含走回落 key）时一条都不 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env: NodeJS.ProcessEnv = {
      DASHSCOPE_API_KEY: "k", // 顶 BAILIAN_API_KEY 与 EMBEDDING_API_KEY
      ARK_API_KEY: "k",
      CHATGPT_API_KEY: "k", // 顶 GPT_IMAGE_API_KEY
      MIMO_API_KEY: "k",
      SKYHUMAN_API_TOKEN: "k",
      VIDEO_API_KEY: "k", // 顶 TOAPIS_API_KEY
    };

    warnMissingOptionalEnv(env);

    expect(warn).not.toHaveBeenCalled();
  });
});
