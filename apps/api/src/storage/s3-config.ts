import { S3Client } from "@aws-sdk/client-s3";
import type { S3, S3Config } from "./s3-types.js";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} required`);
  return value;
}

export function loadS3Config(env: NodeJS.ProcessEnv = process.env): S3Config {
  return {
    endpoint: required(env, "S3_ENDPOINT"),
    region: env.S3_REGION?.trim() || "us-east-1",
    bucket: required(env, "S3_BUCKET"),
    accessKey: required(env, "S3_ACCESS_KEY"),
    secretKey: required(env, "S3_SECRET_KEY"),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  };
}

export function makeS3(config: S3Config = loadS3Config()): S3 {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return { client, bucket: config.bucket };
}
