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
}): Promise<T> {
  const operationId = `article-text:${args.projectId}:${randomUUID()}`;
  await args.billing.reserveResource({
    operationId,
    userId: args.userId,
    resourceKey: ARTICLE_WORKFLOW_TEXT_RESOURCE_KEY,
    units: args.units,
  });
  try {
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
