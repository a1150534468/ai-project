import { describe, expect, it } from "vitest";
import { ARTICLE_WORKFLOW_PLATFORM_CONFIGS } from "@ai-assistant/article-workflow";
import {
  BILLING_MAX_RESERVATION_TTL_SECONDS,
  BILLING_RECON_GLOBAL_TTL_MS,
  reservationTtlSeconds,
} from "./reservation-window.js";
import {
  ARTICLE_IMAGE_BATCH_SIZE,
  articleProjectStaleMs,
  articleTextReservationTtlSeconds,
} from "../article/article-workflow-shared.js";
import { codexPetReservationTtlSeconds } from "../codex-pet/codex-pet-reservation-window.js";
import { imageReservationTtlSeconds, loadImageStaleTaskMs } from "../image/image-shared.js";
import { novelReservationTtlSeconds } from "../novel/novel-reservation-window.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};
const GLOBAL_FALLBACK_SECONDS = BILLING_RECON_GLOBAL_TTL_MS / 1000;

/**
 * 每个声明了 `reservationTtlSeconds` 的域各一行。
 * 新增预留调用点时在这里补一行——三条不变量在下面统一断言，
 * 漏了就等于把那条链路交回 billing 的 10 分钟兜底去静默漏计费。
 */
const DOMAINS: readonly { readonly name: string; readonly ttlSeconds: number; readonly staleMs?: number }[] = [
  // 生图：卡单阈值按张，一笔预留要跨 张数 × 尝试次数 个心跳间隔。
  { name: "image", ttlSeconds: imageReservationTtlSeconds({ count: 1, maxAttempts: 1 }, EMPTY_ENV), staleMs: loadImageStaleTaskMs(EMPTY_ENV) },
  { name: "image(8×3)", ttlSeconds: imageReservationTtlSeconds({ count: 8, maxAttempts: 3 }, EMPTY_ENV), staleMs: loadImageStaleTaskMs(EMPTY_ENV) },
  // 图文：名义上是文本预留，实际窗口含全部出图批次。
  { name: "article", ttlSeconds: articleTextReservationTtlSeconds(EMPTY_ENV), staleMs: articleProjectStaleMs(EMPTY_ENV) },
  // 小说：预留在建行时就下，结算要等 worker 生成完，窗口是显式的运维预算。
  { name: "novel", ttlSeconds: novelReservationTtlSeconds(EMPTY_ENV) },
  // 桌宠：运行 + 等授权 + 失败结算宽限。
  { name: "codex-pet", ttlSeconds: codexPetReservationTtlSeconds(EMPTY_ENV) },
];

describe("各域声明的预留有效期", () => {
  it.each(DOMAINS)("$name 严格长于 billing 的 10 分钟全局兜底", ({ ttlSeconds }) => {
    // 等于或短于兜底就白声明了：预留照旧在运行途中被按 actual=0 关账，
    // 之后 wallet.Settle 对非 reserved 记录静默返回 nil，调用方只拿到 0。
    expect(ttlSeconds).toBeGreaterThan(GLOBAL_FALLBACK_SECONDS);
  });

  it.each(DOMAINS)("$name 不超过 billing 的 30 天硬上限（否则 reserve 直接 400）", ({ ttlSeconds }) => {
    expect(ttlSeconds).toBeLessThanOrEqual(BILLING_MAX_RESERVATION_TTL_SECONDS);
  });

  it.each(DOMAINS.filter((domain) => domain.staleMs !== undefined))(
    "$name 至少盖住本域自己的卡单阈值：兜底不能早于 reaper 判定卡单",
    ({ ttlSeconds, staleMs }) => {
      expect(ttlSeconds).toBeGreaterThan(Math.ceil(staleMs! / 1000));
    },
  );

  it("窗口越长的域 TTL 越长，口径没有互相抄错", () => {
    // 张数/尝试次数变多必须体现在窗口上；相等说明某处把参数吞掉了。
    expect(imageReservationTtlSeconds({ count: 8, maxAttempts: 3 }, EMPTY_ENV)).toBeGreaterThan(
      imageReservationTtlSeconds({ count: 1, maxAttempts: 1 }, EMPTY_ENV),
    );
  });

  it("图文显式不留续跑余量：它的 reaper 是收尸，不交回续跑", () => {
    const maxImages = Math.max(...Object.values(ARTICLE_WORKFLOW_PLATFORM_CONFIGS).map((config) => config.maxImages));
    expect(articleTextReservationTtlSeconds(EMPTY_ENV)).toBe(
      reservationTtlSeconds({
        perHeartbeatMs: articleProjectStaleMs(EMPTY_ENV),
        heartbeats: 1 + Math.ceil(maxImages / ARTICLE_IMAGE_BATCH_SIZE),
        resumeAllowance: 0,
        env: EMPTY_ENV,
      }),
    );
  });

  it("小说的 worker 停机预算可调，默认覆盖一周以上", () => {
    const week = 7 * 24 * 60 * 60;
    expect(novelReservationTtlSeconds(EMPTY_ENV)).toBeGreaterThan(week);
    expect(novelReservationTtlSeconds({ NOVEL_WORKER_OUTAGE_BUDGET_MS: String(2 * week * 1000) })).toBe(
      novelReservationTtlSeconds(EMPTY_ENV) + week,
    );
  });
});
