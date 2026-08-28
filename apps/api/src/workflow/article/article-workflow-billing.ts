import { randomUUID } from "node:crypto";
import {
  ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
  articleTextReservationTtlSeconds,
  type ArticleWorkflowBilling,
} from "./article-workflow-shared.js";

export async function runReservedArticleTextTask<T>(args: {
  readonly billing: ArticleWorkflowBilling;
  readonly userId: string;
  readonly projectId: string;
  readonly units: number;
  readonly work: (operationId: string) => Promise<T>;
  /**
   * reserve 成功后立即回调，用于把 operationId 落库。
   * 落库失败也要走退款路径，所以放在 try 内。
   */
  readonly onReserved?: (operationId: string) => Promise<void>;
  /**
   * work 成功后、settle 之前写终态。
   * 返回 false 表示终态未写入（reaper 已抢先置 failed），此时退款而不是结算：
   * settle 会造成双结算，什么都不做则会漏一笔悬空 reserve。
   */
  readonly commitResult?: (result: T) => Promise<boolean>;
}): Promise<T> {
  const operationId = `article-text:${args.projectId}:${randomUUID()}`;
  await args.billing.reserveResource({
    operationId,
    userId: args.userId,
    resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
    units: args.units,
    // work 里连出图一起跑，窗口远超 billing 的 10 分钟兜底；不声明的话预留会在出图途中
    // 被按 actual=0 关账，下面那句 settle 就静默返回 0，成品照发、钱没收到。
    reservationTtlSeconds: articleTextReservationTtlSeconds(),
  });
  try {
    await args.onReserved?.(operationId);
    const result = await args.work(operationId);
    const committed = (await args.commitResult?.(result)) ?? true;
    if (!committed) {
      await args.billing.refundResource(operationId).catch(() => undefined);
      return result;
    }
    await args.billing.settleResource({
      operationId,
      resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
      units: args.units,
    });
    return result;
  } catch (error) {
    await args.billing.refundResource(operationId).catch(() => undefined);
    throw error;
  }
}
