import type { ObjectCannedACL, S3Client } from "@aws-sdk/client-s3";

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
  /**
   * Environment folder inside the bucket (`dev`, `prod`, ...), or "" for none.
   *
   * This is deliberately NOT part of the logical object key: callers keep passing
   * relative keys (`workflow/images/...`, `kb/...`) and every physical read/write
   * prepends this prefix in one place (`storage/s3-key.ts`). That keeps the
   * namespace validators (`isVerifiedWorkflowImageObjectKey*`) and every
   * persisted `objectKey` column environment-agnostic.
   */
  readonly keyPrefix: string;
}

export interface S3 {
  readonly client: S3Client;
  readonly bucket: string;
  /** Same value as `S3Config.keyPrefix`; kept here so every call site can resolve keys. */
  readonly keyPrefix: string;
}

export interface PutObjectOptions {
  readonly acl?: ObjectCannedACL;
}

export interface GetObjectToFileOptions {
  readonly maxBytes?: number;
}

export interface DownloadedObject {
  readonly bytes: number;
  readonly contentType: string | undefined;
}
