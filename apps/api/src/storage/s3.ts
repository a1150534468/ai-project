import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";

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
  // 必须一次性读入 buffer 上传：流式 body 会触发 AWS SDK v3 的 aws-chunked/checksum-trailer 签名，
  // 天翼云 OOS 等 S3 兼容存储不支持，返回 403 且被 SDK 吞成无信息的 "UnknownError"。
  // 上层已按 VIDEO_MATERIAL_MAX_BYTES 限制文件大小，buffer 内存可控。
  const body = await readFile(filePath);
  await s3.client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: mime,
      ...(options.acl ? { ACL: options.acl } : {}),
    }),
  );
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
