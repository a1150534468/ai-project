import sharp from "sharp";
import { PET_ATLAS_WIDTH, PET_CELL_HEIGHT, PET_CELL_WIDTH } from "./constants.js";
import { formatHexColor, parseHexColor, removeChroma } from "./chroma.js";
import { inspectFrame, type FrameDiagnostics, type PixelBounds } from "./extraction.js";

export const NEUTRAL_DIRECTION_REGISTRATION_SCHEMA = "codex-pet-neutral-direction-registration-v1" as const;

export interface DirectionCellGeometry {
  readonly bounds: PixelBounds;
  readonly bodyHeight: number;
  readonly bodyWidth: number;
  /** Horizontal centroid of the opaque lower 28% of the body. */
  readonly lowerBodyAnchorX: number;
  /** Inclusive y coordinate of the lowest opaque body pixel. */
  readonly baseline: number;
}

export interface NeutralDirectionRegistrationThresholds {
  readonly padding: number;
  readonly edgeMargin: number;
  readonly maxEdgePixels: number;
  readonly minMedianHeightRatio: number;
  readonly maxMedianHeightRatio: number;
  readonly maxBaselineDeltaPixels: number;
  readonly maxLowerBodyAnchorDeltaPixels: number;
}

export interface NeutralDirectionRegistrationManifest {
  readonly schemaVersion: typeof NEUTRAL_DIRECTION_REGISTRATION_SCHEMA;
  readonly cell: {
    readonly width: typeof PET_CELL_WIDTH;
    readonly height: typeof PET_CELL_HEIGHT;
  };
  readonly row9Source: {
    readonly width: number;
    readonly height: number;
    readonly columns: 4;
    readonly rows: 2;
    readonly frameCount: 8;
  };
  readonly chroma: {
    readonly key: string;
    readonly threshold: number;
    readonly feather: number;
  };
  readonly transform: {
    /** The only source-pixel-to-final-cell scale allowed for rows 9 and 10. */
    readonly scale: number;
    readonly target: DirectionCellGeometry;
  };
  readonly thresholds: NeutralDirectionRegistrationThresholds;
}

export interface DirectionRegistrationCellDiagnostics {
  readonly index: number;
  readonly sourceBounds: PixelBounds | null;
  readonly sourceGeometry: DirectionCellGeometry | null;
  readonly normalizedBounds: PixelBounds | null;
  readonly normalizedGeometry: DirectionCellGeometry | null;
  readonly chromaCoverage: number;
  readonly edgePixels: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface NeutralDirectionGeometryValidation {
  readonly ok: boolean;
  readonly neutral: DirectionCellGeometry;
  readonly frames: readonly {
    readonly index: number;
    readonly geometry: DirectionCellGeometry | null;
    readonly heightRatio: number | null;
    readonly widthRatio: number | null;
    readonly baselineDeltaPixels: number | null;
    readonly lowerBodyAnchorDeltaPixels: number | null;
    readonly edgePixels: number;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  }[];
  readonly medianHeightRatio: number | null;
  readonly medianWidthRatio: number | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface NeutralLockedDirectionRowResult {
  readonly frames: readonly Buffer[];
  /** Transparent 8x1 row containing the exact frames used by QA and assembly. */
  readonly registeredRow: Buffer;
  readonly manifest: NeutralDirectionRegistrationManifest;
  readonly validation: NeutralDirectionGeometryValidation;
  readonly diagnostics: readonly DirectionRegistrationCellDiagnostics[];
  readonly sourceBoardSize: { readonly width: number; readonly height: number };
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface DirectionBoardRegistrationOptions {
  readonly chromaKey: string;
  /** Chronological output index -> physical row-major source slot index. */
  readonly frameOrder?: readonly number[];
  readonly chromaThreshold?: number;
  readonly chromaFeather?: number;
  readonly minChromaCoverage?: number;
  readonly maxChromaCoverage?: number;
  readonly allowMultipleForegroundComponents?: boolean;
  readonly allowTransparentHoles?: boolean;
  readonly thresholds?: Partial<NeutralDirectionRegistrationThresholds>;
}

const DEFAULT_THRESHOLDS: NeutralDirectionRegistrationThresholds = {
  padding: 5,
  edgeMargin: 2,
  maxEdgePixels: 24,
  minMedianHeightRatio: 0.8,
  maxMedianHeightRatio: 1.12,
  maxBaselineDeltaPixels: 2,
  maxLowerBodyAnchorDeltaPixels: 3,
};

function resolvedThresholds(
  overrides: Partial<NeutralDirectionRegistrationThresholds> = {},
): NeutralDirectionRegistrationThresholds {
  const value = { ...DEFAULT_THRESHOLDS, ...overrides };
  if (!Number.isInteger(value.padding) || value.padding < 1 || value.padding * 2 >= Math.min(PET_CELL_WIDTH, PET_CELL_HEIGHT)) {
    throw new Error("Direction registration padding must be a positive safe cell inset");
  }
  if (!Number.isInteger(value.edgeMargin) || value.edgeMargin < 1 || value.edgeMargin * 2 >= Math.min(PET_CELL_WIDTH, PET_CELL_HEIGHT)) {
    throw new Error("Direction registration edge margin must be a positive cell inset");
  }
  if (!Number.isInteger(value.maxEdgePixels) || value.maxEdgePixels < 0) {
    throw new Error("Direction registration maxEdgePixels must be a non-negative integer");
  }
  if (!Number.isFinite(value.minMedianHeightRatio) || !Number.isFinite(value.maxMedianHeightRatio)
    || value.minMedianHeightRatio <= 0 || value.maxMedianHeightRatio < value.minMedianHeightRatio) {
    throw new Error("Direction registration height ratios are invalid");
  }
  if (!Number.isFinite(value.maxBaselineDeltaPixels) || value.maxBaselineDeltaPixels < 0
    || !Number.isFinite(value.maxLowerBodyAnchorDeltaPixels) || value.maxLowerBodyAnchorDeltaPixels < 0) {
    throw new Error("Direction registration geometry deltas must be non-negative");
  }
  return value;
}

function pixelBounds(left: number, top: number, right: number, bottom: number): PixelBounds {
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

async function measureGeometry(input: Buffer, minAlpha = 24): Promise<DirectionCellGeometry | null> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3]!;
      if (alpha < minAlpha) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return null;
  const bounds = pixelBounds(left, top, right, bottom);
  const lowerBandStart = top + (bottom - top) * 0.72;
  let lowerX = 0;
  let lowerCount = 0;
  for (let y = Math.ceil(lowerBandStart); y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3]!;
      if (alpha < minAlpha) continue;
      lowerX += x;
      lowerCount += 1;
    }
  }
  return {
    bounds,
    bodyHeight: bounds.height,
    bodyWidth: bounds.width,
    lowerBodyAnchorX: lowerCount > 0 ? lowerX / lowerCount : left + (bounds.width - 1) / 2,
    baseline: bottom,
  };
}

async function countNearEdgePixels(input: Buffer, margin: number, minAlpha = 24): Promise<number> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (x >= margin && x < info.width - margin && y >= margin && y < info.height - margin) continue;
      if (data[(y * info.width + x) * info.channels + 3]! >= minAlpha) count += 1;
    }
  }
  return count;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

async function requireNeutralGeometry(neutralCell: Buffer): Promise<DirectionCellGeometry> {
  const metadata = await sharp(neutralCell).metadata();
  if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
    throw new Error(`Neutral direction reference must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
  }
  const geometry = await measureGeometry(neutralCell);
  if (!geometry) throw new Error("Neutral direction reference must contain a visible pet");
  return geometry;
}

interface CleanedDirectionCell {
  readonly image: Buffer;
  readonly inspection: FrameDiagnostics;
  readonly geometry: DirectionCellGeometry | null;
  readonly chromaCoverage: number;
}

async function extractCleanedDirectionCells(
  board: Buffer,
  options: DirectionBoardRegistrationOptions,
): Promise<{
  readonly cells: readonly CleanedDirectionCell[];
  readonly sourceBoardSize: { readonly width: number; readonly height: number };
  readonly chroma: { readonly key: string; readonly threshold: number; readonly feather: number };
}> {
  const metadata = await sharp(board).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Direction board has no readable dimensions");
  const cells: CleanedDirectionCell[] = [];
  let chroma: { key: string; threshold: number; feather: number } | null = null;
  for (let index = 0; index < 8; index += 1) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const left = Math.floor(column * metadata.width / 4);
    const right = Math.floor((column + 1) * metadata.width / 4);
    const top = Math.floor(row * metadata.height / 2);
    const bottom = Math.floor((row + 1) * metadata.height / 2);
    const tile = await sharp(board).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
    const removed = await removeChroma(tile, {
      key: options.chromaKey,
      threshold: options.chromaThreshold,
      feather: options.chromaFeather,
    });
    chroma ??= { key: removed.key, threshold: removed.threshold, feather: removed.feather };
    cells.push({
      image: removed.image,
      inspection: await inspectFrame(removed.image, index, {
        allowMultipleForegroundComponents: options.allowMultipleForegroundComponents,
        allowTransparentHoles: options.allowTransparentHoles,
      }),
      geometry: await measureGeometry(removed.image),
      chromaCoverage: removed.totalPixels > 0
        ? (removed.removedPixels + removed.softenedPixels) / removed.totalPixels
        : 0,
    });
  }
  const frameOrder = options.frameOrder ?? Array.from({ length: 8 }, (_, index) => index);
  if (frameOrder.length !== 8
    || new Set(frameOrder).size !== 8
    || frameOrder.some((index) => !Number.isInteger(index) || index < 0 || index >= 8)) {
    throw new Error("Direction frameOrder must be a permutation of source slots 0 through 7");
  }
  const orderedCells = frameOrder.map((sourceIndex, chronologicalIndex) => {
    const cell = cells[sourceIndex]!;
    return { ...cell, inspection: { ...cell.inspection, index: chronologicalIndex } };
  });
  return {
    cells: orderedCells,
    sourceBoardSize: { width: metadata.width, height: metadata.height },
    chroma: chroma!,
  };
}

function chooseLockedScale(
  cells: readonly CleanedDirectionCell[],
  target: DirectionCellGeometry,
  thresholds: NeutralDirectionRegistrationThresholds,
): number {
  const geometries = cells.map((cell) => cell.geometry).filter((value): value is DirectionCellGeometry => Boolean(value));
  if (geometries.length !== cells.length) return 1;
  const maxHeight = Math.max(...geometries.map((geometry) => geometry.bodyHeight));
  const maxWidth = Math.max(...geometries.map((geometry) => geometry.bodyWidth));
  const limits = [
    1,
    target.bodyHeight / maxHeight,
    (PET_CELL_WIDTH - thresholds.padding * 2) / maxWidth,
    (PET_CELL_HEIGHT - thresholds.padding * 2) / maxHeight,
    (target.baseline - thresholds.padding + 1) / maxHeight,
  ];
  for (const geometry of geometries) {
    const localAnchor = geometry.lowerBodyAnchorX - geometry.bounds.left;
    const leftExtent = localAnchor;
    const rightExtent = geometry.bounds.width - 1 - localAnchor;
    if (leftExtent > 0) limits.push((target.lowerBodyAnchorX - thresholds.padding) / leftExtent);
    if (rightExtent > 0) limits.push((PET_CELL_WIDTH - 1 - thresholds.padding - target.lowerBodyAnchorX) / rightExtent);
  }
  const scale = Math.min(...limits.filter((value) => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Could not derive a positive neutral-locked direction scale");
  return scale;
}

async function registerCleanedCells(
  cells: readonly CleanedDirectionCell[],
  target: DirectionCellGeometry,
  scale: number,
  thresholds: NeutralDirectionRegistrationThresholds,
  options: DirectionBoardRegistrationOptions,
): Promise<{
  readonly frames: readonly Buffer[];
  readonly diagnostics: readonly DirectionRegistrationCellDiagnostics[];
}> {
  const minChromaCoverage = options.minChromaCoverage ?? 0.08;
  const maxChromaCoverage = options.maxChromaCoverage ?? 0.985;
  if (!Number.isFinite(minChromaCoverage) || !Number.isFinite(maxChromaCoverage)
    || minChromaCoverage < 0 || maxChromaCoverage > 1 || minChromaCoverage >= maxChromaCoverage) {
    throw new Error("Direction chroma coverage thresholds must satisfy 0 <= min < max <= 1");
  }
  const frames: Buffer[] = [];
  const diagnostics: DirectionRegistrationCellDiagnostics[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    const errors = cell.inspection.errors.map((error) => error === "touches-cell-edge" ? "source-touches-slot-edge" : error);
    const warnings = [...cell.inspection.warnings];
    if (cell.chromaCoverage < minChromaCoverage) {
      errors.push(`chroma-coverage-too-low:${cell.chromaCoverage.toFixed(4)}:min:${minChromaCoverage.toFixed(4)}`);
    }
    if (cell.chromaCoverage > maxChromaCoverage) {
      errors.push(`chroma-coverage-too-high:${cell.chromaCoverage.toFixed(4)}:max:${maxChromaCoverage.toFixed(4)}`);
    }
    let frame = await sharp({
      create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    if (cell.geometry) {
      const { bounds } = cell.geometry;
      const targetWidth = Math.max(1, Math.round(bounds.width * scale));
      const targetHeight = Math.max(1, Math.round(bounds.height * scale));
      const localAnchor = cell.geometry.lowerBodyAnchorX - bounds.left;
      const left = Math.round(target.lowerBodyAnchorX - localAnchor * scale);
      const top = Math.round(target.baseline - targetHeight + 1);
      if (left < thresholds.padding || top < thresholds.padding
        || left + targetWidth > PET_CELL_WIDTH - thresholds.padding
        || top + targetHeight > PET_CELL_HEIGHT - thresholds.padding) {
        errors.push("registered-frame-outside-safe-margin");
      }
      const crop = await sharp(cell.image).extract({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }).resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
      // Explicitly clip an invalid oversized placement for diagnostics. Sharp
      // rejects a composite wider than its destination, and throwing here
      // would hide the useful fixed-transform edge error from the repair loop.
      const destinationLeft = Math.max(0, left);
      const destinationTop = Math.max(0, top);
      const sourceLeft = Math.max(0, -left);
      const sourceTop = Math.max(0, -top);
      const visibleWidth = Math.min(targetWidth - sourceLeft, PET_CELL_WIDTH - destinationLeft);
      const visibleHeight = Math.min(targetHeight - sourceTop, PET_CELL_HEIGHT - destinationTop);
      if (visibleWidth > 0 && visibleHeight > 0) {
        const visibleCrop = sourceLeft === 0 && sourceTop === 0 && visibleWidth === targetWidth && visibleHeight === targetHeight
          ? crop
          : await sharp(crop).extract({ left: sourceLeft, top: sourceTop, width: visibleWidth, height: visibleHeight }).png().toBuffer();
        frame = await sharp({
          create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).composite([{ input: visibleCrop, left: destinationLeft, top: destinationTop }]).png().toBuffer();
      }
    }
    const normalizedInspection = await inspectFrame(frame, index, {
      allowMultipleForegroundComponents: options.allowMultipleForegroundComponents,
      allowTransparentHoles: options.allowTransparentHoles,
    });
    for (const error of normalizedInspection.errors) {
      if (!errors.includes(error)) errors.push(error);
    }
    warnings.push(...normalizedInspection.warnings.filter((warning) => !warnings.includes(warning)));
    const edgePixels = await countNearEdgePixels(frame, thresholds.edgeMargin);
    if (edgePixels > thresholds.maxEdgePixels) {
      errors.push(`registered-near-edge-pixels:${edgePixels}:max:${thresholds.maxEdgePixels}`);
    }
    const normalizedGeometry = await measureGeometry(frame);
    frames.push(frame);
    diagnostics.push({
      index,
      sourceBounds: cell.inspection.sourceBounds,
      sourceGeometry: cell.geometry,
      normalizedBounds: normalizedInspection.normalizedBounds,
      normalizedGeometry,
      chromaCoverage: cell.chromaCoverage,
      edgePixels,
      errors,
      warnings,
    });
  }
  return { frames, diagnostics };
}

export async function composeRegisteredDirectionRow(frames: readonly Buffer[]): Promise<Buffer> {
  if (frames.length !== 8) throw new Error("Registered direction row requires exactly eight frames");
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      throw new Error(`Registered direction frame ${index} must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
  }));
  return sharp({
    create: { width: PET_ATLAS_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(frames.map((input, index) => ({ input, left: index * PET_CELL_WIDTH, top: 0 }))).png().toBuffer();
}

export async function splitRegisteredDirectionRow(row: Buffer): Promise<readonly Buffer[]> {
  const metadata = await sharp(row).metadata();
  if (metadata.width !== PET_ATLAS_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
    throw new Error(`Registered direction row must be ${PET_ATLAS_WIDTH}x${PET_CELL_HEIGHT}`);
  }
  return Promise.all(Array.from({ length: 8 }, (_, index) => sharp(row).extract({
    left: index * PET_CELL_WIDTH,
    top: 0,
    width: PET_CELL_WIDTH,
    height: PET_CELL_HEIGHT,
  }).png().toBuffer()));
}

export async function validateNeutralLockedDirectionFrames(
  neutralCell: Buffer,
  frames: readonly Buffer[],
  thresholdOverrides: Partial<NeutralDirectionRegistrationThresholds> = {},
): Promise<NeutralDirectionGeometryValidation> {
  if (frames.length !== 8) throw new Error("Neutral-locked direction validation requires exactly eight frames");
  const thresholds = resolvedThresholds(thresholdOverrides);
  const neutral = await requireNeutralGeometry(neutralCell);
  const reports: NeutralDirectionGeometryValidation["frames"][number][] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const metadata = await sharp(frame).metadata();
    const frameErrors: string[] = [];
    const frameWarnings: string[] = [];
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      frameErrors.push(`dimensions:${metadata.width ?? 0}x${metadata.height ?? 0}:expected:${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
    const inspection = await inspectFrame(frame, index);
    frameErrors.push(...inspection.errors);
    frameWarnings.push(...inspection.warnings);
    const geometry = await measureGeometry(frame);
    const edgePixels = await countNearEdgePixels(frame, thresholds.edgeMargin);
    if (edgePixels > thresholds.maxEdgePixels) {
      frameErrors.push(`near-edge-pixels:${edgePixels}:max:${thresholds.maxEdgePixels}`);
    }
    const heightRatio = geometry ? geometry.bodyHeight / neutral.bodyHeight : null;
    const widthRatio = geometry ? geometry.bodyWidth / neutral.bodyWidth : null;
    const baselineDeltaPixels = geometry ? geometry.baseline - neutral.baseline : null;
    const lowerBodyAnchorDeltaPixels = geometry ? geometry.lowerBodyAnchorX - neutral.lowerBodyAnchorX : null;
    if (baselineDeltaPixels !== null && Math.abs(baselineDeltaPixels) > thresholds.maxBaselineDeltaPixels) {
      frameErrors.push(`floating-baseline-delta:${baselineDeltaPixels.toFixed(1)}:max:${thresholds.maxBaselineDeltaPixels.toFixed(1)}`);
    }
    if (lowerBodyAnchorDeltaPixels !== null && Math.abs(lowerBodyAnchorDeltaPixels) > thresholds.maxLowerBodyAnchorDeltaPixels) {
      frameErrors.push(`lower-body-anchor-delta:${lowerBodyAnchorDeltaPixels.toFixed(1)}:max:${thresholds.maxLowerBodyAnchorDeltaPixels.toFixed(1)}`);
    }
    errors.push(...frameErrors.map((error) => `frame-${index}:${error}`));
    warnings.push(...frameWarnings.map((warning) => `frame-${index}:${warning}`));
    reports.push({
      index,
      geometry,
      heightRatio,
      widthRatio,
      baselineDeltaPixels,
      lowerBodyAnchorDeltaPixels,
      edgePixels,
      errors: frameErrors,
      warnings: frameWarnings,
    });
  }
  const medianHeightRatio = median(reports.map((report) => report.heightRatio).filter((value): value is number => value !== null));
  const medianWidthRatio = median(reports.map((report) => report.widthRatio).filter((value): value is number => value !== null));
  if (medianHeightRatio !== null && medianHeightRatio < thresholds.minMedianHeightRatio) {
    errors.push(`look-scale-too-small:median-height-ratio:${medianHeightRatio.toFixed(3)}:min:${thresholds.minMedianHeightRatio.toFixed(3)}`);
  }
  if (medianHeightRatio !== null && medianHeightRatio > thresholds.maxMedianHeightRatio) {
    errors.push(`look-scale-too-large:median-height-ratio:${medianHeightRatio.toFixed(3)}:max:${thresholds.maxMedianHeightRatio.toFixed(3)}`);
  }
  return { ok: errors.length === 0, neutral, frames: reports, medianHeightRatio, medianWidthRatio, errors, warnings };
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Direction registration manifest has invalid ${label}`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`Direction registration manifest has invalid ${label}`);
}

export function parseNeutralDirectionRegistrationManifest(value: unknown): NeutralDirectionRegistrationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Direction registration manifest must be an object");
  const manifest = value as Partial<NeutralDirectionRegistrationManifest>;
  if (manifest.schemaVersion !== NEUTRAL_DIRECTION_REGISTRATION_SCHEMA) throw new Error("Direction registration manifest schema is unsupported");
  if (manifest.cell?.width !== PET_CELL_WIDTH || manifest.cell.height !== PET_CELL_HEIGHT) throw new Error("Direction registration manifest has the wrong cell geometry");
  if (manifest.row9Source?.columns !== 4 || manifest.row9Source.rows !== 2 || manifest.row9Source.frameCount !== 8) {
    throw new Error("Direction registration manifest has the wrong row-9 layout");
  }
  assertPositiveInteger(manifest.row9Source.width, "row9Source.width");
  assertPositiveInteger(manifest.row9Source.height, "row9Source.height");
  assertFiniteNumber(manifest.transform?.scale, "transform.scale");
  if (manifest.transform.scale <= 0 || manifest.transform.scale > 8) throw new Error("Direction registration manifest scale is outside its supported range");
  const target = manifest.transform.target;
  if (!target?.bounds) throw new Error("Direction registration manifest is missing its neutral target");
  for (const [label, number] of Object.entries({
    "target.bodyHeight": target.bodyHeight,
    "target.bodyWidth": target.bodyWidth,
    "target.lowerBodyAnchorX": target.lowerBodyAnchorX,
    "target.baseline": target.baseline,
    "target.bounds.left": target.bounds.left,
    "target.bounds.top": target.bounds.top,
    "target.bounds.right": target.bounds.right,
    "target.bounds.bottom": target.bounds.bottom,
    "target.bounds.width": target.bounds.width,
    "target.bounds.height": target.bounds.height,
  })) assertFiniteNumber(number, label);
  if (!Number.isInteger(target.bodyHeight) || !Number.isInteger(target.bodyWidth)
    || target.bodyHeight < 1 || target.bodyWidth < 1
    || target.bounds.width !== target.bodyWidth || target.bounds.height !== target.bodyHeight
    || target.bounds.right - target.bounds.left + 1 !== target.bounds.width
    || target.bounds.bottom - target.bounds.top + 1 !== target.bounds.height
    || target.bounds.left < 0 || target.bounds.top < 0
    || target.bounds.right >= PET_CELL_WIDTH || target.bounds.bottom >= PET_CELL_HEIGHT
    || target.baseline !== target.bounds.bottom
    || target.lowerBodyAnchorX < target.bounds.left || target.lowerBodyAnchorX > target.bounds.right) {
    throw new Error("Direction registration manifest neutral target is inconsistent with its cell bounds");
  }
  if (!manifest.chroma || typeof manifest.chroma.key !== "string") throw new Error("Direction registration manifest is missing chroma settings");
  // Normalize only for validation; retain the persisted spelling so exact
  // artifact bytes remain stable across resume.
  parseHexColor(manifest.chroma.key);
  assertFiniteNumber(manifest.chroma.threshold, "chroma.threshold");
  assertFiniteNumber(manifest.chroma.feather, "chroma.feather");
  if (manifest.chroma.threshold < 0 || manifest.chroma.feather < 0) throw new Error("Direction registration manifest chroma settings must be non-negative");
  if (!manifest.thresholds) throw new Error("Direction registration manifest is missing validation thresholds");
  resolvedThresholds(manifest.thresholds);
  return manifest as NeutralDirectionRegistrationManifest;
}

function sameGeometry(left: DirectionCellGeometry, right: DirectionCellGeometry, tolerance = 0.01): boolean {
  return Math.abs(left.bodyHeight - right.bodyHeight) <= tolerance
    && Math.abs(left.bodyWidth - right.bodyWidth) <= tolerance
    && Math.abs(left.lowerBodyAnchorX - right.lowerBodyAnchorX) <= tolerance
    && Math.abs(left.baseline - right.baseline) <= tolerance
    && Math.abs(left.bounds.left - right.bounds.left) <= tolerance
    && Math.abs(left.bounds.top - right.bounds.top) <= tolerance
    && Math.abs(left.bounds.right - right.bounds.right) <= tolerance
    && Math.abs(left.bounds.bottom - right.bounds.bottom) <= tolerance;
}

async function finishRegistration(
  neutralCell: Buffer,
  cells: readonly CleanedDirectionCell[],
  sourceBoardSize: { readonly width: number; readonly height: number },
  manifest: NeutralDirectionRegistrationManifest,
  options: DirectionBoardRegistrationOptions,
): Promise<NeutralLockedDirectionRowResult> {
  const registered = await registerCleanedCells(cells, manifest.transform.target, manifest.transform.scale, manifest.thresholds, options);
  const validation = await validateNeutralLockedDirectionFrames(neutralCell, registered.frames, manifest.thresholds);
  const registeredRow = await composeRegisteredDirectionRow(registered.frames);
  const diagnosticErrors = registered.diagnostics.flatMap((diagnostic) => diagnostic.errors.map((error) => `frame-${diagnostic.index}:${error}`));
  const diagnosticWarnings = registered.diagnostics.flatMap((diagnostic) => diagnostic.warnings.map((warning) => `frame-${diagnostic.index}:${warning}`));
  const errors = [...new Set([...diagnosticErrors, ...validation.errors])];
  const warnings = [...new Set([...diagnosticWarnings, ...validation.warnings])];
  return {
    frames: registered.frames,
    registeredRow,
    manifest,
    validation,
    diagnostics: registered.diagnostics,
    sourceBoardSize,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Register row 9 exactly once against the approved idle/neutral cell. The
 * returned manifest is the immutable transform contract consumed by row 10.
 */
export async function registerFirstDirectionRowToNeutral(
  board: Buffer,
  neutralCell: Buffer,
  options: DirectionBoardRegistrationOptions,
): Promise<NeutralLockedDirectionRowResult> {
  const target = await requireNeutralGeometry(neutralCell);
  const thresholds = resolvedThresholds(options.thresholds);
  const extracted = await extractCleanedDirectionCells(board, options);
  const scale = chooseLockedScale(extracted.cells, target, thresholds);
  const manifest: NeutralDirectionRegistrationManifest = {
    schemaVersion: NEUTRAL_DIRECTION_REGISTRATION_SCHEMA,
    cell: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT },
    row9Source: { ...extracted.sourceBoardSize, columns: 4, rows: 2, frameCount: 8 },
    chroma: extracted.chroma,
    transform: { scale, target },
    thresholds,
  };
  return finishRegistration(neutralCell, extracted.cells, extracted.sourceBoardSize, manifest, options);
}

/**
 * Register row 10 with row 9's persisted transform. This function never reads,
 * resizes or returns row-9 pixels, so a wide row-10 pose can only fail row 10;
 * it cannot silently shrink an already-approved row 9.
 */
export async function registerSecondDirectionRowWithManifest(
  board: Buffer,
  neutralCell: Buffer,
  manifestInput: NeutralDirectionRegistrationManifest | unknown,
  options: DirectionBoardRegistrationOptions,
): Promise<NeutralLockedDirectionRowResult> {
  const manifest = parseNeutralDirectionRegistrationManifest(manifestInput);
  const neutral = await requireNeutralGeometry(neutralCell);
  if (!sameGeometry(neutral, manifest.transform.target)) {
    throw new Error("Direction registration manifest no longer matches the approved neutral frame");
  }
  const requestedKey = formatHexColor(parseHexColor(options.chromaKey));
  if (requestedKey !== formatHexColor(parseHexColor(manifest.chroma.key))) {
    throw new Error("Direction registration manifest chroma key does not match this run");
  }
  if (options.thresholds) {
    const requestedThresholds = resolvedThresholds(options.thresholds);
    if (JSON.stringify(requestedThresholds) !== JSON.stringify(manifest.thresholds)) {
      throw new Error("Direction registration thresholds cannot change after row 9 approval");
    }
  }
  const extracted = await extractCleanedDirectionCells(board, {
    ...options,
    chromaThreshold: manifest.chroma.threshold,
    chromaFeather: manifest.chroma.feather,
    thresholds: manifest.thresholds,
  });
  return finishRegistration(neutralCell, extracted.cells, extracted.sourceBoardSize, manifest, {
    ...options,
    chromaThreshold: manifest.chroma.threshold,
    chromaFeather: manifest.chroma.feather,
    thresholds: manifest.thresholds,
  });
}
