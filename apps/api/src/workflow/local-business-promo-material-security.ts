import { loadS3Config, type S3Config } from "../storage/s3.js";
import type {
  LocalBusinessPromoMaterial,
  LocalBusinessPromoMaterials,
  LocalBusinessPromoShotPlanEntry,
} from "./local-business-promo-core.js";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function encodeObjectKey(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function publicObjectUrl(cfg: S3Config, key: string, env: NodeJS.ProcessEnv = process.env) {
  const configuredBase = (env.VIDEO_S3_PUBLIC_BASE_URL ?? env.S3_PUBLIC_BASE_URL ?? "").trim();
  const encodedKey = encodeObjectKey(key);
  if (configuredBase) return `${trimTrailingSlash(configuredBase)}/${encodedKey}`;
  const endpoint = new URL(cfg.endpoint);
  if (cfg.forcePathStyle) return `${trimTrailingSlash(cfg.endpoint)}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
  return `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}/${encodedKey}`;
}

function isDataUri(url: string) {
  return /^data:/i.test(url);
}

function resolveUploadedMaterialUrl(objectKey: string, fallbackUrl: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    return publicObjectUrl(loadS3Config(env), objectKey, env);
  } catch {
    return fallbackUrl;
  }
}

function matchedSelectedMaterial(
  shot: LocalBusinessPromoShotPlanEntry,
  materials: readonly LocalBusinessPromoMaterial[],
) {
  if (shot.selectedMaterialUrl && shot.selectedMaterialMime) {
    const directMatch = materials.find((material) =>
      material.url === shot.selectedMaterialUrl
      && material.mime === shot.selectedMaterialMime);
    if (directMatch) return directMatch;
  }
  if (shot.selectedMaterialName && shot.selectedMaterialMime) {
    const namedMatch = materials.find((material) =>
      material.name === shot.selectedMaterialName
      && material.mime === shot.selectedMaterialMime);
    if (namedMatch) return namedMatch;
  }
  return null;
}

export function localBusinessPromoMaterialKeyPrefix(userId: string) {
  return `workflow/video-materials/${userId}/`;
}

export function isAllowedLocalBusinessPromoMaterialKey(userId: string, objectKey: string) {
  return objectKey.startsWith(localBusinessPromoMaterialKeyPrefix(userId));
}

export function sanitizeLocalBusinessPromoMaterial(
  userId: string,
  material: LocalBusinessPromoMaterial,
): LocalBusinessPromoMaterial {
  const objectKey = material.objectKey?.trim() || null;
  if (objectKey) {
    if (!isAllowedLocalBusinessPromoMaterialKey(userId, objectKey)) {
      throw new Error("素材不存在或已失效，请重新上传后再试");
    }
    return {
      ...material,
      objectKey,
      url: resolveUploadedMaterialUrl(objectKey, material.url),
    };
  }
  if (isDataUri(material.url)) {
    return {
      ...material,
      objectKey: null,
    };
  }
  throw new Error("仅支持使用当前账号上传的图片或视频素材，请重新上传后再试");
}

export function sanitizeLocalBusinessPromoMaterials(
  userId: string,
  materials: LocalBusinessPromoMaterials,
): LocalBusinessPromoMaterials {
  return {
    opening: materials.opening.map((material) => sanitizeLocalBusinessPromoMaterial(userId, material)),
    process: materials.process.map((material) => sanitizeLocalBusinessPromoMaterial(userId, material)),
    environment: materials.environment.map((material) => sanitizeLocalBusinessPromoMaterial(userId, material)),
    result: materials.result.map((material) => sanitizeLocalBusinessPromoMaterial(userId, material)),
  };
}

export function sanitizeLocalBusinessPromoShotPlan(
  userId: string,
  shotPlan: readonly LocalBusinessPromoShotPlanEntry[],
): LocalBusinessPromoShotPlanEntry[] {
  return shotPlan.map((shot) => {
    const materials = shot.materials.map((material) => sanitizeLocalBusinessPromoMaterial(userId, material));
    const hasSelectedMaterial = Boolean(
      shot.selectedMaterialUrl
      || shot.selectedMaterialName
      || shot.selectedMaterialMime
      || shot.renderMode,
    );
    if (!hasSelectedMaterial) {
      return {
        ...shot,
        materials,
      };
    }
    const selectedMaterial = matchedSelectedMaterial(shot, materials);
    if (!selectedMaterial) {
      return {
        ...shot,
        materials,
        selectedMaterialUrl: null,
        selectedMaterialName: null,
        selectedMaterialMime: null,
        sourceStartSec: null,
        sourceEndSec: null,
        renderMode: null,
      };
    }
    return {
      ...shot,
      materials,
      selectedMaterialUrl: selectedMaterial.url,
      selectedMaterialName: selectedMaterial.name,
      selectedMaterialMime: selectedMaterial.mime,
    };
  });
}
