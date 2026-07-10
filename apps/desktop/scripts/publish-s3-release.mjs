import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const ARTIFACT_EXTENSIONS = new Set([".exe", ".blockmap"]);

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function normalizePrefix(value) {
  return value.replace(/^\/+|\/+$/g, "");
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".exe") {
    return "application/vnd.microsoft.portable-executable";
  }
  if (ext === ".yml") {
    return "application/x-yaml";
  }
  if (ext === ".blockmap") {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

async function listArtifacts(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const info = await stat(fullPath);
    const ext = path.extname(entry).toLowerCase();
    const isReleaseArtifact = ARTIFACT_EXTENSIONS.has(ext) || entry === "latest.yml";
    if (info.isFile() && isReleaseArtifact) {
      files.push({ fullPath, name: entry, size: info.size });
    }
  }
  return files.sort((left, right) => {
    if (left.name === "latest.yml") {
      return 1;
    }
    if (right.name === "latest.yml") {
      return -1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function main() {
  const bucket = requireEnv("DESKTOP_RELEASE_S3_BUCKET");
  const endpoint = requireEnv("DESKTOP_RELEASE_S3_ENDPOINT");
  const accessKeyId = requireEnv("DESKTOP_RELEASE_S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("DESKTOP_RELEASE_S3_SECRET_ACCESS_KEY");
  const region = process.env.DESKTOP_RELEASE_S3_REGION?.trim() || "us-east-1";
  const prefix = normalizePrefix(process.env.DESKTOP_RELEASE_S3_PREFIX?.trim() || "desktop/win");
  const artifactsDir = path.resolve(process.env.YC_DESKTOP_DIST_DIR?.trim() || "dist");
  const publicRead = process.env.DESKTOP_RELEASE_S3_PUBLIC_READ === "1";

  const artifacts = await listArtifacts(artifactsDir);
  if (artifacts.length === 0) {
    throw new Error(`No desktop release artifacts found in ${artifactsDir}`);
  }

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: process.env.DESKTOP_RELEASE_S3_FORCE_PATH_STYLE !== "0",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  for (const artifact of artifacts) {
    const key = prefix ? `${prefix}/${artifact.name}` : artifact.name;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: await readFile(artifact.fullPath),
      ContentLength: artifact.size,
      ContentType: contentTypeFor(artifact.fullPath),
      ACL: publicRead ? "public-read" : undefined,
    }));
    process.stdout.write(`uploaded ${key} (${artifact.size} bytes)\n`);
  }
}

function formatError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  if (error.name && error.name !== "Error" && error.name !== error.message) {
    parts.push(`name=${error.name}`);
  }
  if ("$metadata" in error && error.$metadata) {
    const metadata = error.$metadata;
    const detail = [
      metadata.httpStatusCode ? `status=${metadata.httpStatusCode}` : undefined,
      metadata.requestId ? `requestId=${metadata.requestId}` : undefined,
      metadata.extendedRequestId ? `extendedRequestId=${metadata.extendedRequestId}` : undefined,
    ].filter(Boolean).join(" ");
    if (detail) {
      parts.push(detail);
    }
  }
  return parts.join("\n");
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
});
