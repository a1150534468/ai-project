import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SeedanceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface SubmitSeedanceVideoTaskInput {
  readonly config: SeedanceConfig;
  readonly fetchFn: FetchLike;
  readonly imageUrl: string;
  readonly prompt: string;
  readonly durationSec: number;
  readonly resolution: string;
}

export interface PollSeedanceVideoTaskInput {
  readonly config: SeedanceConfig;
  readonly fetchFn: FetchLike;
  readonly taskId: string;
}

export interface SeedanceTaskResult {
  readonly taskId: string;
  readonly status: "queued" | "processing" | "succeeded" | "failed";
  readonly videoUrl?: string;
  readonly error?: string;
}

const submitResponseSchema = z.object({
  id: z.string().optional(),
  taskId: z.string().optional(),
  status: z.string().default("queued"),
});

const pollResponseSchema = z.object({
  id: z.string().optional(),
  taskId: z.string().optional(),
  status: z.string(),
  videoUrl: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
});

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeStatus(status: string): SeedanceTaskResult["status"] {
  const normalized = status.trim().toLowerCase();
  if (normalized === "succeeded" || normalized === "success" || normalized === "completed") return "succeeded";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "processing" || normalized === "running") return "processing";
  return "queued";
}

function taskIdFrom(id: string | undefined, taskId: string | undefined): string {
  const value = taskId?.trim() || id?.trim();
  if (!value) throw new Error("video task response missing id");
  return value;
}

export function loadSeedanceConfig(env: NodeJS.ProcessEnv = process.env): SeedanceConfig {
  const apiKey = env.SEEDANCE_API_KEY?.trim();
  if (!apiKey) throw new Error("SEEDANCE_API_KEY required");
  return {
    apiKey,
    baseUrl: trimTrailingSlash(env.SEEDANCE_BASE_URL?.trim() || "https://api.seedance.example/v1"),
    model: env.SEEDANCE_DEFAULT_MODEL?.trim() || "seedance-lite",
  };
}

export async function submitSeedanceVideoTask(input: SubmitSeedanceVideoTaskInput): Promise<SeedanceTaskResult> {
  const response = await input.fetchFn(`${trimTrailingSlash(input.config.baseUrl)}/videos`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.config.model,
      imageUrl: input.imageUrl,
      prompt: input.prompt,
      durationSec: input.durationSec,
      resolution: input.resolution,
    }),
  });
  if (!response.ok) throw new Error(`seedance submit ${response.status}`);
  const parsed = submitResponseSchema.parse(await response.json());
  return {
    taskId: taskIdFrom(parsed.id, parsed.taskId),
    status: normalizeStatus(parsed.status),
  };
}

export async function pollSeedanceVideoTask(input: PollSeedanceVideoTaskInput): Promise<SeedanceTaskResult> {
  const response = await input.fetchFn(`${trimTrailingSlash(input.config.baseUrl)}/videos/${encodeURIComponent(input.taskId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${input.config.apiKey}` },
  });
  if (!response.ok) throw new Error(`seedance poll ${response.status}`);
  const parsed = pollResponseSchema.parse(await response.json());
  const videoUrl = parsed.videoUrl ?? parsed.url;
  return {
    taskId: taskIdFrom(parsed.id, parsed.taskId),
    status: normalizeStatus(parsed.status),
    ...(videoUrl ? { videoUrl } : {}),
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}
