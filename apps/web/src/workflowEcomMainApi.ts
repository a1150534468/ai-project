import { requestWorkflowEcom } from "./workflowEcomApi";

export type EcomMainRatio = "1:1" | "3:4" | "4:5" | "16:9" | "9:16";
export type EcomMainResolution = "1K" | "2K" | "4K";
export type EcomMainStyleId = "amazon_clean" | "real_life" | "premium_studio" | "infographic" | "short_video" | "custom";
export type EcomMainStage = "draft" | "running" | "partial" | "ready" | "failed";

export type EcomMainImageRecord = {
  readonly index: number;
  readonly assetId: string | null;
  readonly theme: string;
  readonly sceneRequirement: string;
  readonly copyRequirement: string;
  readonly originalUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly status: "pending" | "ready" | "failed";
};

export type EcomMainJob = {
  readonly id: string;
  readonly platform: string;
  readonly language: string;
  readonly ratio: EcomMainRatio;
  readonly resolution: EcomMainResolution;
  readonly style: EcomMainStyleId;
  readonly customStyle: string;
  readonly withText: boolean;
  readonly count: number;
  readonly stage: EcomMainStage;
  readonly error: string | null;
  readonly createdAt: string;
  readonly images: readonly EcomMainImageRecord[];
};

export type EcomMainPriceRow = {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly rate: number;
};

export type EcomMainPricing = Record<EcomMainResolution, EcomMainPriceRow>;

export type CreateEcomMainPayload = {
  readonly platformId: string;
  readonly ratio: EcomMainRatio;
  readonly resolution: EcomMainResolution;
  readonly style: EcomMainStyleId;
  readonly customStyle: string;
  readonly withText: boolean;
  readonly count: number;
  readonly product: { readonly name: string; readonly category: string; readonly sellingPoints: readonly string[]; readonly extra: string };
  readonly referenceAssetIds: readonly string[];
};

export function getEcomMainPricing(token: string): Promise<EcomMainPricing> {
  return requestWorkflowEcom<EcomMainPricing>({ token, path: "/api/workflow/ecom/main/pricing", method: "GET", fallback: "获取电商主图计价失败" });
}

export function getCurrentEcomMainJob(token: string): Promise<{ readonly job: EcomMainJob | null }> {
  return requestWorkflowEcom<{ readonly job: EcomMainJob | null }>({ token, path: "/api/workflow/ecom/main/current", method: "GET", fallback: "获取当前主图任务失败" });
}

export function createEcomMainJob(token: string, payload: CreateEcomMainPayload): Promise<{ readonly job: EcomMainJob }> {
  return requestWorkflowEcom<{ readonly job: EcomMainJob }>({ token, path: "/api/workflow/ecom/main", method: "POST", fallback: "主图生成失败", body: payload });
}

export function redrawEcomMainImage(token: string, jobId: string, index: number): Promise<{ readonly job: EcomMainJob }> {
  return requestWorkflowEcom<{ readonly job: EcomMainJob }>({ token, path: `/api/workflow/ecom/main/${encodeURIComponent(jobId)}/images/${index}/redraw`, method: "POST", fallback: "主图重绘失败" });
}

export function listEcomMainHistory(token: string): Promise<{ readonly jobs: readonly EcomMainJob[] }> {
  return requestWorkflowEcom<{ readonly jobs: readonly EcomMainJob[] }>({ token, path: "/api/workflow/ecom/main/history", method: "GET", fallback: "获取主图历史失败" });
}

export type EcomHelpWriteField = "sellingPoints" | "extra";

export function helpWriteEcom(token: string, payload: {
  readonly field: EcomHelpWriteField;
  readonly productName: string;
  readonly category: string;
  readonly sellingPoints: readonly string[];
}): Promise<{ readonly text: string }> {
  return requestWorkflowEcom<{ readonly text: string }>({ token, path: "/api/workflow/ecom/help-write", method: "POST", fallback: "帮我写失败", body: payload });
}
