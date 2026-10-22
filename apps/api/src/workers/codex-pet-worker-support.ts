/**
 * codex-pet-worker 拆分后的公共叶子:两个小工具 —— 从 env 读正数、把异常裁成安全诊断串。
 *
 * 这两个函数拆分前是 codex-pet-worker.ts 里的私有函数,而 recovery 与主文件两边都要用,
 * 所以必须落在一个谁都能 import 的叶子上。它只从 codex-pet 门面取
 * `sanitizeCodexPetDiagnosticText` 一个纯函数,自己不碰 prisma / redis / 队列。
 *
 * 依赖方向:本文件(叶子)→ metrics → recovery → codex-pet-worker.ts。
 */

import { envInt } from "../runtime/env.js";
import { sanitizeCodexPetDiagnosticText } from "../workflow/codex-pet/index.js";

/** 保留这个名字是因为 worker 与 recovery 都按它 import；实现收敛到共享的 envInt。 */
export function positiveNumber(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, key, fallback);
}

export function safeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeCodexPetDiagnosticText(message, 1_000);
}
