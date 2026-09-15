import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { PutObjectOptions, S3 } from "./s3-types.js";

export async function putObject(
  s3: S3,
  key: string,
  body: Buffer,
  contentType: string,
  options: PutObjectOptions = {},
): Promise<void> {
  await s3.client.send(new PutObjectCommand({
    Bucket: s3.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ...(options.acl ? { ACL: options.acl } : {}),
  }));
}

export async function getObject(s3: S3, key: string): Promise<Buffer> {
  const response = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
  if (!response.Body) throw new Error(`S3 object ${key} returned an empty body`);
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteObject(s3: S3, key: string): Promise<void> {
  await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
}

export async function deletePrefix(s3: S3, prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await s3.client.send(new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key) await deleteObject(s3, object.Key);
    }
    if (!page.IsTruncated) return;
    const nextToken = page.NextContinuationToken;
    if (!nextToken || nextToken === continuationToken) {
      throw new Error(`S3 listing for ${prefix} was truncated without a new continuation token`);
    }
    continuationToken = nextToken;
  } while (continuationToken);
}
