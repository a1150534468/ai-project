import { randomUUID } from "node:crypto";
import {
  ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
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
}): Promise<T> {
  const operationId = `article-text:${args.projectId}:${randomUUID()}`;
  await args.billing.reserveResource({
    operationId,
    userId: args.userId,
    resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
    units: args.units,
  });
  try {
    await args.onReserved?.(operationId);
    const result = await args.work(operationId);
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
