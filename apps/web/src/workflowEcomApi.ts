import { ApiError, readErrorMessage } from "./apiError";

export type WorkflowEcomPlatformId = "taobao" | "tmall" | "jd" | "pdd" | "xianyu" | "amazon" | "ebay" | "etsy" | "shopee" | "lazada" | "shopify";
export type WorkflowEcomTemplateId = "general" | "premium" | "digital" | "beauty" | "food" | "gift" | "apparel" | "home";
export type WorkflowEcomPlatformMarket = "domestic" | "foreign";
export type WorkflowEcomSegmentIndex = number;
export type WorkflowEcomStage = "draft" | "master_running" | "master_ready" | "master_failed" | "segments_running" | "segments_ready" | "segment_failed" | "stitched" | "stitch_failed";
export type WorkflowEcomResolution = "1K" | "2K" | "4K";

export type WorkflowEcomPlatform = {
  readonly id: WorkflowEcomPlatformId;
  readonly name: string;
  readonly market: WorkflowEcomPlatformMarket;
};

export type WorkflowEcomTemplate = {
  readonly id: WorkflowEcomTemplateId;
  readonly name: string;
  readonly tag: string;
  readonly style: string;
  readonly master: string;
  readonly segments: readonly string[];
};

export type WorkflowEcomImageAsset = {
  readonly id: string;
  readonly requestId: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly mime: string;
  readonly createdAt: string;
};

export type WorkflowEcomInlineImageInput = {
  readonly b64: string;
  readonly mime?: string;
};

export type WorkflowEcomProductInput = {
  readonly name: string;
  readonly category: string;
  readonly sellingPoints: readonly string[];
  readonly extra: string;
};

export type WorkflowEcomSegment = {
  readonly index: WorkflowEcomSegmentIndex;
  readonly assetId: string;
  readonly originalUrl: string;
  readonly thumbnailUrl: string;
  readonly prompt: string;
  readonly createdAt: string;
};

export type WorkflowEcomWorkflow = {
  readonly id: string;
  readonly platform: WorkflowEcomPlatformId;
  readonly language: string;
  readonly template: WorkflowEcomTemplateId;
  readonly resolution: WorkflowEcomResolution;
  readonly product: WorkflowEcomProductInput;
  readonly referenceAssetIds: readonly string[];
  readonly masterAssetId: string | null;
  readonly masterAsset: WorkflowEcomImageAsset | null;
  readonly segments: readonly WorkflowEcomSegment[];
  readonly stitchedAssetId: string | null;
  readonly stitchedAsset: WorkflowEcomImageAsset | null;
  readonly stage: WorkflowEcomStage;
  readonly error: string | null;
  readonly billingOperationIds: readonly string[];
  readonly segmentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type WorkflowEcomMasterPayload = {
  readonly platformId: WorkflowEcomPlatformId;
  readonly templateId: WorkflowEcomTemplateId;
  readonly resolution: WorkflowEcomResolution;
  readonly product: WorkflowEcomProductInput;
  readonly referenceAssetIds?: readonly string[];
  readonly segmentCount: number;
};

type WorkflowEcomResponse<T> = {
  readonly data: T;
};

export async function requestWorkflowEcom<T>(args: {
  readonly token: string;
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly fallback: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetch(args.path, {
    method: args.method,
    headers: args.body === undefined
      ? { authorization: `Bearer ${args.token}` }
      : { "content-type": "application/json", authorization: `Bearer ${args.token}` },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response, args.fallback), response.status);
  return ((await response.json()) as WorkflowEcomResponse<T>).data;
}

export type WorkflowEcomResourcePrice = {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
};

export type WorkflowEcomPricing = {
  readonly master: Record<WorkflowEcomResolution, WorkflowEcomResourcePrice>;
  readonly segment: Record<WorkflowEcomResolution, WorkflowEcomResourcePrice>;
  readonly stitch: WorkflowEcomResourcePrice;
};

export async function getWorkflowEcomPricing(token: string): Promise<WorkflowEcomPricing> {
  return requestWorkflowEcom<WorkflowEcomPricing>({ token, path: "/api/workflow/ecom/pricing", method: "GET", fallback: "获取电商长图计价失败" });
}

export async function getWorkflowEcomOptions(token: string): Promise<{
  readonly platforms: readonly WorkflowEcomPlatform[];
  readonly templates: readonly WorkflowEcomTemplate[];
}> {
  const data = await requestWorkflowEcom<{
    readonly platforms?: readonly WorkflowEcomPlatform[];
    readonly templates?: readonly WorkflowEcomTemplate[];
  }>({ token, path: "/api/workflow/ecom/options", method: "GET", fallback: "获取电商长图配置失败" });
  return {
    platforms: data.platforms ?? [],
    templates: data.templates ?? [],
  };
}

export async function createWorkflowEcomReference(token: string, image: WorkflowEcomInlineImageInput): Promise<WorkflowEcomImageAsset> {
  const data = await requestWorkflowEcom<{ readonly asset: WorkflowEcomImageAsset }>({
    token,
    path: "/api/workflow/ecom/references",
    method: "POST",
    fallback: "上传参考图失败",
    body: { image },
  });
  return data.asset;
}

export async function getCurrentWorkflowEcom(token: string): Promise<WorkflowEcomWorkflow | null> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow | null }>({
    token,
    path: "/api/workflow/ecom/current",
    method: "GET",
    fallback: "获取当前电商长图工作流失败",
  });
  return data.workflow;
}

export async function listWorkflowEcomHistory(token: string): Promise<readonly WorkflowEcomWorkflow[]> {
  const data = await requestWorkflowEcom<{ readonly workflows?: readonly WorkflowEcomWorkflow[] }>({
    token,
    path: "/api/workflow/ecom/history",
    method: "GET",
    fallback: "获取电商长图历史失败",
  });
  return data.workflows ?? [];
}

export async function createWorkflowEcomMaster(token: string, payload: WorkflowEcomMasterPayload): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: "/api/workflow/ecom/master",
    method: "POST",
    fallback: "生成电商长图主图失败",
    body: payload,
  });
  return data.workflow;
}

export async function retryWorkflowEcomMaster(token: string, workflowId: string): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: `/api/workflow/ecom/${encodeURIComponent(workflowId)}/master/retry`,
    method: "POST",
    fallback: "重试生成主图失败",
  });
  return data.workflow;
}

export async function confirmWorkflowEcomSegments(token: string, workflowId: string): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: `/api/workflow/ecom/${encodeURIComponent(workflowId)}/segments/confirm`,
    method: "POST",
    fallback: "生成长图分段失败",
  });
  return data.workflow;
}

export async function redrawWorkflowEcomSegment(
  token: string,
  workflowId: string,
  index: WorkflowEcomSegmentIndex,
): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: `/api/workflow/ecom/${encodeURIComponent(workflowId)}/segments/${index}/redraw`,
    method: "POST",
    fallback: "重绘长图分段失败",
  });
  return data.workflow;
}

export async function stitchWorkflowEcom(
  token: string,
  workflowId: string,
  image: WorkflowEcomInlineImageInput,
): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: `/api/workflow/ecom/${encodeURIComponent(workflowId)}/stitch`,
    method: "POST",
    fallback: "保存拼接长图失败",
    body: { image },
  });
  return data.workflow;
}

export type WorkflowEcomAdoptMasterPayload = WorkflowEcomMasterPayload & { readonly masterAssetId: string };

export async function adoptWorkflowEcomMaster(token: string, payload: WorkflowEcomAdoptMasterPayload): Promise<WorkflowEcomWorkflow> {
  const data = await requestWorkflowEcom<{ readonly workflow: WorkflowEcomWorkflow }>({
    token,
    path: "/api/workflow/ecom/adopt-master",
    method: "POST",
    fallback: "选用主图作为母版失败",
    body: payload,
  });
  return data.workflow;
}
