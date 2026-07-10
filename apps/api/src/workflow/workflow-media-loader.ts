import { Buffer } from "node:buffer";
import { getObject, loadS3Config, makeS3 } from "../storage/s3.js";

export interface WorkflowMediaSource {
  readonly url: string;
  readonly mime: string;
  readonly objectKey?: string | null;
}

function parseDataUri(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { mime: match[1], data: match[2] } : null;
}

export async function loadWorkflowMediaBuffer(args: {
  readonly source: WorkflowMediaSource;
  readonly fetchFn?: typeof fetch;
  readonly fetchOptions?: RequestInit;
  readonly fetchErrorMessage?: (status: number) => string;
  readonly allowUrlFallback?: boolean;
}): Promise<{ mime: string; buffer: Buffer }> {
  const parsed = parseDataUri(args.source.url);
  if (parsed) {
    return {
      mime: parsed.mime,
      buffer: Buffer.from(parsed.data, "base64"),
    };
  }

  let buffer: Buffer | null = null;
  if (args.source.objectKey) {
    try {
      buffer = await getObject(makeS3(loadS3Config()), args.source.objectKey);
    } catch {
      buffer = null;
    }
  }

  if (!buffer) {
    if (args.allowUrlFallback === false) {
      throw new Error(args.fetchErrorMessage?.(403) ?? "拉取素材失败");
    }
    const fetchFn = args.fetchFn ?? fetch;
    const response = args.fetchOptions
      ? await fetchFn(args.source.url, args.fetchOptions)
      : await fetchFn(args.source.url);
    if (!response.ok) {
      throw new Error(args.fetchErrorMessage?.(response.status) ?? `拉取素材失败 ${response.status}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
  }

  return {
    mime: args.source.mime,
    buffer,
  };
}
