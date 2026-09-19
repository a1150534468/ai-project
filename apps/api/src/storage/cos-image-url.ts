import COS from "cos-nodejs-sdk-v5";
import { createCdnImageUrlSigner } from "./cdn-image-url.js";
import { validateSignedImageRequest } from "./image-url-validation.js";
import { loadS3Config } from "./s3-config.js";

export interface SignedImageRequest {
  readonly objectKey: string;
  readonly mime: string;
  /** Existing application bearer URL expiry, in milliseconds. */
  readonly expiresAt: number;
  readonly contentDisposition?: string;
}

export type ImageUrlSigner = (request: SignedImageRequest) => Promise<string | null>;

/** Signing is local only; no object read or cloud configuration change. */
export function createImageUrlSigner(env: NodeJS.ProcessEnv = process.env): ImageUrlSigner {
  const mode = env.WORKFLOW_IMAGE_DELIVERY?.trim() || "proxy";
  if (mode === "proxy") return async () => null;
  if (mode === "cdn") return createCdnImageUrlSigner(env);
  if (mode !== "cos") throw new Error("WORKFLOW_IMAGE_DELIVERY must be proxy, cos or cdn");

  const config = loadS3Config(env);
  const endpoint = new URL(config.endpoint);
  const serviceHost = `cos.${config.region}.myqcloud.com`;
  const objectHost = `${config.bucket}.${serviceHost}`;
  if (
    !/^[a-z][a-z0-9-]*-\d+$/.test(config.bucket) ||
    !/^[a-z]+-[a-z]+(?:-[a-z]+)*-?\d*$/.test(config.region) ||
    endpoint.protocol !== "https:" ||
    ![serviceHost, objectHost].includes(endpoint.hostname) ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("COS image delivery requires a standard HTTPS COS endpoint matching S3_BUCKET and S3_REGION");
  }

  const cos = new COS({
    SecretId: config.accessKey,
    SecretKey: config.secretKey,
    Protocol: "https:",
    ForceSignHost: true,
  });

  return async ({ objectKey, mime, expiresAt, contentDisposition }) => {
    validateSignedImageRequest({ objectKey, mime, contentDisposition, expiresAt });
    const expires = Math.min(300, Math.floor((expiresAt - Date.now()) / 1000));
    // COS SDK backdates its signing window slightly; don't issue a grant that is already expiring.
    if (!Number.isFinite(expiresAt) || expires < 2) throw new Error("Image URL has expired");

    return await new Promise<string>((resolve, reject) => {
      cos.getObjectUrl(
        {
          Bucket: config.bucket,
          Region: config.region,
          Key: objectKey,
          Method: "GET",
          Sign: true,
          Expires: expires,
          Protocol: "https:",
          UseAccelerate: false,
          Query: {
            "response-content-type": mime,
            "response-cache-control": "private, no-store",
            ...(contentDisposition ? { "response-content-disposition": contentDisposition } : {}),
          },
        },
        (error, result) => {
          if (error) reject(new Error("COS image URL signing failed"));
          else resolve(result.Url);
        },
      );
    });
  };
}
