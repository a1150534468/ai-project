import type { ObjectCannedACL, S3Client } from "@aws-sdk/client-s3";

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly forcePathStyle: boolean;
}

export interface S3 {
  readonly client: S3Client;
  readonly bucket: string;
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
