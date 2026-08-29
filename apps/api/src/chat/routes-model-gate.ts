/**
 * chat/routes.ts 拆分后的模型启用闸门:进程级的启用集缓存,与读写它的三个入口。
 *
 * `enabledCache` 是**进程级单例状态**,必须和它唯一的三个访问点(`__setEnabledForTest` 写、
 * `isModelEnabled` 读写、`resolveModelMaxOutput` 读)留在同一个文件。拆开或复制一份,
 * `routes.test.ts` 里那句 `__setEnabledForTest(new Set(["OnlyThis"]))` 就会写到另一个副本上,
 * 表现是"注入了空启用集,请求却照样放行" —— 一个只在测试里显形、且看起来像被测代码有 bug 的假象。
 *
 * `isModelEnabled` 在 billing 不可达时 **return true 放行**,这不是漏洞:真正的闸门是后面的
 * reserve 计价,它不可达时整轮会因余额校验失败而拒。这里跟着一起拒只会让计费抖动变成聊天全挂。
 *
 * 同一次刷新里同时缓存启用集和每模型的 `maxOutputTokens`,所以 `resolveModelMaxOutput` 只能在
 * `isModelEnabled` 之后调 —— 路由里的顺序(先校验启用、再取上限)不能颠倒,否则第一次请求拿到 0。
 * 返回 0 的含义是"未配置,交给 run 内的全局默认兜底",不是"不允许输出"。
 *
 * `__setEnabledForTest` 只给测试用,但它是 chat/routes.ts 对外导出面的一部分,由 routes.ts
 * 原样转出。改名或去掉都会让 `routes.test.ts` 的动态 import 静默退化成"不注入"(它带 if 判空),
 * 那条用例会从"校验拒绝"变成"降级放行"而莫名其妙地失败。
 *
 * 依赖方向:本文件是叶子,只依赖 @ai-assistant/billing 的客户端类型。
 */

import { createBillingClient } from "@ai-assistant/billing";

let enabledCache: { at: number; set: Set<string>; maxOutput: Map<string, number> } | null = null;
const ENABLED_TTL_MS = 30_000;

/**
 * 测试钩子：直接注入启用集（仅测试用）。
 */
export function __setEnabledForTest(set: Set<string>): void {
  enabledCache = { at: Date.now(), set, maxOutput: new Map() };
}

/**
 * 校验模型是否启用，30s 缓存，billing 故障降级放行。
 * 同时缓存每个模型的 maxOutputTokens（单次输出上限），供 resolveModelMaxOutput 读取。
 */
export async function isModelEnabled(billing: ReturnType<typeof createBillingClient>, model: string): Promise<boolean> {
  const now = Date.now();
  if (!enabledCache || now - enabledCache.at >= ENABLED_TTL_MS) {
    try {
      const r = await billing.listEnabledModels();
      enabledCache = {
        at: now,
        set: new Set(r.data.map((m) => m.model)),
        maxOutput: new Map(r.data.map((m) => [m.model, Number(m.maxOutputTokens) || 0])),
      };
    } catch {
      return true; // billing 故障降级放行；reserve 计价仍是安全网
    }
  }
  return enabledCache.set.has(model);
}

/**
 * 读取模型配置的单次输出上限（0=未配置，交由 run 内的全局默认兜底）。
 * 依赖 isModelEnabled 已在本次请求前刷新缓存。
 */
export function resolveModelMaxOutput(model: string): number {
  return enabledCache?.maxOutput.get(model) ?? 0;
}
