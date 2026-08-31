// `archiving` 阶段的收尾。P1.2 之后这个阶段不再写知识库。
//
// 阶段名保留是为了不动状态机：CODEX_PET_RUN_STAGES 里 packaging → archiving →
// ready 这条链有存量运行正走在上面，改枚举等于给一次纯删除加一次数据迁移。
// 现在 archiving 是一个直通阶段——结清按张计费、置 ready、发事件。
//
// 被删掉的是：CodexPetJob(kind='knowledge_archive') 这套可续跑归档任务、
// withCurrentKnowledgeArchiveLease 的 Run 行锁、CodexPetArchiveDeferredError
// 停在 98% 的驻留路径，以及 6 个终态错误码。产物不落知识库，登记动作没了，
// 为登记动作建的整套持久化重试机制也就没有了存在理由。
//
// 计划：docs/superpowers/plans/2026-08-31-knowledge-vs-asset-library-split.md（P1.2）

import { settlePerImageBilling } from "./runner-billing.js";
import { emit } from "./runner-lease.js";
import type { CodexPetExecutionResult, RunnerContext } from "./runner-types.js";

/**
 * 把已交付的运行推进到 ready。
 *
 * 精灵图、ZIP 兼容包、验证报告在 packaging 阶段就已落库并复核过，这里只做结算
 * 与状态提交，判据只看租约和阶段。
 */
export async function completeArchivingStage(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  await settlePerImageBilling(ctx);
  const now = new Date();
  const readyCommitted = await ctx.prisma.$transaction(async (tx) => {
    const transition = await tx.codexPetRun.updateMany({
      where: { id: ctx.runId, projectId: ctx.project.id, userId: ctx.project.userId, workerId: ctx.workerId, status: "archiving", cancelRequested: false },
      data: { status: "ready", progressStage: "ready", progressPercent: 100, progressMessage: "桌宠已完成，可安装到 Codex", completedAt: now, heartbeatAt: now, workerId: null, error: null },
    });
    if (transition.count !== 1) return false;
    await tx.codexPetProject.updateMany({ where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } }, data: { status: "ready" } });
    return true;
  });
  if (!readyCommitted) throw new Error("运行租约或阶段已变化，桌宠不能进入 ready");
  // ready 就是权威的已提交结果。最后这一次 SSE/事件写失败绝不能把一个可交付的
  // 运行降级成 failed 或触发退款。
  await emit(ctx, "run.completed", "ready", 100, "桌宠已完成").catch(() => undefined);
  return { status: "ready", runId: ctx.runId };
}
