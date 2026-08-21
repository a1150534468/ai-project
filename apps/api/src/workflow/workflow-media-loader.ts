import { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getObject, getObjectToFile, loadS3Config, makeS3 } from "../storage/s3.js";
import { assertTempDiskSpace } from "../runtime/temp-storage.js";

export interface WorkflowMediaSource {
  readonly url: string;
  readonly mime: string;
  readonly objectKey?: string | null;
}

function configuredMediaMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.VIDEO_MATERIAL_MAX_BYTES ?? env.VIDEO_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : 350 * 1024 * 1024;
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

export async function loadWorkflowMediaFile(args: {
  readonly source: WorkflowMediaSource;
  readonly outputPath: string;
  readonly fetchFn?: typeof fetch;
  readonly fetchOptions?: RequestInit;
  readonly fetchErrorMessage?: (status: number) => string;
  readonly allowUrlFallback?: boolean;
  readonly maxBytes?: number;
}): Promise<{ readonly mime: string; readonly filePath: string; readonly bytes: number }> {
  const maxBytes = args.maxBytes ?? configuredMediaMaxBytes();
  await assertTempDiskSpace(args.outputPath);
  const parsed = parseDataUri(args.source.url);
  if (parsed) {
    const estimatedBytes = Math.floor((parsed.data.length * 3) / 4);
    if (estimatedBytes > maxBytes) throw new Error(`素材超过 ${maxBytes} 字节限制`);
    const data = Buffer.from(parsed.data, "base64");
    if (data.byteLength > maxBytes) throw new Error(`素材超过 ${maxBytes} 字节限制`);
    await writeFile(args.outputPath, data, { flag: "wx" });
    return { mime: parsed.mime, filePath: args.outputPath, bytes: data.byteLength };
  }

  if (args.source.objectKey) {
    try {
      const result = await getObjectToFile(makeS3(loadS3Config()), args.source.objectKey, args.outputPath, {
        maxBytes,
      });
      return {
        mime: result.contentType?.trim() || args.source.mime,
        filePath: args.outputPath,
        bytes: result.bytes,
      };
    } catch (error) {
      if (args.allowUrlFallback === false) {
        throw new Error(args.fetchErrorMessage?.(403) ?? "拉取素材失败", { cause: error });
      }
    }
  }

  const fetchFn = args.fetchFn ?? fetch;
  const response = args.fetchOptions
    ? await fetchFn(args.source.url, args.fetchOptions)
    : await fetchFn(args.source.url);
  if (!response.ok || !response.body) {
    throw new Error(args.fetchErrorMessage?.(response.status) ?? `拉取素材失败 ${response.status}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  const expectedBytes = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (expectedBytes !== undefined && Number.isFinite(expectedBytes) && expectedBytes > maxBytes) {
    throw new Error(`素材超过 ${maxBytes} 字节限制`);
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new Error(`素材超过 ${maxBytes} 字节限制`));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    const source = Readable.from(response.body as unknown as AsyncIterable<Uint8Array>);
    await pipeline(source, limiter, createWriteStream(args.outputPath, { flags: "wx" }));
    if (expectedBytes !== undefined && Number.isFinite(expectedBytes) && bytes !== expectedBytes) {
      throw new Error(`素材长度不匹配：预期 ${expectedBytes} 字节，实际 ${bytes} 字节`);
    }
  } catch (error) {
    await rm(args.outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    mime: response.headers.get("content-type")?.trim() || args.source.mime,
    filePath: args.outputPath,
    bytes,
  };
}
