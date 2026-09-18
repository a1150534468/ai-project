import type { FastifyReply } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { errorMessageOrFallback } from "../_shared/error-message.js";
import { imageDispatchWorstWaitMs } from "../_shared/image-dispatch-gate.js";
import { loadImageAttemptTimeoutMs } from "../_shared/image-service.js";
import { reservationTtlSeconds, upstreamImageWorstMs } from "../_shared/reservation-window.js";
import { segmentRecordSchema, type ProductInput } from "./ecom-route-types.js";
import { WorkflowMutationConflictError } from "./ecom-route-mutation.js";
import { getEcomPlatform } from "./ecom-prompts.js";

type WorkflowShape = {
  readonly id: string;
  readonly userId: string;
  readonly platform: string;
  readonly language: string;
  readonly template: string;
  readonly resolution: string;
  readonly model?: string | null;
  readonly segmentCount: number;
  readonly product: unknown;
  readonly referenceAssetIds: readonly string[];
  readonly masterAssetId: string | null;
  readonly segments: unknown;
  readonly stitchedAssetId: string | null;
  readonly stage: string;
  readonly error: string | null;
  readonly billingOperationIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type AssetShape = {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly requestIndex: number;
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly objectKey: string | null;
  readonly mime: string;
  readonly createdAt: Date;
};

type EcomWorkflowRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["ecomWorkflow"]["findFirst"]>>>;

export class RefundCompensationError extends Error {
  readonly name = "RefundCompensationError";
  readonly operationId: string;

  constructor(operationId: string, detail: string) {
    super(`扣费补偿失败，operationId=${operationId}，${detail}`);
    this.operationId = operationId;
  }
}

export async function findWorkflowOrReply(
  prisma: ReturnType<typeof getPrisma>,
  workflowId: string,
  userId: string,
  reply: FastifyReply,
): Promise<EcomWorkflowRow | null> {
  const workflow = await prisma.ecomWorkflow.findFirst({ where: { id: workflowId, userId } });
  if (workflow) return workflow;
  reply.code(404).send({ error: "工作流不存在" });
  return null;
}

export function findCurrentWorkflow(prisma: ReturnType<typeof getPrisma>, userId: string) {
  return prisma.ecomWorkflow.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
}

export function listRecentWorkflows(prisma: ReturnType<typeof getPrisma>, userId: string, take = 20) {
  return prisma.ecomWorkflow.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, take });
}

export function resolveLanguage(platformId: string): string {
  return getEcomPlatform(platformId)?.market === "foreign" ? "en" : "zh-CN";
}


export function parseWorkflowProduct(value: unknown): ProductInput {
  return {
    name: typeof value === "object" && value && "name" in value && typeof value.name === "string" ? value.name : "",
    category: typeof value === "object" && value && "category" in value && typeof value.category === "string" ? value.category : "",
    sellingPoints: typeof value === "object" && value && "sellingPoints" in value && Array.isArray(value.sellingPoints)
      ? value.sellingPoints.filter((item): item is string => typeof item === "string")
      : [],
    extra: typeof value === "object" && value && "extra" in value && typeof value.extra === "string" ? value.extra : "",
  };
}

export function parseSegments(value: unknown) {
  return segmentRecordSchema.array().parse(value);
}

export function safeErrorMessage(error: unknown): string {
  return errorMessageOrFallback(error, "电商长图处理失败");
}

function serializeWorkflowWithAssets(
  workflow: WorkflowShape,
  masterAsset: AssetShape | null,
  stitchedAsset: AssetShape | null,
) {
  return {
    id: workflow.id,
    platform: workflow.platform,
    language: workflow.language,
    template: workflow.template,
    resolution: workflow.resolution,
    model: workflow.model ?? null,
    segmentCount: workflow.segmentCount,
    product: parseWorkflowProduct(workflow.product),
    referenceAssetIds: [...workflow.referenceAssetIds],
    masterAssetId: workflow.masterAssetId,
    masterAsset: masterAsset ? serializeAsset(masterAsset) : null,
    segments: parseSegments(workflow.segments),
    stitchedAssetId: workflow.stitchedAssetId,
    stitchedAsset: stitchedAsset ? serializeAsset(stitchedAsset) : null,
    stage: workflow.stage,
    error: workflow.error,
    billingOperationIds: [...workflow.billingOperationIds],
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export async function loadSerializedWorkflow(
  prisma: ReturnType<typeof getPrisma>,
  workflow: WorkflowShape,
) {
  const [masterAsset, stitchedAsset] = await Promise.all([
    workflow.masterAssetId
      ? prisma.imageAsset.findFirst({ where: { id: workflow.masterAssetId, userId: workflow.userId } })
      : Promise.resolve(null),
    workflow.stitchedAssetId
      ? prisma.imageAsset.findFirst({ where: { id: workflow.stitchedAssetId, userId: workflow.userId } })
      : Promise.resolve(null),
  ]);
  return serializeWorkflowWithAssets(workflow, masterAsset, stitchedAsset);
}

export async function loadSerializedWorkflows(
  prisma: ReturnType<typeof getPrisma>,
  workflows: readonly WorkflowShape[],
) {
  const assetIds = workflows.flatMap((workflow) => [workflow.masterAssetId, workflow.stitchedAssetId]).filter((value): value is string => Boolean(value));
  const assets = assetIds.length > 0 ? await prisma.imageAsset.findMany({ where: { id: { in: assetIds } } }) : [];
  return workflows.map((workflow) => serializeWorkflowWithAssets(
    workflow,
    workflow.masterAssetId ? assets.find((asset) => asset.id === workflow.masterAssetId && asset.userId === workflow.userId) ?? null : null,
    workflow.stitchedAssetId ? assets.find((asset) => asset.id === workflow.stitchedAssetId && asset.userId === workflow.userId) ?? null : null,
  ));
}

export function serializeAsset(asset: AssetShape) {
  return {
    id: asset.id,
    requestId: asset.requestId,
    originalUrl: asset.originalUrl,
    thumbnailUrl: asset.thumbnailUrl,
    mime: asset.mime,
    createdAt: asset.createdAt.toISOString(),
  };
}

const BILLING_OPERATION_APPEND_MAX_ATTEMPTS = 5;

type BillingOperationRow = { readonly updatedAt: Date; readonly billingOperationIds: readonly string[] };

/**
 * 确定性 operationId（{prefix}{N}）的原子落库：读行 → 派生 N → 以 updatedAt 做 CAS push。
 * create-lock 与 workflow-lock 不互斥，只靠「读后写」会让并发请求派生出同一个 N 并重复扣费，
 * 因此必须 CAS 成功（count===1）后才允许 chargeResource；冲突则重新取行重派，超限报 409。
 */
export async function appendBillingOperationId<T extends BillingOperationRow>(args: {
  readonly row: T;
  readonly prefix: string;
  readonly updateMany: (args: { readonly updatedAt: Date; readonly operationId: string }) => Promise<{ readonly count: number }>;
  readonly reload: () => Promise<T | null>;
  readonly maxAttempts?: number;
}): Promise<{ readonly operationId: string; readonly row: T }> {
  let current = args.row;
  for (let attempt = 0; attempt < (args.maxAttempts ?? BILLING_OPERATION_APPEND_MAX_ATTEMPTS); attempt += 1) {
    const operationId = `${args.prefix}${current.billingOperationIds.filter((id) => id.startsWith(args.prefix)).length}`;
    const appended = await args.updateMany({ updatedAt: current.updatedAt, operationId });
    if (appended.count === 1) {
      const reloaded = await args.reload();
      if (!reloaded) throw new WorkflowMutationConflictError();
      return { operationId, row: reloaded };
    }
    const next = await args.reload();
    if (!next) throw new WorkflowMutationConflictError();
    current = next;
  }
  throw new WorkflowMutationConflictError();
}

export function buildSegmentRecord(args: {
  readonly index: number;
  readonly assetId: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly prompt: string;
  readonly createdAt: Date;
}) {
  return {
    index: args.index,
    assetId: args.assetId,
    originalUrl: args.originalUrl,
    thumbnailUrl: args.thumbnailUrl,
    prompt: args.prompt,
    createdAt: args.createdAt.toISOString(),
  };
}

/**
 * 预留有效期（秒）。电商两条链（主图 / 长图主图+分段）都是「一次调用一张图」：
 * 预留、出图、结算全在一个进程内顺序跑完，所以窗口就是单张图的最坏耗时——按默认取值
 * 单次尝试超时 600s、闸门最坏排队 120s、两次尝试，一张就 36 分钟，是 billing 那个
 * 10 分钟全局兜底的三倍多。不声明的话预留会在出图途中被按 actual=0 关账，
 * 之后 settle 静默返回 0：图交付了、钱没收到，而且电商这两条链的结算失败是**故意不致命**的
 * （图已交出去，退款等于白送），只打日志，所以漏计费在这里更不容易被发现。
 *
 * 续跑余量传 0：电商没有 reaper，每次尝试各自 append 一个 `a{N}` operationId 单独预留，
 * 失败那笔当场退款，不存在「同一笔预留被续跑延长」。
 * 重试预算由调用方传入（deps 可覆盖），保证声明的 TTL 与真实生效的重试次数同源。
 */
export function ecomImageReservationTtlSeconds(
  args: { readonly maxAttempts: number; readonly retryDelayMs: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  return reservationTtlSeconds({
    perHeartbeatMs: upstreamImageWorstMs({
      attemptTimeoutMs: loadImageAttemptTimeoutMs(env),
      dispatchWaitMs: imageDispatchWorstWaitMs(env),
      maxAttempts: args.maxAttempts,
      retryDelayMs: args.retryDelayMs,
    }),
    heartbeats: 1,
    resumeAllowance: 0,
    env,
  });
}
