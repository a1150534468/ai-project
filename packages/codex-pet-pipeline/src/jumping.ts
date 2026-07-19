import sharp from "sharp";
import { PET_CELL_HEIGHT, PET_CELL_WIDTH } from "./constants.js";

export interface JumpingArcOptions {
  /** Maximum start/settle ground mismatch as a fraction of the visible body span. */
  readonly groundToleranceRatio?: number;
  readonly minGroundTolerancePixels?: number;
  /** Minimum whole-body travel for frames 2 and 4 to read as airborne. */
  readonly visibleRiseRatio?: number;
  readonly minVisibleRisePixels?: number;
  /** Minimum distance between each transition frame and the unique peak. */
  readonly peakSeparationRatio?: number;
  readonly minPeakSeparationPixels?: number;
  /** Minimum total travel from the grounded endpoints to frame 3. */
  readonly peakLiftRatio?: number;
  readonly minPeakLiftPixels?: number;
}

export interface JumpingArcFramePosition {
  readonly frame: number;
  /** Alpha-weighted median Y; robust against thin feet and changing leg poses. */
  readonly centerY: number | null;
  /** Alpha-weighted 97th percentile Y, used only for grounded endpoint checks. */
  readonly groundY: number | null;
  /** Alpha-weighted 10th-to-90th percentile body span. */
  readonly bodySpan: number | null;
}

export interface JumpingArcThresholds {
  readonly groundTolerancePixels: number;
  readonly visibleRisePixels: number;
  readonly peakSeparationPixels: number;
  readonly peakLiftPixels: number;
}

export interface JumpingArcDiagnostics {
  readonly positions: readonly JumpingArcFramePosition[];
  readonly thresholds: JumpingArcThresholds | null;
  readonly groundReferenceY: number | null;
  readonly peakLiftPixels: number | null;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface AlphaPosition {
  readonly centerY: number;
  readonly groundY: number;
  readonly bodySpan: number;
}

function assertThreshold(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
}

function weightedQuantile(rows: readonly number[], quantile: number): number {
  const total = rows.reduce((sum, weight) => sum + weight, 0);
  const target = total * quantile;
  let cumulative = 0;
  for (let y = 0; y < rows.length; y += 1) {
    cumulative += rows[y]!;
    if (cumulative >= target) return y;
  }
  return rows.length - 1;
}

async function measureAlphaPosition(frame: Buffer): Promise<AlphaPosition | null> {
  const { data, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== PET_CELL_WIDTH || info.height !== PET_CELL_HEIGHT) {
    throw new Error(`Jumping arc frames must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
  }
  const rows = new Array<number>(info.height).fill(0);
  let total = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[((y * info.width + x) * info.channels) + 3]!;
      // Ignore only near-transparent antialiasing noise. Weighting the
      // remaining pixels by alpha keeps soft non-pixel styles first-class.
      if (alpha < 24) continue;
      rows[y] += alpha;
      total += alpha;
    }
  }
  if (total === 0) return null;
  const upper = weightedQuantile(rows, 0.1);
  const lower = weightedQuantile(rows, 0.9);
  return {
    centerY: weightedQuantile(rows, 0.5),
    groundY: weightedQuantile(rows, 0.97),
    bodySpan: Math.max(1, lower - upper + 1),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function detail(value: number): string {
  return value.toFixed(1);
}

/**
 * Validate the five production-size jumping cells as one visible arc.
 *
 * The alpha-weighted median follows the mass of the character, rather than a
 * paw/ear extremity, so a changed leg pose cannot masquerade as whole-body
 * travel. The lower 97th percentile is deliberately limited to checking that
 * anticipation and settle return to the same practical ground level.
 */
export async function validateJumpingArc(
  frames: readonly Buffer[],
  options: JumpingArcOptions = {},
): Promise<JumpingArcDiagnostics> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (frames.length !== 5) {
    return {
      positions: [],
      thresholds: null,
      groundReferenceY: null,
      peakLiftPixels: null,
      ok: false,
      errors: [`jumping-arc:requires-exactly-5-frames:actual:${frames.length}`],
      warnings,
    };
  }

  const groundToleranceRatio = options.groundToleranceRatio ?? 0.06;
  const minGroundTolerancePixels = options.minGroundTolerancePixels ?? 6;
  const visibleRiseRatio = options.visibleRiseRatio ?? 0.07;
  const minVisibleRisePixels = options.minVisibleRisePixels ?? 8;
  const peakSeparationRatio = options.peakSeparationRatio ?? 0.055;
  const minPeakSeparationPixels = options.minPeakSeparationPixels ?? 7;
  const peakLiftRatio = options.peakLiftRatio ?? 0.16;
  const minPeakLiftPixels = options.minPeakLiftPixels ?? 18;
  assertThreshold("groundToleranceRatio", groundToleranceRatio, 0);
  assertThreshold("minGroundTolerancePixels", minGroundTolerancePixels, 0);
  assertThreshold("visibleRiseRatio", visibleRiseRatio, 0);
  assertThreshold("minVisibleRisePixels", minVisibleRisePixels, 0);
  assertThreshold("peakSeparationRatio", peakSeparationRatio, 0);
  assertThreshold("minPeakSeparationPixels", minPeakSeparationPixels, 0);
  assertThreshold("peakLiftRatio", peakLiftRatio, 0);
  assertThreshold("minPeakLiftPixels", minPeakLiftPixels, 0);

  const measured = await Promise.all(frames.map(measureAlphaPosition));
  const positions: JumpingArcFramePosition[] = measured.map((position, index) => ({
    frame: index + 1,
    centerY: position?.centerY ?? null,
    groundY: position?.groundY ?? null,
    bodySpan: position?.bodySpan ?? null,
  }));
  measured.forEach((position, index) => {
    if (!position) errors.push(`jumping-arc:frame-${index + 1}-empty`);
  });
  const complete = measured.filter((position): position is AlphaPosition => position !== null);
  if (complete.length !== 5) {
    return {
      positions,
      thresholds: null,
      groundReferenceY: null,
      peakLiftPixels: null,
      ok: false,
      errors,
      warnings,
    };
  }

  const bodySpan = median(complete.map((position) => position.bodySpan));
  const thresholds: JumpingArcThresholds = {
    groundTolerancePixels: Math.max(minGroundTolerancePixels, Math.ceil(bodySpan * groundToleranceRatio)),
    visibleRisePixels: Math.max(minVisibleRisePixels, Math.ceil(bodySpan * visibleRiseRatio)),
    peakSeparationPixels: Math.max(minPeakSeparationPixels, Math.ceil(bodySpan * peakSeparationRatio)),
    peakLiftPixels: Math.max(minPeakLiftPixels, Math.ceil(bodySpan * peakLiftRatio)),
  };
  const [anticipation, rising, peak, descending, settle] = complete as [AlphaPosition, AlphaPosition, AlphaPosition, AlphaPosition, AlphaPosition];
  // Only the requested grounded endpoints define the practical baseline. An
  // extended paw/leg in an airborne transition must not move that reference.
  const groundReferenceY = Math.max(anticipation.groundY, settle.groundY);
  const anticipationGroundGap = groundReferenceY - anticipation.groundY;
  const settleGroundGap = groundReferenceY - settle.groundY;
  if (anticipationGroundGap > thresholds.groundTolerancePixels) {
    errors.push(`jumping-arc:frame-1-not-grounded:gap:${detail(anticipationGroundGap)}:max:${detail(thresholds.groundTolerancePixels)}`);
  }
  if (settleGroundGap > thresholds.groundTolerancePixels) {
    errors.push(`jumping-arc:frame-5-not-grounded:gap:${detail(settleGroundGap)}:max:${detail(thresholds.groundTolerancePixels)}`);
  }

  const firstRise = anticipation.centerY - rising.centerY;
  if (firstRise < thresholds.visibleRisePixels) {
    errors.push(`jumping-arc:frame-2-rise-too-small:actual:${detail(firstRise)}:min:${detail(thresholds.visibleRisePixels)}`);
  }
  const riseToPeak = rising.centerY - peak.centerY;
  if (riseToPeak < thresholds.peakSeparationPixels) {
    errors.push(`jumping-arc:frame-3-not-unique-above-frame-2:actual:${detail(riseToPeak)}:min:${detail(thresholds.peakSeparationPixels)}`);
  }
  const descentFromPeak = descending.centerY - peak.centerY;
  if (descentFromPeak < thresholds.peakSeparationPixels) {
    errors.push(`jumping-arc:frame-4-descent-from-peak-too-small:actual:${detail(descentFromPeak)}:min:${detail(thresholds.peakSeparationPixels)}`);
  }
  const settleAfterDescent = settle.centerY - descending.centerY;
  if (settleAfterDescent < thresholds.visibleRisePixels) {
    errors.push(`jumping-arc:frame-4-not-airborne-before-settle:actual:${detail(settleAfterDescent)}:min:${detail(thresholds.visibleRisePixels)}`);
  }
  const groundedCenterY = (anticipation.centerY + settle.centerY) / 2;
  const peakLiftPixels = groundedCenterY - peak.centerY;
  if (peakLiftPixels < thresholds.peakLiftPixels) {
    errors.push(`jumping-arc:peak-lift-too-small:actual:${detail(peakLiftPixels)}:min:${detail(thresholds.peakLiftPixels)}`);
  }

  return {
    positions,
    thresholds,
    groundReferenceY,
    peakLiftPixels,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
