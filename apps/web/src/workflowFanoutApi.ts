import { ApiError, readErrorMessage } from "./apiError";

export type FanoutMode = "enum" | "matrix" | "script";
export type FanoutDimensionId = "platform" | "sellingPoint" | "audience" | "style" | "emotion" | "seo";
export type FanoutCount = number;

export interface FanoutBrief {
  readonly product: string;
  readonly audience: string;
  readonly sellingPoints: readonly string[];
  readonly style: string;
  readonly scene: string;
}
export interface FanoutVariant {
  readonly id: string;
  readonly text: string;
  readonly label: string;
  readonly charCount: number;
  readonly similarity: number;
  readonly highSimilarity: boolean;
}
export interface FanoutGenerateResult {
  readonly variants: readonly FanoutVariant[];
  readonly requested: number;
  readonly delivered: number;
  readonly avgSimilarity: number;
  readonly partialFailure: boolean;
  readonly stoppedByBalance: boolean;
}

async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new ApiError(await readErrorMessage(resp, "请求失败"), resp.status);
  const json = (await resp.json()) as { data: T };
  return json.data;
}

export function extractBrief(token: string, raw: string): Promise<{ brief: FanoutBrief }> {
  return postJson("/api/workflow/fanout/extract", token, { raw });
}

export interface GenerateArgs {
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly count: FanoutCount;
  readonly dimension?: FanoutDimensionId;
  readonly dedup?: boolean;
}
export function generateFanout(token: string, args: GenerateArgs): Promise<FanoutGenerateResult> {
  return postJson("/api/workflow/fanout/generate", token, args);
}
