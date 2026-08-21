import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { PROJECT_AUDIO_BLOB_URL_TTL_MS } from "./local-business-promo-route-types.js";

function audioBlobSigningSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET 必须 ≥32 字节");
  return secret;
}

function projectAudioBlobSignaturePayload(projectId: string, objectKey: string, mime: string, exp: number) {
  return `${projectId}\n${objectKey}\n${mime}\n${exp}`;
}

function signProjectAudioBlobAccess(projectId: string, objectKey: string, mime: string) {
  const exp = Date.now() + PROJECT_AUDIO_BLOB_URL_TTL_MS;
  const sig = createHmac("sha256", audioBlobSigningSecret())
    .update(projectAudioBlobSignaturePayload(projectId, objectKey, mime, exp))
    .digest("base64url");
  return { exp, sig };
}

export function hasValidProjectAudioBlobAccess(args: {
  readonly projectId: string;
  readonly objectKey: string;
  readonly mime: string;
  readonly exp: number;
  readonly sig: string;
}) {
  if (args.exp < Date.now()) return false;
  const expected = createHmac("sha256", audioBlobSigningSecret())
    .update(projectAudioBlobSignaturePayload(args.projectId, args.objectKey, args.mime, args.exp))
    .digest("base64url");
  const actualBuffer = Buffer.from(args.sig);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function projectAudioBlobUrl(projectId: string, objectKey: string, mime: string) {
  const { exp, sig } = signProjectAudioBlobAccess(projectId, objectKey, mime);
  const params = new URLSearchParams({
    key: objectKey,
    mime,
    exp: String(exp),
    sig,
  });
  return `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/audio/blob?${params.toString()}`;
}

export function projectVideoBlobUrl(projectId: string, objectKey: string, mime: string) {
  const { exp, sig } = signProjectAudioBlobAccess(projectId, objectKey, mime);
  const params = new URLSearchParams({
    key: objectKey,
    mime,
    exp: String(exp),
    sig,
  });
  return `/api/workflow/local-business-promos/projects/${encodeURIComponent(projectId)}/video/blob?${params.toString()}`;
}

export function audioBlobMimeFromQuery(key: string, mime?: string) {
  if (mime?.startsWith("audio/")) return mime;
  if (key.toLowerCase().endsWith(".mp3")) return "audio/mpeg";
  if (key.toLowerCase().endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

export function videoBlobMimeFromQuery(key: string, mime?: string) {
  if (mime?.startsWith("video/")) return mime;
  if (key.toLowerCase().endsWith(".mov")) return "video/quicktime";
  if (key.toLowerCase().endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

function projectAudioKeyPrefix(userId: string, projectId: string) {
  return `workflow/audio/${userId}/${projectId}/`;
}

function presetNarrationPreviewKeyPrefix(userId: string) {
  return `workflow/audio/${userId}/preset-narration-preview/`;
}

export function isAllowedProjectAudioKey(userId: string, projectId: string, objectKey: string) {
  return objectKey.startsWith(projectAudioKeyPrefix(userId, projectId))
    || objectKey.startsWith(presetNarrationPreviewKeyPrefix(userId));
}

function projectVideoKeyPrefix(userId: string, projectId: string) {
  return `workflow/local-business-promo/${userId}/${projectId}/`;
}

export function isAllowedProjectVideoKey(userId: string, projectId: string, objectKey: string) {
  return objectKey.startsWith(projectVideoKeyPrefix(userId, projectId));
}
