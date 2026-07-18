import JSZip from "jszip";
import sharp, { type Metadata } from "sharp";
import { PET_ATLAS_HEIGHT, PET_ATLAS_WIDTH, PET_SPRITE_VERSION } from "./constants.js";

export interface CodexPetManifest {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly spriteVersionNumber: 2;
  readonly spritesheetPath: "spritesheet.webp";
}

export interface CodexPetPackageResult {
  readonly petId: string;
  readonly manifest: CodexPetManifest;
  readonly manifestBytes: Buffer;
  readonly spritesheet: Buffer;
  readonly zip: Buffer;
}

/**
 * Validate the raster part of the v2 contract at the package boundary.
 *
 * `metadata.hasAlpha` only tells us that an alpha channel is present; it does
 * not tell us that any pixels are actually transparent.  A package with an
 * all-opaque atlas would render the unused cells as filled sprites in Codex,
 * so require at least one genuinely transparent pixel as well.  The runner
 * performs the more expensive per-cell/semantic checks before calling this
 * helper; this function deliberately stays focused on the immutable file
 * contract and can therefore also be used by ZIP inspection.
 */
async function assertTransparentV2Spritesheet(input: Buffer, context: string): Promise<Metadata> {
  const metadata = await sharp(input, { limitInputPixels: 64_000_000 }).metadata();
  if (metadata.width !== PET_ATLAS_WIDTH || metadata.height !== PET_ATLAS_HEIGHT || !metadata.hasAlpha) {
    throw new Error(`${context} must be a transparent ${PET_ATLAS_WIDTH}x${PET_ATLAS_HEIGHT} image`);
  }

  // Decode alpha only.  This avoids retaining the full RGBA raster while
  // still distinguishing a real transparent atlas from an opaque image that
  // merely happens to be encoded with four channels.
  const { data, info } = await sharp(input, { limitInputPixels: 64_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  for (let index = 0; index < info.width * info.height; index += 1) {
    // Codex's unused cells and the outside of each sprite are fully
    // transparent.  Merely finding a semi-transparent pixel is not enough:
    // an atlas with alpha=1 everywhere still paints a faint rectangle in
    // clients that premultiply or quantise alpha.
    if (data[index * info.channels + 3]! === 0) {
      transparentPixels += 1;
      break;
    }
  }
  if (transparentPixels === 0) throw new Error(`${context} must contain transparent pixels`);
  return metadata;
}

export function normalizePetId(value: string): string {
  const normalized = value.trim().toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "codex-pet";
}

export function createPetManifest(input: { id: string; displayName: string; description?: string }): CodexPetManifest {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("Pet displayName is required");
  return {
    id: normalizePetId(input.id),
    displayName,
    description: input.description?.trim() ?? "",
    spriteVersionNumber: PET_SPRITE_VERSION,
    spritesheetPath: "spritesheet.webp",
  };
}

export async function createCodexPetPackage(input: {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly spritesheet: Buffer;
}): Promise<CodexPetPackageResult> {
  await assertTransparentV2Spritesheet(input.spritesheet, "Spritesheet");
  const manifest = createPetManifest(input);
  const spritesheet = await sharp(input.spritesheet).webp({ lossless: true, effort: 6 }).toBuffer();
  // Conversion must preserve the alpha contract.  This also guards against a
  // future encoder option accidentally flattening transparency.
  await assertTransparentV2Spritesheet(spritesheet, "Packaged spritesheet");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const zip = new JSZip();
  const root = zip.folder(manifest.id)!;
  root.file("pet.json", manifestBytes);
  root.file("spritesheet.webp", spritesheet);
  return {
    petId: manifest.id,
    manifest,
    manifestBytes,
    spritesheet,
    zip: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
  };
}

export function buildCodexInstallDeepLink(input: {
  readonly name: string;
  readonly imageUrl: string;
  readonly description?: string;
}): string {
  const imageUrl = new URL(input.imageUrl);
  if (imageUrl.protocol !== "https:") throw new Error("Codex pet installation imageUrl must use HTTPS");
  const params = new URLSearchParams({
    name: input.name,
    imageUrl: imageUrl.toString(),
    description: input.description ?? "",
    spriteVersionNumber: String(PET_SPRITE_VERSION),
  });
  return `codex://pets/install?${params.toString()}`;
}

export async function inspectCodexPetZip(input: Buffer): Promise<{ manifest: CodexPetManifest; spritesheetBytes: number }> {
  const zip = await JSZip.loadAsync(input);
  const entries = Object.values(zip.files);
  const fileEntries = entries.filter((entry) => !entry.dir);
  // Packages generated by createCodexPetPackage contain exactly one
  // directory and the two files below.  Rejecting extra files prevents a
  // caller from accidentally shipping private diagnostics and makes the
  // validator useful for ZIPs received from an untrusted download.
  for (const entry of entries) {
    if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").some((part) => part === "..")) {
      throw new Error("Package contains an unsafe path");
    }
  }
  const manifestEntries = fileEntries.filter((entry) => /(^|\/)pet\.json$/.test(entry.name));
  if (manifestEntries.length !== 1) throw new Error("Package must contain exactly one pet.json");
  const manifestEntry = manifestEntries[0]!;
  const rawManifest = JSON.parse(await manifestEntry.async("string")) as Partial<CodexPetManifest>;
  if (rawManifest.spriteVersionNumber !== 2 || rawManifest.spritesheetPath !== "spritesheet.webp") {
    throw new Error("Package does not use the Codex pet v2 contract");
  }
  if (typeof rawManifest.id !== "string" || typeof rawManifest.displayName !== "string" || typeof rawManifest.description !== "string") {
    throw new Error("Package pet.json is incomplete");
  }
  const normalizedId = normalizePetId(rawManifest.id);
  if (normalizedId !== rawManifest.id || !rawManifest.displayName.trim()) {
    throw new Error("Package pet.json has an invalid id or displayName");
  }
  const prefix = manifestEntry.name.slice(0, -"pet.json".length);
  if (prefix !== `${rawManifest.id}/`) throw new Error("Package files must live under the pet id directory");
  const spritesheetEntries = fileEntries.filter((entry) => entry.name === `${prefix}spritesheet.webp`);
  if (spritesheetEntries.length !== 1 || fileEntries.length !== 2) throw new Error("Package must contain exactly pet.json and spritesheet.webp");
  const spritesheetEntry = spritesheetEntries[0]!;
  const spritesheet = await spritesheetEntry.async("nodebuffer");
  const metadata = await assertTransparentV2Spritesheet(spritesheet, "Packaged spritesheet");
  if (metadata.format !== "webp") throw new Error("Packaged spritesheet must be WebP");
  return { manifest: rawManifest as CodexPetManifest, spritesheetBytes: spritesheet.byteLength };
}
