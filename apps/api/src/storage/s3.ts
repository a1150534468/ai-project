import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function loadS3Config(env: NodeJS.ProcessEnv = process.env): S3Config {
  const c = {
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION ?? "us-east-1",
    bucket: env.S3_BUCKET ?? "",
    accessKey: env.S3_ACCESS_KEY ?? "",
    secretKey: env.S3_SECRET_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  };
  if (!c.endpoint) throw new Error("S3_ENDPOINT required");
  if (!c.bucket) throw new Error("S3_BUCKET required");
  if (!c.accessKey) throw new Error("S3_ACCESS_KEY required");
  if (!c.secretKey) throw new Error("S3_SECRET_KEY required");
  return c;
}

export function makeS3(cfg: S3Config = loadS3Config()) {
  return {
    client: new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKey,
        secretAccessKey: cfg.secretKey,
      },
      // COS accepts ordinary Content-Length streams. Avoid checksum trailers
      // that some S3-compatible providers interpret as aws-chunked payloads.
      requestChecksumCalculation: "WHEN_REQUIRED",
    }),
    bucket: cfg.bucket,
  };
}

export type S3 = ReturnType<typeof makeS3>;

export interface PutObjectOptions {
  readonly acl?: ObjectCannedACL;
}

export async function putObject(
  s3: S3,
  key: string,
  body: Buffer,
  mime: string,
  options: PutObjectOptions = {},
): Promise<void> {
  await s3.client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: body,
      ContentType: mime,
      ...(options.acl ? { ACL: options.acl } : {}),
    }),
  );
}

export async function putObjectFile(
  s3: S3,
  key: string,
  filePath: string,
  mime: string,
  options: PutObjectOptions = {},
): Promise<void> {
  const file = await stat(filePath);
  const body = createReadStream(filePath);
  try {
    await s3.client.send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: body,
        ContentLength: file.size,
        ContentType: mime,
        ...(options.acl ? { ACL: options.acl } : {}),
      }),
    );
  } finally {
    body.destroy();
  }
}

export async function getObject(s3: S3, key: string): Promise<Buffer> {
  const r = await s3.client.send(
    new GetObjectCommand({
      Bucket: s3.bucket,
      Key: key,
    }),
  );
  const arr = await r.Body!.transformToByteArray();
  return Buffer.from(arr);
}

export interface GetObjectToFileOptions {
  readonly maxBytes?: number;
}

export async function getObjectToFile(
  s3: S3,
  key: string,
  filePath: string,
  options: GetObjectToFileOptions = {},
): Promise<{ readonly bytes: number; readonly contentType: string | undefined }> {
  const response = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
  if (!response.Body) throw new Error(`S3 object ${key} returned an empty body`);
  const maxBytes = options.maxBytes;
  const expectedBytes = typeof response.ContentLength === "number" ? response.ContentLength : undefined;
  if (maxBytes && response.ContentLength && response.ContentLength > maxBytes) {
    throw new Error(`S3 object ${key} exceeds ${maxBytes} bytes`);
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (maxBytes && bytes > maxBytes) {
        callback(new Error(`S3 object ${key} exceeds ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    const source = Readable.from(response.Body as AsyncIterable<Uint8Array>);
    await pipeline(source, limiter, createWriteStream(filePath, { flags: "wx" }));
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      throw new Error(`S3 object ${key} length mismatch: expected ${expectedBytes}, received ${bytes}`);
    }
    return { bytes, contentType: response.ContentType };
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteObject(s3: S3, key: string): Promise<void> {
  await s3.client.send(
    new DeleteObjectCommand({
      Bucket: s3.bucket,
      Key: key,
    }),
  );
}

export async function deletePrefix(s3: S3, prefix: string): Promise<void> {
  const list = await s3.client.send(
    new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: prefix,
    }),
  );
  for (const o of list.Contents ?? []) {
    if (o.Key) await deleteObject(s3, o.Key);
  }
}
