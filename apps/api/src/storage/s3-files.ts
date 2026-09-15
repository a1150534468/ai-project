import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DownloadedObject, GetObjectToFileOptions, PutObjectOptions, S3 } from "./s3-types.js";

export async function putObjectFile(
  s3: S3,
  key: string,
  filePath: string,
  contentType: string,
  options: PutObjectOptions = {},
): Promise<void> {
  const { size } = await stat(filePath);
  const body = createReadStream(filePath);
  try {
    await s3.client.send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: body,
      ContentLength: size,
      ContentType: contentType,
      ...(options.acl ? { ACL: options.acl } : {}),
    }));
  } finally {
    body.destroy();
  }
}

function byteLimiter(key: string, maxBytes: number | undefined, onBytes: (bytes: number) => void) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      onBytes(total);
      if (maxBytes !== undefined && total > maxBytes) {
        callback(new Error(`S3 object ${key} exceeds ${maxBytes} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });
}

async function discardBody(body: unknown): Promise<void> {
  if (!body || typeof body !== "object") return;
  if ("destroy" in body && typeof body.destroy === "function") {
    body.destroy();
    return;
  }
  if ("cancel" in body && typeof body.cancel === "function") await body.cancel();
}

export async function getObjectToFile(
  s3: S3,
  key: string,
  filePath: string,
  options: GetObjectToFileOptions = {},
): Promise<DownloadedObject> {
  const { maxBytes } = options;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }

  const response = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
  if (!response.Body) throw new Error(`S3 object ${key} returned an empty body`);
  if (maxBytes !== undefined && response.ContentLength !== undefined && response.ContentLength > maxBytes) {
    await discardBody(response.Body).catch(() => undefined);
    throw new Error(`S3 object ${key} exceeds ${maxBytes} bytes`);
  }

  let receivedBytes = 0;
  let destinationCreated = false;
  const limiter = byteLimiter(key, maxBytes, (bytes) => {
    receivedBytes = bytes;
  });
  try {
    const destination = await open(filePath, "wx");
    destinationCreated = true;
    const source = Readable.from(response.Body as AsyncIterable<Uint8Array>);
    await pipeline(source, limiter, destination.createWriteStream());
    if (response.ContentLength !== undefined && receivedBytes !== response.ContentLength) {
      throw new Error(
        `S3 object ${key} length mismatch: expected ${response.ContentLength}, received ${receivedBytes}`,
      );
    }
    return { bytes: receivedBytes, contentType: response.ContentType };
  } catch (error) {
    await discardBody(response.Body).catch(() => undefined);
    if (destinationCreated) await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
