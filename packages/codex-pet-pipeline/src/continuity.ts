import sharp from "sharp";
import {
  LOOK_DIRECTIONS,
  PET_ATLAS_HEIGHT,
  PET_ATLAS_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from "./constants.js";
import type { PixelBounds } from "./extraction.js";

export interface DirectionContinuityThresholds {
  /** Maximum preferred movement of the foreground bounding-box centre. */
  readonly bboxCenterDeltaPixels: number;
  /** Maximum preferred ratio between the larger and smaller bounding-box areas. */
  readonly bboxAreaRatio: number;
  /** Maximum preferred ratio between the larger and smaller alpha masses. */
  readonly alphaMassRatio: number;
  /** Maximum preferred mean absolute alpha difference over a complete cell. */
  readonly alphaDifferenceRatio: number;
  /** Local alpha-difference multiplier used to identify an abrupt outlier. */
  readonly alphaDifferenceOutlierMultiplier: number;
  /** Maximum preferred movement of the foreground baseline. */
  readonly baselineDeltaPixels: number;
  /** Maximum preferred ratio between the larger and smaller bbox widths/heights. */
  readonly bboxDimensionRatio: number;
}

export interface DirectionFrameContinuityMetrics {
  readonly direction: (typeof LOOK_DIRECTIONS)[number];
  readonly row: 9 | 10;
  readonly column: number;
  readonly bounds: PixelBounds | null;
  readonly bboxCenter: { readonly x: number; readonly y: number } | null;
  readonly bboxArea: number;
  /** Sum of alpha values divided by 255; effectively the antialiased foreground area. */
  readonly alphaMass: number;
  readonly opaquePixels: number;
}

export type DirectionContinuityWarningCode =
  | "bbox-center-jump"
  | "bbox-area-jump"
  | "bbox-dimension-jump"
  | "alpha-mass-jump"
  | "alpha-difference-high"
  | "alpha-difference-local-outlier"
  | "baseline-jump";

export interface DirectionContinuityWarning {
  readonly code: DirectionContinuityWarningCode;
  readonly from: (typeof LOOK_DIRECTIONS)[number];
  readonly to: (typeof LOOK_DIRECTIONS)[number];
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
  readonly message: string;
  /** Machine-readable evidence intended for the labeled visual review. */
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DirectionAdjacentPairMetrics {
  readonly from: (typeof LOOK_DIRECTIONS)[number];
  readonly to: (typeof LOOK_DIRECTIONS)[number];
  readonly crossesAtlasRowBoundary: boolean;
  readonly wrapsLoop: boolean;
  readonly fromBboxCenter: { readonly x: number; readonly y: number } | null;
  readonly toBboxCenter: { readonly x: number; readonly y: number } | null;
  readonly bboxCenterDelta: { readonly x: number; readonly y: number; readonly distance: number } | null;
  readonly fromBboxArea: number;
  readonly toBboxArea: number;
  readonly bboxAreaRatio: number | null;
  readonly bboxAreaRelativeDifference: number | null;
  readonly bboxWidthRatio: number | null;
  readonly bboxHeightRatio: number | null;
  readonly fromAlphaMass: number;
  readonly toAlphaMass: number;
  readonly alphaMassRatio: number | null;
  readonly alphaMassRelativeDifference: number | null;
  /** Pixels whose alpha differs by more than the configured analysis threshold. */
  readonly alphaDifferencePixels: number;
  /** Mean absolute alpha difference, normalized to the range 0..1 over the whole cell. */
  readonly alphaDifferenceRatio: number;
  readonly baselineDeltaPixels: number | null;
  readonly warnings: readonly DirectionContinuityWarning[];
}

export interface DirectionContinuityReport {
  /** False only for deterministic structural errors such as an empty look cell. */
  readonly ok: boolean;
  /** Metric warnings require visual review but are not semantic failures by themselves. */
  readonly reviewRequired: boolean;
  readonly semanticAssessment: "not-assessed";
  readonly thresholds: DirectionContinuityThresholds;
  readonly frames: readonly DirectionFrameContinuityMetrics[];
  readonly pairs: readonly DirectionAdjacentPairMetrics[];
  readonly medianAlphaDifferenceRatio: number;
  readonly warnings: readonly DirectionContinuityWarning[];
  readonly errors: readonly string[];
}

export interface DirectionRowContinuityReport {
  readonly ok: boolean;
  readonly reviewRequired: boolean;
  readonly semanticAssessment: "not-assessed";
  readonly thresholds: DirectionContinuityThresholds;
  readonly frames: readonly DirectionFrameContinuityMetrics[];
  /** Adjacent pairs inside this row only; no fabricated cross-row boundary. */
  readonly pairs: readonly DirectionAdjacentPairMetrics[];
  readonly medianAlphaDifferenceRatio: number;
  readonly warnings: readonly DirectionContinuityWarning[];
  readonly errors: readonly string[];
}

export interface MeasureDirectionContinuityOptions extends Partial<DirectionContinuityThresholds> {
  /** Alpha greater than this value is foreground for bbox and changed-pixel metrics. */
  readonly alphaThreshold?: number;
}

const DEFAULT_THRESHOLDS: DirectionContinuityThresholds = {
  bboxCenterDeltaPixels: 8,
  bboxAreaRatio: 1.15,
  alphaMassRatio: 1.18,
  alphaDifferenceRatio: 0.18,
  alphaDifferenceOutlierMultiplier: 1.45,
  baselineDeltaPixels: 8,
  bboxDimensionRatio: 1.15,
};

interface AnalyzedDirectionFrame extends DirectionFrameContinuityMetrics {
  readonly alpha: Uint8Array;
}

interface PairWithoutWarnings extends Omit<DirectionAdjacentPairMetrics, "warnings"> {
  readonly pairIndex: number;
}

function rounded(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(a: number, b: number): number | null {
  if (a <= 0 || b <= 0) return null;
  return Math.max(a, b) / Math.min(a, b);
}

function relativeDifference(a: number, b: number): number | null {
  const denominator = Math.max(a, b);
  return denominator > 0 ? Math.abs(a - b) / denominator : null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function warning(
  pair: PairWithoutWarnings,
  code: DirectionContinuityWarningCode,
  metric: string,
  value: number,
  threshold: number,
  evidence: DirectionContinuityWarning["evidence"],
): DirectionContinuityWarning {
  return {
    code,
    from: pair.from,
    to: pair.to,
    metric,
    value: rounded(value),
    threshold: rounded(threshold),
    message: `${pair.from}->${pair.to} ${metric} is ${rounded(value)} (review threshold ${rounded(threshold)})`,
    evidence,
  };
}

async function analyzeDirectionCell(
  atlas: Buffer,
  index: number,
  alphaThreshold: number,
): Promise<AnalyzedDirectionFrame> {
  const direction = LOOK_DIRECTIONS[index]!;
  const row = (index < 8 ? 9 : 10) as 9 | 10;
  const column = index % 8;
  const { data, info } = await sharp(atlas).extract({
    left: column * PET_CELL_WIDTH,
    top: row * PET_CELL_HEIGHT,
    width: PET_CELL_WIDTH,
    height: PET_CELL_HEIGHT,
  }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(PET_CELL_WIDTH * PET_CELL_HEIGHT);
  let left = PET_CELL_WIDTH;
  let top = PET_CELL_HEIGHT;
  let right = -1;
  let bottom = -1;
  let alphaSum = 0;
  let opaquePixels = 0;
  for (let y = 0; y < PET_CELL_HEIGHT; y += 1) {
    for (let x = 0; x < PET_CELL_WIDTH; x += 1) {
      const pixelIndex = y * PET_CELL_WIDTH + x;
      const value = data[pixelIndex * info.channels + 3]!;
      alpha[pixelIndex] = value;
      alphaSum += value;
      if (value <= alphaThreshold) continue;
      opaquePixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  const bounds: PixelBounds | null = opaquePixels === 0 ? null : {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
  return {
    direction,
    row,
    column,
    bounds,
    bboxCenter: bounds ? { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 } : null,
    bboxArea: bounds ? bounds.width * bounds.height : 0,
    alphaMass: rounded(alphaSum / 255),
    opaquePixels,
    alpha,
  };
}

function buildPair(
  first: AnalyzedDirectionFrame,
  second: AnalyzedDirectionFrame,
  pairIndex: number,
  alphaThreshold: number,
): PairWithoutWarnings {
  let alphaDifferenceSum = 0;
  let alphaDifferencePixels = 0;
  for (let index = 0; index < first.alpha.length; index += 1) {
    const difference = Math.abs(first.alpha[index]! - second.alpha[index]!);
    alphaDifferenceSum += difference;
    if (difference > alphaThreshold) alphaDifferencePixels += 1;
  }
  const centerDelta = first.bboxCenter && second.bboxCenter ? {
    x: rounded(second.bboxCenter.x - first.bboxCenter.x),
    y: rounded(second.bboxCenter.y - first.bboxCenter.y),
    distance: rounded(Math.hypot(second.bboxCenter.x - first.bboxCenter.x, second.bboxCenter.y - first.bboxCenter.y)),
  } : null;
  return {
    pairIndex,
    from: first.direction,
    to: second.direction,
    crossesAtlasRowBoundary: pairIndex === 7 || pairIndex === 15,
    wrapsLoop: pairIndex === 15,
    fromBboxCenter: first.bboxCenter,
    toBboxCenter: second.bboxCenter,
    bboxCenterDelta: centerDelta,
    fromBboxArea: first.bboxArea,
    toBboxArea: second.bboxArea,
    bboxAreaRatio: first.bboxArea && second.bboxArea ? rounded(ratio(first.bboxArea, second.bboxArea)!) : null,
    bboxAreaRelativeDifference: first.bboxArea && second.bboxArea ? rounded(relativeDifference(first.bboxArea, second.bboxArea)!) : null,
    bboxWidthRatio: first.bounds && second.bounds ? rounded(ratio(first.bounds.width, second.bounds.width)!) : null,
    bboxHeightRatio: first.bounds && second.bounds ? rounded(ratio(first.bounds.height, second.bounds.height)!) : null,
    fromAlphaMass: first.alphaMass,
    toAlphaMass: second.alphaMass,
    alphaMassRatio: first.alphaMass && second.alphaMass ? rounded(ratio(first.alphaMass, second.alphaMass)!) : null,
    alphaMassRelativeDifference: first.alphaMass && second.alphaMass ? rounded(relativeDifference(first.alphaMass, second.alphaMass)!) : null,
    alphaDifferencePixels,
    alphaDifferenceRatio: rounded(alphaDifferenceSum / (255 * first.alpha.length)),
    baselineDeltaPixels: first.bounds && second.bounds ? Math.abs(first.bounds.bottom - second.bounds.bottom) : null,
  };
}

/**
 * Quantifies all 16 cyclic look-direction adjacencies in atlas order.
 *
 * The output intentionally does not infer gaze semantics. Metric excursions are
 * review evidence only; they leave `ok` true unless a deterministic structural
 * problem (currently an empty direction cell) is found.
 */
export async function measureDirectionContinuity(
  atlas: Buffer,
  options: MeasureDirectionContinuityOptions = {},
): Promise<DirectionContinuityReport> {
  const metadata = await sharp(atlas).metadata();
  if (metadata.width !== PET_ATLAS_WIDTH || metadata.height !== PET_ATLAS_HEIGHT) {
    throw new Error(`Direction continuity requires a ${PET_ATLAS_WIDTH}x${PET_ATLAS_HEIGHT} v2 atlas`);
  }
  const alphaThreshold = Math.max(0, Math.min(254, Math.round(options.alphaThreshold ?? 16)));
  const thresholds: DirectionContinuityThresholds = {
    bboxCenterDeltaPixels: options.bboxCenterDeltaPixels ?? DEFAULT_THRESHOLDS.bboxCenterDeltaPixels,
    bboxAreaRatio: options.bboxAreaRatio ?? DEFAULT_THRESHOLDS.bboxAreaRatio,
    alphaMassRatio: options.alphaMassRatio ?? DEFAULT_THRESHOLDS.alphaMassRatio,
    alphaDifferenceRatio: options.alphaDifferenceRatio ?? DEFAULT_THRESHOLDS.alphaDifferenceRatio,
    alphaDifferenceOutlierMultiplier: options.alphaDifferenceOutlierMultiplier ?? DEFAULT_THRESHOLDS.alphaDifferenceOutlierMultiplier,
    baselineDeltaPixels: options.baselineDeltaPixels ?? DEFAULT_THRESHOLDS.baselineDeltaPixels,
    bboxDimensionRatio: options.bboxDimensionRatio ?? DEFAULT_THRESHOLDS.bboxDimensionRatio,
  };
  const analyzedFrames = await Promise.all(LOOK_DIRECTIONS.map((_, index) => analyzeDirectionCell(atlas, index, alphaThreshold)));
  const pairMetrics = analyzedFrames.map((frame, index) => buildPair(
    frame,
    analyzedFrames[(index + 1) % analyzedFrames.length]!,
    index,
    alphaThreshold,
  ));
  const allWarnings: DirectionContinuityWarning[] = [];
  const pairs: DirectionAdjacentPairMetrics[] = pairMetrics.map((pair, index) => {
    const pairWarnings: DirectionContinuityWarning[] = [];
    const add = (item: DirectionContinuityWarning) => {
      pairWarnings.push(item);
      allWarnings.push(item);
    };
    if (pair.bboxCenterDelta && pair.bboxCenterDelta.distance > thresholds.bboxCenterDeltaPixels) {
      add(warning(pair, "bbox-center-jump", "bboxCenterDelta.distance", pair.bboxCenterDelta.distance, thresholds.bboxCenterDeltaPixels, {
        fromCenterX: pair.fromBboxCenter?.x ?? null,
        fromCenterY: pair.fromBboxCenter?.y ?? null,
        toCenterX: pair.toBboxCenter?.x ?? null,
        toCenterY: pair.toBboxCenter?.y ?? null,
        deltaX: pair.bboxCenterDelta.x,
        deltaY: pair.bboxCenterDelta.y,
        crossesAtlasRowBoundary: pair.crossesAtlasRowBoundary,
      }));
    }
    if (pair.bboxAreaRatio !== null && pair.bboxAreaRatio > thresholds.bboxAreaRatio) {
      add(warning(pair, "bbox-area-jump", "bboxAreaRatio", pair.bboxAreaRatio, thresholds.bboxAreaRatio, {
        fromBboxArea: pair.fromBboxArea,
        toBboxArea: pair.toBboxArea,
        relativeDifference: pair.bboxAreaRelativeDifference,
      }));
    }
    const dimensionRatio = Math.max(pair.bboxWidthRatio ?? 1, pair.bboxHeightRatio ?? 1);
    if (dimensionRatio > thresholds.bboxDimensionRatio) {
      add(warning(pair, "bbox-dimension-jump", "maxBboxDimensionRatio", dimensionRatio, thresholds.bboxDimensionRatio, {
        bboxWidthRatio: pair.bboxWidthRatio,
        bboxHeightRatio: pair.bboxHeightRatio,
      }));
    }
    if (pair.alphaMassRatio !== null && pair.alphaMassRatio > thresholds.alphaMassRatio) {
      add(warning(pair, "alpha-mass-jump", "alphaMassRatio", pair.alphaMassRatio, thresholds.alphaMassRatio, {
        fromAlphaMass: pair.fromAlphaMass,
        toAlphaMass: pair.toAlphaMass,
        relativeDifference: pair.alphaMassRelativeDifference,
      }));
    }
    if (pair.alphaDifferenceRatio > thresholds.alphaDifferenceRatio) {
      add(warning(pair, "alpha-difference-high", "alphaDifferenceRatio", pair.alphaDifferenceRatio, thresholds.alphaDifferenceRatio, {
        alphaDifferencePixels: pair.alphaDifferencePixels,
        cellPixels: PET_CELL_WIDTH * PET_CELL_HEIGHT,
      }));
    }
    const neighborAverage = (
      pairMetrics[(index - 1 + pairMetrics.length) % pairMetrics.length]!.alphaDifferenceRatio
      + pairMetrics[(index + 1) % pairMetrics.length]!.alphaDifferenceRatio
    ) / 2;
    const outlierThreshold = neighborAverage * thresholds.alphaDifferenceOutlierMultiplier;
    if (neighborAverage > 0 && pair.alphaDifferenceRatio > outlierThreshold) {
      add(warning(pair, "alpha-difference-local-outlier", "alphaDifferenceRatio", pair.alphaDifferenceRatio, outlierThreshold, {
        neighborAverageAlphaDifferenceRatio: rounded(neighborAverage),
        outlierMultiplier: thresholds.alphaDifferenceOutlierMultiplier,
        alphaDifferencePixels: pair.alphaDifferencePixels,
      }));
    }
    if (pair.baselineDeltaPixels !== null && pair.baselineDeltaPixels > thresholds.baselineDeltaPixels) {
      add(warning(pair, "baseline-jump", "baselineDeltaPixels", pair.baselineDeltaPixels, thresholds.baselineDeltaPixels, {
        fromBottom: analyzedFrames[index]!.bounds?.bottom ?? null,
        toBottom: analyzedFrames[(index + 1) % analyzedFrames.length]!.bounds?.bottom ?? null,
      }));
    }
    const { pairIndex: _pairIndex, ...publicPair } = pair;
    return { ...publicPair, warnings: pairWarnings };
  });
  const errors = analyzedFrames
    .filter((frame) => !frame.bounds)
    .map((frame) => `${frame.direction}:empty-direction-cell`);
  const frames: DirectionFrameContinuityMetrics[] = analyzedFrames.map(({ alpha: _alpha, ...frame }) => frame);
  return {
    ok: errors.length === 0,
    reviewRequired: allWarnings.length > 0,
    semanticAssessment: "not-assessed",
    thresholds,
    frames,
    pairs,
    medianAlphaDifferenceRatio: rounded(median(pairMetrics.map((pair) => pair.alphaDifferenceRatio))),
    warnings: allWarnings,
    errors,
  };
}

/**
 * Measures a contiguous direction row before the dependent row is generated.
 * This provides the row-9 registration/continuity gate without fabricating a
 * verdict for the still-missing 157.5->180 boundary. Full cyclic validation is
 * still mandatory after both rows exist.
 */
export async function measureDirectionRowContinuity(
  frames: readonly Buffer[],
  directions: readonly (typeof LOOK_DIRECTIONS)[number][],
  options: MeasureDirectionContinuityOptions = {},
): Promise<DirectionRowContinuityReport> {
  if (frames.length < 2 || frames.length !== directions.length) {
    throw new Error("Direction row continuity requires equal frame/direction arrays with at least two entries");
  }
  const directionIndices = directions.map((direction) => LOOK_DIRECTIONS.indexOf(direction));
  if (directionIndices.some((index) => index < 0)
    || directionIndices.some((index, position) => position > 0 && index !== directionIndices[position - 1]! + 1)) {
    throw new Error("Direction row continuity requires a contiguous clockwise direction sequence");
  }
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      throw new Error(`Direction row frame ${index} must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
  }));

  const byDirection = new Map(directions.map((direction, index) => [direction, frames[index]!] as const));
  const fallback = frames[0]!;
  const atlas = await sharp({
    create: {
      width: PET_ATLAS_WIDTH,
      height: PET_ATLAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(LOOK_DIRECTIONS.map((direction, index) => ({
    input: byDirection.get(direction) ?? fallback,
    left: (index % 8) * PET_CELL_WIDTH,
    top: (index < 8 ? 9 : 10) * PET_CELL_HEIGHT,
  }))).png().toBuffer();
  const full = await measureDirectionContinuity(atlas, options);
  const expectedPairs = new Set(directions.slice(0, -1).map((direction, index) => `${direction}->${directions[index + 1]!}`));
  const pairs = full.pairs.filter((pair) => expectedPairs.has(`${pair.from}->${pair.to}`));
  const warnings = pairs.flatMap((pair) => pair.warnings);
  const directionSet = new Set<string>(directions);
  const errors = full.errors.filter((error) => directionSet.has(error.split(":", 1)[0]!));
  return {
    ok: errors.length === 0,
    reviewRequired: warnings.length > 0,
    semanticAssessment: "not-assessed",
    thresholds: full.thresholds,
    frames: full.frames.filter((frame) => directionSet.has(frame.direction)),
    pairs,
    medianAlphaDifferenceRatio: rounded(median(pairs.map((pair) => pair.alphaDifferenceRatio))),
    warnings,
    errors,
  };
}
