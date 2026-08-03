import sharp from "sharp";
import { PET_CELL_HEIGHT, PET_CELL_WIDTH } from "./constants.js";
import { removeChroma, type ChromaRemovalResult } from "./chroma.js";
import { validateJumpingArc, type JumpingArcDiagnostics } from "./jumping.js";

export interface PixelBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

/** Longest uninterrupted foreground run along each slot border, in pixels. */
export interface BorderContactRuns {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** One enclosed transparent region fully surrounded by retained foreground. */
export interface EnclosedRegionDiagnostics {
  readonly pixels: number;
  /**
   * Centroid distance to the nearest silhouette bounding-box side, as a fraction
   * of the smaller bounding-box dimension. Reported for offline triage only: it
   * was evaluated as a way to tell a normal gap from a slice through the body and
   * does not separate them (both land at 0.20-0.29 on real boards), so no rule
   * reads it.
   */
  readonly insetRatio: number;
}

export interface ForegroundComponentDiagnostics {
  readonly pixels: number;
  readonly bounds: PixelBounds;
  readonly edgePixels: number;
}

export interface FrameDiagnostics {
  readonly index: number;
  readonly sourceBounds: PixelBounds | null;
  readonly opaquePixels: number;
  readonly edgePixels: number;
  readonly componentCount: number;
  readonly internalTransparentPixels: number;
  /** Fraction of the source slot removed (or softened) as the requested chroma key. */
  readonly chromaCoverage: number | null;
  readonly normalizedBounds: PixelBounds | null;
  /** Per-border contact detail. `edgePixels` alone cannot separate a real
   * clipped pose from a few pixels of neighbouring-slot bleed. */
  readonly borderContactRuns: BorderContactRuns;
  readonly enclosedRegions: readonly EnclosedRegionDiagnostics[];
  readonly foregroundComponents: readonly ForegroundComponentDiagnostics[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ExtractPoseBoardOptions {
  readonly columns: number;
  readonly rows: number;
  readonly frameCount: number;
  /** Chronological output index -> physical row-major source slot index. */
  readonly frameOrder?: readonly number[];
  readonly chromaKey: string;
  readonly chromaThreshold?: number;
  readonly chromaFeather?: number;
  /** Minimum keyed-background coverage required for every used source slot. */
  readonly minChromaCoverage?: number;
  /** Maximum keyed-background coverage allowed for every used source slot. */
  readonly maxChromaCoverage?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  readonly padding?: number;
  readonly requireUnusedSlotsEmpty?: boolean;
  /** Jumping opts into preserving source-board travel; ordinary poses are centred and grounded. */
  readonly allowVerticalTravel?: boolean;
  /** Opt-in five-frame semantic geometry gate; callers should enable it only for jumping. */
  readonly requireJumpingArc?: boolean;
  readonly maxHeightRatio?: number;
  readonly maxWidthRatio?: number;
  readonly maxBaselineSpreadPixels?: number;
  readonly maxCenterSpreadPixels?: number;
  /** Deliberate opt-in for character designs whose sprite has separate opaque islands. */
  readonly allowMultipleForegroundComponents?: boolean;
  /** Deliberate opt-in for designs with intentional enclosed negative space, such as a ring body. */
  readonly allowTransparentHoles?: boolean;
  /**
   * How aggressively per-frame cosmetic findings fail the whole board.
   *
   * A board verdict is the conjunction of every frame, so an 8-frame board only
   * passes when all 8 pass. A rule with a 3% per-frame false-positive rate
   * therefore fails ~22% of boards it should have accepted, and each rejection
   * costs a full paid regeneration of all 8 poses. `tolerant` keeps hard errors
   * for defects that provably break the atlas (empty frame, clipped pose, bad
   * chroma, unusable geometry) and reports cosmetic residue as warnings.
   */
  readonly frameStrictness?: FrameStrictness;
}

/**
 * `strict` fails a frame on any border contact, any extra opaque island and any
 * enclosed transparent area over 2% of the sprite. Useful for regression tests
 * and for re-auditing a board offline, but too brittle to gate paid generation.
 */
export type FrameStrictness = "strict" | "tolerant";

export const DEFAULT_FRAME_STRICTNESS: FrameStrictness = "tolerant";

/**
 * Tolerant-mode thresholds. Calibrated against 84 real frames from the
 * `老鼠猫` incident, where 44 frames touched a slot border with a median of
 * 0.065% of the sprite's own pixel count and no visible defect, while a
 * genuinely clipped pose contacts a border along tens of percent of its length.
 */
export const FRAME_TOLERANCE = {
  /**
   * Border contact fails only past this fraction of that border's length.
   * Measured: benign contact (a paw resting on the baseline) peaks at 12.1% of
   * the border, while a deliberately clipped pose runs 50-61%. 30% sits in the
   * empty band between the two.
   */
  maxBorderRunFraction: 0.3,
  /** ...or past this fraction of the sprite's own pixel count, whichever hits first. */
  maxBorderContactFraction: 0.006,
  /** An extra island this small relative to the sprite may be neighbour bleed... */
  maxBleedComponentFraction: 0.03,
  /** ...if it also stays within this fraction of the slot, measured inward from
   * the border it touches. Slot boundaries are pure arithmetic divisions with no
   * printed gutter, so an adjacent pose routinely spills a few pixels across. */
  maxBleedComponentDepthFraction: 0.08,
  /**
   * Total enclosed transparent area above this fraction of the sprite is a hard
   * error. Measured: anatomically normal gaps in a running quadruped (the arch
   * under an extended stride, the loop of a curled tail) reach 4.1% of the
   * sprite, while a sliced-open body leaves 19%. Region inset was tried as a
   * second discriminator and dropped: normal gaps and suspicious ones both sit
   * at 0.20-0.29, so it separates nothing.
   */
  maxTotalEnclosedFraction: 0.08,
} as const;

export interface FrameInspectionOptions {
  readonly allowMultipleForegroundComponents?: boolean;
  readonly allowTransparentHoles?: boolean;
  readonly frameStrictness?: FrameStrictness;
}

export interface PoseBoardGeometryDiagnostics {
  readonly heightRatio: number | null;
  readonly widthRatio: number | null;
  readonly baselineSpreadPixels: number | null;
  readonly centerSpreadPixels: number | null;
  readonly warnings: readonly string[];
}

export interface ExtractPoseBoardResult {
  readonly frames: readonly Buffer[];
  readonly diagnostics: readonly FrameDiagnostics[];
  readonly unusedSlotOpaquePixels: readonly number[];
  readonly chroma: readonly Omit<ChromaRemovalResult, "image">[];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sharedScale: number;
  readonly geometry: PoseBoardGeometryDiagnostics;
  readonly jumpingArc: JumpingArcDiagnostics | null;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface FullPoseBoardRegistrationInput {
  readonly input: Buffer;
  readonly columns: number;
  readonly rows: number;
  /** Shared registration is intentionally limited to full boards. */
  readonly frameCount: number;
}

export interface SharedPoseBoardRegistrationResult {
  readonly framesByBoard: readonly (readonly Buffer[])[];
  readonly diagnosticsByBoard: readonly (readonly FrameDiagnostics[])[];
  readonly sourceBoardSizes: readonly { readonly width: number; readonly height: number }[];
  readonly sharedScale: number;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface AlphaAnalysis {
  readonly bounds: PixelBounds | null;
  readonly opaquePixels: number;
  readonly edgePixels: number;
  readonly componentCount: number;
  readonly internalTransparentPixels: number;
  readonly borderContactRuns: BorderContactRuns;
  readonly enclosedRegions: readonly EnclosedRegionDiagnostics[];
  readonly components: readonly ForegroundComponentDiagnostics[];
  /**
   * Neighbour-bleed slivers erased under `dropNeighbourBleed`. They are gone
   * from every other field, so the caller reports the finding from this count.
   */
  readonly removedBleedComponentCount: number;
  /** Source image with only proven detached generation residue removed. */
  readonly cleanedImage: Buffer | null;
}

const NO_BORDER_CONTACT: BorderContactRuns = { left: 0, right: 0, top: 0, bottom: 0 };

function emptyAlphaAnalysis(): AlphaAnalysis {
  return {
    bounds: null,
    opaquePixels: 0,
    edgePixels: 0,
    componentCount: 0,
    internalTransparentPixels: 0,
    borderContactRuns: NO_BORDER_CONTACT,
    enclosedRegions: [],
    components: [],
    removedBleedComponentCount: 0,
    cleanedImage: null,
  };
}

/** Longest run of set mask values along one border walk. */
function longestRun(length: number, isSet: (offset: number) => boolean): number {
  let longest = 0;
  let current = 0;
  for (let offset = 0; offset < length; offset += 1) {
    current = isSet(offset) ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Longest border contact run of the primary subject. Measured per label rather
 * than on the merged mask: a neighbour-bleed sliver sitting on a border would
 * otherwise report a long run and re-raise the edge error that the component
 * rule just demoted, failing the frame for pixels nobody objects to.
 */
function measureBorderContactRuns(
  labels: Int32Array,
  primaryLabel: number,
  width: number,
  height: number,
): BorderContactRuns {
  const belongs = (index: number) => labels[index] === primaryLabel;
  return {
    left: longestRun(height, (y) => belongs(indexOf(0, y, width))),
    right: longestRun(height, (y) => belongs(indexOf(width - 1, y, width))),
    top: longestRun(width, (x) => belongs(indexOf(x, 0, width))),
    bottom: longestRun(width, (x) => belongs(indexOf(x, height - 1, width))),
  };
}

interface AlphaComponent {
  readonly label: number;
  readonly pixels: number;
  readonly bounds: PixelBounds;
  readonly edgePixels: number;
}

function indexOf(x: number, y: number, width: number): number {
  return y * width + x;
}

function axisGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd - 1;
  if (bEnd < aStart) return aStart - bEnd - 1;
  return 0;
}

function isDetachedLineResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.02) return false;

  const shortSide = Math.min(component.bounds.width, component.bounds.height);
  const longSide = Math.max(component.bounds.width, component.bounds.height);
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  if (shortSide > Math.max(3, Math.floor(canvasShortSide * 0.025))) return false;
  if (longSide > Math.max(12, Math.floor(canvasShortSide * 0.12))) return false;
  if (longSide / shortSide < 3) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  return Math.max(horizontalGap, verticalGap) >= Math.max(3, Math.floor(canvasShortSide * 0.008));
}

function isDetachedSpeckResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.005) return false;

  const shortSide = Math.min(component.bounds.width, component.bounds.height);
  const longSide = Math.max(component.bounds.width, component.bounds.height);
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  const maximumSide = Math.max(8, Math.floor(canvasShortSide * 0.04));
  if (longSide > maximumSide || longSide / shortSide > 2) return false;

  const fillRatio = component.pixels / (component.bounds.width * component.bounds.height);
  if (fillRatio < 0.3) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  return Math.max(horizontalGap, verticalGap) >= Math.max(5, Math.floor(canvasShortSide * 0.025));
}

function isDetachedPartialDuplicateResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;

  const pixelRatio = component.pixels / primary.pixels;
  const widthRatio = component.bounds.width / primary.bounds.width;
  const heightRatio = component.bounds.height / primary.bounds.height;
  if (pixelRatio < 0.25 || pixelRatio > 0.65
    || widthRatio < 0.75 || widthRatio > 1.2
    || heightRatio < 0.3 || heightRatio > 0.65) {
    return false;
  }

  const primaryCenterX = primary.bounds.left + (primary.bounds.width - 1) / 2;
  const componentCenterX = component.bounds.left + (component.bounds.width - 1) / 2;
  if (Math.abs(primaryCenterX - componentCenterX) > primary.bounds.width * 0.15) return false;

  const horizontalGap = axisGap(
    component.bounds.left,
    component.bounds.right,
    primary.bounds.left,
    primary.bounds.right,
  );
  const verticalGap = axisGap(
    component.bounds.top,
    component.bounds.bottom,
    primary.bounds.top,
    primary.bounds.bottom,
  );
  const canvasShortSide = Math.min(canvasWidth, canvasHeight);
  return horizontalGap === 0
    && verticalGap >= Math.max(5, Math.floor(canvasShortSide * 0.025))
    && verticalGap <= primary.bounds.height * 0.35;
}

function isDetachedLayoutGuideResidue(
  component: AlphaComponent,
  primary: AlphaComponent,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (component.label === primary.label || component.edgePixels > 0) return false;
  if (component.pixels > primary.pixels * 0.25) return false;
  if (component.bounds.width < canvasWidth * 0.75 || component.bounds.height < canvasHeight * 0.75) return false;
  const fillRatio = component.pixels / (component.bounds.width * component.bounds.height);
  if (fillRatio > 0.08) return false;
  return component.bounds.left < primary.bounds.left
    && component.bounds.right > primary.bounds.right
    && component.bounds.top < primary.bounds.top
    && component.bounds.bottom > primary.bounds.bottom;
}

function detachedDuplicateFragmentLabels(
  components: readonly AlphaComponent[],
  primary: AlphaComponent,
  canvasWidth: number,
): ReadonlySet<number> {
  const minimumGap = Math.max(
    8,
    Math.floor(canvasWidth * 0.06),
    Math.floor(primary.bounds.width * 0.18),
  );
  const candidates = components.filter((component) => (
    component.label !== primary.label
    && component.edgePixels === 0
    && component.pixels <= primary.pixels * 0.14
    && component.bounds.width <= primary.bounds.width * 0.65
    && component.bounds.height <= primary.bounds.height * 0.45
  ));
  const groups = [
    candidates.filter((component) => component.bounds.left - primary.bounds.right - 1 >= minimumGap),
    candidates.filter((component) => primary.bounds.left - component.bounds.right - 1 >= minimumGap),
  ];
  for (const group of groups) {
    if (group.length < 2) continue;
    const totalPixels = group.reduce((sum, component) => sum + component.pixels, 0);
    if (totalPixels > primary.pixels * 0.32) continue;
    const top = Math.min(...group.map((component) => component.bounds.top));
    const bottom = Math.max(...group.map((component) => component.bounds.bottom));
    if (bottom - top + 1 < primary.bounds.height * 0.28) continue;
    return new Set(group.map((component) => component.label));
  }
  return new Set();
}

interface AnalyzeAlphaOptions {
  readonly minAlpha?: number;
  /**
   * Erase shallow neighbour-bleed slivers instead of merely retaining them.
   *
   * Only meaningful for a raw board slot, where the slot border is an arithmetic
   * division shared with the adjacent pose. A retained sliver would otherwise
   * widen `bounds`, skew the row's shared scale and survive into the atlas cell,
   * where — now sitting away from the cell border — it no longer matches the
   * bleed signature and re-raises as a hard error on the assembled sheet.
   */
  readonly dropNeighbourBleed?: boolean;
}

async function analyzeAlpha(input: Buffer, options: AnalyzeAlphaOptions = {}): Promise<AlphaAnalysis> {
  const minAlpha = options.minAlpha ?? 24;
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const mask = new Uint8Array(width * height);
  let rawOpaquePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(indexOf(x, y, width) * info.channels) + 3]!;
      if (alpha < minAlpha) continue;
      mask[indexOf(x, y, width)] = 1;
      rawOpaquePixels += 1;
    }
  }
  if (rawOpaquePixels === 0) return emptyAlphaAnalysis();

  const visited = new Uint8Array(mask.length);
  const labels = new Int32Array(mask.length);
  const retainedMask = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const componentFloor = Math.max(12, Math.floor(rawOpaquePixels * 0.001));
  const components: AlphaComponent[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const seed = indexOf(x, y, width);
      if (!mask[seed] || visited[seed]) continue;
      let head = 0;
      let tail = 0;
      let componentLeft = width;
      let componentRight = -1;
      let componentTop = height;
      let componentBottom = -1;
      let componentEdgePixels = 0;
      const label = components.length + 1;
      queue[tail++] = seed;
      visited[seed] = 1;
      labels[seed] = label;
      while (head < tail) {
        const current = queue[head++]!;
        const cx = current % width;
        const cy = Math.floor(current / width);
        componentLeft = Math.min(componentLeft, cx);
        componentRight = Math.max(componentRight, cx);
        componentTop = Math.min(componentTop, cy);
        componentBottom = Math.max(componentBottom, cy);
        if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) componentEdgePixels += 1;
        const neighbors = [
          cx > 0 ? current - 1 : -1,
          cx + 1 < width ? current + 1 : -1,
          cy > 0 ? current - width : -1,
          cy + 1 < height ? current + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
          visited[neighbor] = 1;
          labels[neighbor] = label;
          queue[tail++] = neighbor;
        }
      }
      components.push({
        label,
        pixels: tail,
        bounds: {
          left: componentLeft,
          top: componentTop,
          right: componentRight,
          bottom: componentBottom,
          width: componentRight - componentLeft + 1,
          height: componentBottom - componentTop + 1,
        },
        edgePixels: componentEdgePixels,
      });
    }
  }

  const eligibleComponents = components.filter((component) => component.pixels >= componentFloor);
  const primary = eligibleComponents.reduce<AlphaComponent | null>(
    (largest, component) => !largest || component.pixels > largest.pixels ? component : largest,
    null,
  );
  const duplicateFragmentLabels = primary
    ? detachedDuplicateFragmentLabels(eligibleComponents, primary, width)
    : new Set<number>();
  const survivingComponents = primary
    ? eligibleComponents.filter((component) => (
        !isDetachedLineResidue(component, primary, width, height)
        && !isDetachedSpeckResidue(component, primary, width, height)
        && !isDetachedPartialDuplicateResidue(component, primary, width, height)
        && !isDetachedLayoutGuideResidue(component, primary, width, height)
        && !duplicateFragmentLabels.has(component.label)
      ))
    : [];
  const bleedComponents = options.dropNeighbourBleed && primary
    ? survivingComponents.filter((component) => (
        component.label !== primary.label
        && looksLikeNeighbourBleed(component, primary, width, height)
      ))
    : [];
  const bleedLabels = new Set(bleedComponents.map((component) => component.label));
  const retainedComponents = survivingComponents.filter((component) => !bleedLabels.has(component.label));
  const removedBleedComponentCount = bleedComponents.length;
  const retainedLabels = new Set(retainedComponents.map((component) => component.label));
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  const opaquePixels = retainedComponents.reduce((total, component) => total + component.pixels, 0);
  const edgePixels = retainedComponents.reduce((total, component) => total + component.edgePixels, 0);
  const componentCount = retainedComponents.length;
  for (const component of retainedComponents) {
    left = Math.min(left, component.bounds.left);
    right = Math.max(right, component.bounds.right);
    top = Math.min(top, component.bounds.top);
    bottom = Math.max(bottom, component.bounds.bottom);
  }
  let removedComponentPixels = 0;
  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    if (!mask[pixelIndex]) continue;
    if (retainedLabels.has(labels[pixelIndex]!)) {
      retainedMask[pixelIndex] = 1;
      continue;
    }
    removedComponentPixels += 1;
    const offset = pixelIndex * info.channels;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }
  if (opaquePixels === 0) return emptyAlphaAnalysis();

  // Flood transparent pixels from the foreground bounding-box edge; remaining transparent pixels are holes.
  const transparentVisited = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  const pushTransparent = (x: number, y: number) => {
    const index = indexOf(x, y, width);
    if (retainedMask[index] || transparentVisited[index]) return;
    transparentVisited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = left; x <= right; x += 1) {
    pushTransparent(x, top);
    pushTransparent(x, bottom);
  }
  for (let y = top; y <= bottom; y += 1) {
    pushTransparent(left, y);
    pushTransparent(right, y);
  }
  while (head < tail) {
    const current = queue[head++]!;
    const cx = current % width;
    const cy = Math.floor(current / width);
    const neighbors = [
      cx > left ? current - 1 : -1,
      cx < right ? current + 1 : -1,
      cy > top ? current - width : -1,
      cy < bottom ? current + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || transparentVisited[neighbor] || retainedMask[neighbor]) continue;
      transparentVisited[neighbor] = 1;
      queue[tail++] = neighbor;
    }
  }
  // Group the enclosed transparent pixels into regions. The total alone cannot
  // tell one wide slice through a filled body from several small anatomical
  // gaps, and those two cases deserve opposite verdicts.
  const boundsWidth = right - left + 1;
  const boundsHeight = bottom - top + 1;
  const shorterBoundsSide = Math.max(1, Math.min(boundsWidth, boundsHeight));
  const regionVisited = new Uint8Array(mask.length);
  const enclosedRegions: EnclosedRegionDiagnostics[] = [];
  let internalTransparentPixels = 0;
  const isEnclosed = (index: number): boolean => !retainedMask[index] && !transparentVisited[index];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const seed = indexOf(x, y, width);
      if (!isEnclosed(seed) || regionVisited[seed]) continue;
      let head = 0;
      let tail = 0;
      let sumX = 0;
      let sumY = 0;
      queue[tail++] = seed;
      regionVisited[seed] = 1;
      while (head < tail) {
        const current = queue[head++]!;
        const cx = current % width;
        const cy = Math.floor(current / width);
        sumX += cx;
        sumY += cy;
        const neighbors = [
          cx > left ? current - 1 : -1,
          cx < right ? current + 1 : -1,
          cy > top ? current - width : -1,
          cy < bottom ? current + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || regionVisited[neighbor] || !isEnclosed(neighbor)) continue;
          regionVisited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      internalTransparentPixels += tail;
      const centroidX = sumX / tail;
      const centroidY = sumY / tail;
      const insetPixels = Math.min(centroidX - left, right - centroidX, centroidY - top, bottom - centroidY);
      enclosedRegions.push({ pixels: tail, insetRatio: insetPixels / shorterBoundsSide });
    }
  }
  enclosedRegions.sort((a, b) => b.pixels - a.pixels);
  return {
    bounds: { left, top, right, bottom, width: boundsWidth, height: boundsHeight },
    opaquePixels,
    edgePixels,
    componentCount,
    internalTransparentPixels,
    borderContactRuns: measureBorderContactRuns(
      labels,
      retainedComponents.reduce((best, component) => (
        !best || component.pixels > best.pixels ? component : best
      ), null as AlphaComponent | null)?.label ?? -1,
      width,
      height,
    ),
    enclosedRegions,
    components: retainedComponents.map((component) => ({
      pixels: component.pixels,
      bounds: component.bounds,
      edgePixels: component.edgePixels,
    })),
    removedBleedComponentCount,
    cleanedImage: removedComponentPixels > 0
      ? await sharp(data, { raw: { width, height, channels: info.channels } }).png().toBuffer()
      : null,
  };
}

interface FrameFinding {
  readonly code: string;
  readonly severity: "error" | "warning";
}

/**
 * Does this extra island look like a neighbouring pose bleeding over the slot
 * boundary rather than a defect in this pose?
 *
 * Slot boundaries are arithmetic divisions of the source board with no printed
 * gutter, so a wide adjacent pose commonly leaves a shallow sliver against the
 * shared border. A genuine second subject, a severed limb or a stray effect
 * either sits away from the border or is far too large to qualify.
 *
 * A match is erased from the slot (see `dropNeighbourBleed`), not just demoted:
 * carrying it forward widens the crop and hands the assembled atlas a second
 * component that no longer looks like bleed, which fails the whole sheet.
 */
function looksLikeNeighbourBleed(
  component: ForegroundComponentDiagnostics,
  primary: ForegroundComponentDiagnostics,
  slotWidth: number,
  slotHeight: number,
): boolean {
  if (component === primary || component.edgePixels === 0 || primary.pixels === 0) return false;
  if (component.pixels > primary.pixels * FRAME_TOLERANCE.maxBleedComponentFraction) return false;
  const depths: number[] = [];
  if (component.bounds.left === 0) depths.push(component.bounds.right + 1);
  if (component.bounds.right === slotWidth - 1) depths.push(slotWidth - component.bounds.left);
  if (component.bounds.top === 0) depths.push(component.bounds.bottom + 1);
  if (component.bounds.bottom === slotHeight - 1) depths.push(slotHeight - component.bounds.top);
  if (depths.length === 0) return false;
  const horizontalLimit = slotWidth * FRAME_TOLERANCE.maxBleedComponentDepthFraction;
  const verticalLimit = slotHeight * FRAME_TOLERANCE.maxBleedComponentDepthFraction;
  return Math.min(...depths) <= Math.max(horizontalLimit, verticalLimit);
}

/**
 * Grade the three cosmetic findings that historically failed whole boards.
 *
 * `strict` reproduces the original zero-tolerance behaviour. `tolerant` keeps
 * the same detectors but demands evidence proportional to the cost of a false
 * positive: one rejected frame discards seven good ones and bills another full
 * board.
 */
function classifyFrameFindings(
  analysis: Pick<AlphaAnalysis, "opaquePixels" | "edgePixels" | "componentCount" | "internalTransparentPixels" | "borderContactRuns" | "enclosedRegions" | "components" | "removedBleedComponentCount">,
  slotWidth: number,
  slotHeight: number,
  options: {
    readonly strictness: FrameStrictness;
    readonly allowMultipleForegroundComponents?: boolean;
    readonly allowTransparentHoles?: boolean;
    readonly edgeContactCode: string;
  },
): readonly FrameFinding[] {
  const findings: FrameFinding[] = [];
  const strict = options.strictness === "strict";

  if (analysis.edgePixels > 0) {
    const runs = analysis.borderContactRuns;
    const longestVerticalRun = Math.max(runs.left, runs.right);
    const longestHorizontalRun = Math.max(runs.top, runs.bottom);
    const clipped = longestVerticalRun > slotHeight * FRAME_TOLERANCE.maxBorderRunFraction
      || longestHorizontalRun > slotWidth * FRAME_TOLERANCE.maxBorderRunFraction
      || analysis.edgePixels > analysis.opaquePixels * FRAME_TOLERANCE.maxBorderContactFraction;
    findings.push({ code: options.edgeContactCode, severity: strict || clipped ? "error" : "warning" });
  }

  if (analysis.componentCount > 1) {
    const primary = analysis.components.reduce<ForegroundComponentDiagnostics | null>(
      (largest, component) => !largest || component.pixels > largest.pixels ? component : largest,
      null,
    );
    const onlyNeighbourBleed = !strict
      && Boolean(primary)
      && analysis.components.every((component) => (
        component === primary || looksLikeNeighbourBleed(component, primary!, slotWidth, slotHeight)
      ));
    findings.push({
      code: "multiple-foreground-components",
      severity: options.allowMultipleForegroundComponents || onlyNeighbourBleed ? "warning" : "error",
    });
  } else if (analysis.removedBleedComponentCount > 0) {
    // The sliver is already erased, so nothing downstream can see it. Report it
    // anyway: silently dropping pixels is exactly the failure mode that made
    // this pipeline hard to debug.
    findings.push({ code: "multiple-foreground-components", severity: "warning" });
  }

  if (analysis.internalTransparentPixels > Math.max(16, analysis.opaquePixels * 0.02)) {
    const slicedBody = analysis.internalTransparentPixels
      > analysis.opaquePixels * FRAME_TOLERANCE.maxTotalEnclosedFraction;
    findings.push({
      code: "possible-transparent-holes",
      severity: options.allowTransparentHoles ? "warning" : strict || slicedBody ? "error" : "warning",
    });
  }

  return findings;
}

async function transparentCanvas(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

export async function extractPoseBoard(
  input: Buffer,
  options: ExtractPoseBoardOptions,
): Promise<ExtractPoseBoardResult> {
  if (!Number.isInteger(options.columns) || options.columns < 1 || !Number.isInteger(options.rows) || options.rows < 1) {
    throw new Error("Board columns and rows must be positive integers");
  }
  const slotCount = options.columns * options.rows;
  if (!Number.isInteger(options.frameCount) || options.frameCount < 1 || options.frameCount > slotCount) {
    throw new Error("frameCount must fit inside the board grid");
  }
  const frameOrder = options.frameOrder ?? Array.from({ length: options.frameCount }, (_, index) => index);
  if (frameOrder.length !== options.frameCount
    || new Set(frameOrder).size !== options.frameCount
    || frameOrder.some((index) => !Number.isInteger(index) || index < 0 || index >= options.frameCount)) {
    throw new Error("frameOrder must be a permutation of every used source slot");
  }
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Pose board has no readable dimensions");
  const cellWidth = options.cellWidth ?? PET_CELL_WIDTH;
  const cellHeight = options.cellHeight ?? PET_CELL_HEIGHT;
  if (!Number.isInteger(cellWidth) || cellWidth < 1 || !Number.isInteger(cellHeight) || cellHeight < 1) {
    throw new Error("Normalized cell width and height must be positive integers");
  }
  const requestedPadding = options.padding ?? 12;
  if (!Number.isFinite(requestedPadding) || requestedPadding < 0) throw new Error("Padding must be a non-negative number");
  const padding = Math.max(2, Math.floor(requestedPadding));
  if (padding * 2 + 2 >= cellWidth || padding * 2 + 2 >= cellHeight) {
    throw new Error("Padding leaves no usable normalized cell area");
  }
  const minChromaCoverage = options.minChromaCoverage ?? 0.08;
  const maxChromaCoverage = options.maxChromaCoverage ?? 0.985;
  if (!Number.isFinite(minChromaCoverage) || !Number.isFinite(maxChromaCoverage)
    || minChromaCoverage < 0 || maxChromaCoverage > 1 || minChromaCoverage >= maxChromaCoverage) {
    throw new Error("Chroma coverage thresholds must satisfy 0 <= min < max <= 1");
  }
  const strictness = options.frameStrictness ?? DEFAULT_FRAME_STRICTNESS;
  const maxHeightRatio = options.maxHeightRatio ?? 1.45;
  const maxWidthRatio = options.maxWidthRatio ?? 1.8;
  const maxBaselineSpreadPixels = options.maxBaselineSpreadPixels ?? 18;
  const maxCenterSpreadPixels = options.maxCenterSpreadPixels ?? 24;
  if (![maxHeightRatio, maxWidthRatio].every((value) => Number.isFinite(value) && value >= 1)
    || ![maxBaselineSpreadPixels, maxCenterSpreadPixels].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Pose geometry thresholds must use ratios >= 1 and pixel spreads >= 0");
  }
  const cleanedSlots: Buffer[] = [];
  const analyses: AlphaAnalysis[] = [];
  const slotWidths: number[] = [];
  const slotHeights: number[] = [];
  const chroma: Omit<ChromaRemovalResult, "image">[] = [];

  for (let index = 0; index < slotCount; index += 1) {
    const column = index % options.columns;
    const row = Math.floor(index / options.columns);
    const left = Math.floor(column * metadata.width / options.columns);
    const right = Math.floor((column + 1) * metadata.width / options.columns);
    const top = Math.floor(row * metadata.height / options.rows);
    const bottom = Math.floor((row + 1) * metadata.height / options.rows);
    const tile = await sharp(input).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
    const result = await removeChroma(tile, {
      key: options.chromaKey,
      threshold: options.chromaThreshold,
      feather: options.chromaFeather,
    });
    // Bleed removal is a slot-only concern: the slot border is shared with the
    // adjacent pose, whereas a normalized cell keeps padding on every side, so
    // anything touching its border is a real overflow the safe-margin check owns.
    const analysis = await analyzeAlpha(result.image, { dropNeighbourBleed: strictness !== "strict" });
    cleanedSlots.push(analysis.cleanedImage ?? result.image);
    slotWidths.push(right - left);
    slotHeights.push(bottom - top);
    analyses.push(analysis);
    const { image: _image, ...report } = result;
    chroma.push(report);
  }

  const usedAnalyses = frameOrder.map((sourceIndex) => analyses[sourceIndex]!);
  const usedCleanedSlots = frameOrder.map((sourceIndex) => cleanedSlots[sourceIndex]!);
  const usedSlotWidths = frameOrder.map((sourceIndex) => slotWidths[sourceIndex]!);
  const usedSlotHeights = frameOrder.map((sourceIndex) => slotHeights[sourceIndex]!);
  const usedChroma = frameOrder.map((sourceIndex) => chroma[sourceIndex]!);
  // Every pose is resized exactly once with one shared scale. Horizontal
  // placement inside an implicit model-drawn grid is always discarded because
  // row/column gutter drift is layout noise, not animation travel. Ordinary
  // actions are also grounded; jumping preserves only its relative vertical
  // lift/peak/descent while remaining horizontally centred.
  const preserveVerticalTravel = options.allowVerticalTravel === true;
  const positioned = usedAnalyses.map((analysis, index) => {
    if (!analysis.bounds) return null;
    const bottomGap = usedSlotHeights[index]! - 1 - analysis.bounds.bottom;
    return {
      left: analysis.bounds.left - usedSlotWidths[index]! / 2,
      right: analysis.bounds.right - usedSlotWidths[index]! / 2,
      bottomGap,
      width: analysis.bounds.width,
      height: analysis.bounds.height,
    };
  });
  const nonempty = positioned.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const groundGap = nonempty.length ? Math.min(...nonempty.map((item) => item.bottomGap)) : 0;
  const relative = positioned.map((item) => item ? {
    ...item,
    left: -(item.width - 1) / 2,
    right: (item.width - 1) / 2,
    ...(preserveVerticalTravel ? {
      top: -(item.bottomGap - groundGap) - (item.height - 1),
      bottom: -(item.bottomGap - groundGap),
    } : {
      top: -(item.height - 1),
      bottom: 0,
    }),
  } : null);
  const placed = relative.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const minLeft = placed.length ? Math.min(...placed.map((item) => item.left)) : 0;
  const maxRight = placed.length ? Math.max(...placed.map((item) => item.right)) : 0;
  const minTop = placed.length ? Math.min(...placed.map((item) => item.top)) : 0;
  const maxBottom = placed.length ? Math.max(...placed.map((item) => item.bottom)) : 0;
  const sharedWidth = Math.max(1, maxRight - minLeft + 1);
  const sharedHeight = Math.max(1, maxBottom - minTop + 1);
  // Keep a one-pixel rounding reserve on every side. Sharp rounds resized
  // dimensions while placement rounds coordinates, so using the exact
  // mathematical span can otherwise land an edge one pixel outside padding.
  const sharedScale = Math.min(
    (cellWidth - padding * 2 - 2) / sharedWidth,
    (cellHeight - padding * 2 - 2) / sharedHeight,
  );
  const horizontalOrigin = (cellWidth - 1) / 2 - ((minLeft + maxRight) / 2) * sharedScale;
  const baseline = cellHeight - padding - 1 - maxBottom * sharedScale;
  const frames: Buffer[] = [];
  const diagnostics: FrameDiagnostics[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < options.frameCount; index += 1) {
    const analysis = usedAnalyses[index]!;
    const chromaReport = usedChroma[index]!;
    const chromaCoverage = chromaReport.totalPixels > 0
      ? (chromaReport.removedPixels + chromaReport.softenedPixels) / chromaReport.totalPixels
      : 0;
    const frameErrors: string[] = [];
    const frameWarnings: string[] = [];
    if (chromaCoverage < minChromaCoverage) {
      frameErrors.push(`chroma-coverage-too-low:${chromaCoverage.toFixed(4)}:min:${minChromaCoverage.toFixed(4)}`);
    }
    if (chromaCoverage > maxChromaCoverage) {
      frameErrors.push(`chroma-coverage-too-high:${chromaCoverage.toFixed(4)}:max:${maxChromaCoverage.toFixed(4)}`);
    }
    if (!analysis.bounds) {
      frameErrors.push("empty-frame");
      frames.push(await transparentCanvas(cellWidth, cellHeight));
    } else {
      for (const finding of classifyFrameFindings(analysis, usedSlotWidths[index]!, usedSlotHeights[index]!, {
        strictness,
        allowMultipleForegroundComponents: options.allowMultipleForegroundComponents,
        allowTransparentHoles: options.allowTransparentHoles,
        edgeContactCode: "source-touches-slot-edge",
      })) {
        (finding.severity === "error" ? frameErrors : frameWarnings).push(finding.code);
      }
      const targetWidth = Math.max(1, Math.round(analysis.bounds.width * sharedScale));
      const targetHeight = Math.max(1, Math.round(analysis.bounds.height * sharedScale));
      const cropped = await sharp(usedCleanedSlots[index]!).extract({
        left: analysis.bounds.left,
        top: analysis.bounds.top,
        width: analysis.bounds.width,
        height: analysis.bounds.height,
      }).resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 }).png().toBuffer();
      const registration = relative[index]!;
      const left = preserveVerticalTravel
        ? Math.round(horizontalOrigin + registration.left * sharedScale)
        : Math.round((cellWidth - targetWidth) / 2);
      const top = preserveVerticalTravel
        ? Math.round(baseline + registration.top * sharedScale)
        : cellHeight - padding - targetHeight;
      if (left < padding || top < padding || left + targetWidth > cellWidth - padding || top + targetHeight > cellHeight - padding) {
        frameErrors.push("normalized-frame-outside-safe-margin");
      }
      frames.push(await sharp({
        create: { width: cellWidth, height: cellHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      }).composite([{ input: cropped, left, top }]).png().toBuffer());
    }
    const normalized = await analyzeAlpha(frames[index]!);
    const diagnostic: FrameDiagnostics = {
      index,
      sourceBounds: analysis.bounds,
      opaquePixels: analysis.opaquePixels,
      edgePixels: analysis.edgePixels,
      componentCount: analysis.componentCount,
      internalTransparentPixels: analysis.internalTransparentPixels,
      chromaCoverage,
      normalizedBounds: normalized.bounds,
      borderContactRuns: analysis.borderContactRuns,
      enclosedRegions: analysis.enclosedRegions,
      foregroundComponents: analysis.components,
      errors: frameErrors,
      warnings: frameWarnings,
    };
    diagnostics.push(diagnostic);
    errors.push(...frameErrors.map((error) => `frame-${index}:${error}`));
    warnings.push(...frameWarnings.map((warning) => `frame-${index}:${warning}`));
  }

  const normalizedBounds = diagnostics
    .map((diagnostic) => diagnostic.normalizedBounds)
    .filter((bounds): bounds is PixelBounds => Boolean(bounds));
  const spread = (values: readonly number[]): number | null => values.length >= 2
    ? Math.max(...values) - Math.min(...values)
    : null;
  const ratio = (values: readonly number[]): number | null => {
    if (values.length < 2) return null;
    const smallest = Math.min(...values);
    return smallest > 0 ? Math.max(...values) / smallest : null;
  };
  const heightRatio = ratio(normalizedBounds.map((bounds) => bounds.height));
  const widthRatio = ratio(normalizedBounds.map((bounds) => bounds.width));
  const baselineSpreadPixels = spread(normalizedBounds.map((bounds) => bounds.bottom));
  const centerSpreadPixels = spread(normalizedBounds.map((bounds) => bounds.left + (bounds.width - 1) / 2));
  const geometryWarnings: string[] = [];
  if (heightRatio !== null && heightRatio > maxHeightRatio) {
    geometryWarnings.push(`geometry:height-ratio:${heightRatio.toFixed(3)}:max:${maxHeightRatio.toFixed(3)}`);
  }
  if (widthRatio !== null && widthRatio > maxWidthRatio) {
    geometryWarnings.push(`geometry:width-ratio:${widthRatio.toFixed(3)}:max:${maxWidthRatio.toFixed(3)}`);
  }
  if (!options.allowVerticalTravel && baselineSpreadPixels !== null && baselineSpreadPixels > maxBaselineSpreadPixels) {
    geometryWarnings.push(`geometry:baseline-spread:${baselineSpreadPixels.toFixed(1)}:max:${maxBaselineSpreadPixels.toFixed(1)}`);
  }
  if (centerSpreadPixels !== null && centerSpreadPixels > maxCenterSpreadPixels) {
    geometryWarnings.push(`geometry:center-spread:${centerSpreadPixels.toFixed(1)}:max:${maxCenterSpreadPixels.toFixed(1)}`);
  }
  warnings.push(...geometryWarnings);

  const jumpingArc = options.requireJumpingArc ? await validateJumpingArc(frames) : null;
  if (jumpingArc) {
    errors.push(...jumpingArc.errors);
    warnings.push(...jumpingArc.warnings);
  }

  const unusedSlotOpaquePixels = analyses.slice(options.frameCount).map((analysis) => analysis.opaquePixels);
  if (options.requireUnusedSlotsEmpty !== false) {
    unusedSlotOpaquePixels.forEach((count, offset) => {
      if (count > 32) errors.push(`unused-slot-${options.frameCount + offset}:not-empty`);
    });
  }
  return {
    frames,
    diagnostics,
    unusedSlotOpaquePixels,
    chroma: [...usedChroma, ...chroma.slice(options.frameCount)],
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    sharedScale,
    geometry: {
      heightRatio,
      widthRatio,
      baselineSpreadPixels,
      centerSpreadPixels,
      warnings: geometryWarnings,
    },
    jumpingArc,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Normalize several complete pose boards in one source coordinate system.
 *
 * Direction rows are generated as two independent 4x2 images. Calling
 * `extractPoseBoard` on each row separately lets a wider profile pose in one
 * row choose a different fit scale from the other row, which becomes a visible
 * size/baseline pop at the 157.5°→180° seam. This helper losslessly tiles the
 * original source cells onto one chroma canvas and performs the only resize in
 * a single extraction pass, so every returned frame shares one scale and
 * baseline. Source boards may have different actual gateway dimensions; cells
 * are padded, never resized, before registration.
 */
export async function extractFullPoseBoardsWithSharedRegistration(
  boards: readonly FullPoseBoardRegistrationInput[],
  options: Omit<ExtractPoseBoardOptions, "columns" | "rows" | "frameCount" | "requireUnusedSlotsEmpty">,
): Promise<SharedPoseBoardRegistrationResult> {
  if (boards.length < 2) throw new Error("Shared pose registration requires at least two boards");
  const columns = boards[0]?.columns ?? 0;
  if (!Number.isInteger(columns) || columns < 1 || boards.some((board) => board.columns !== columns)) {
    throw new Error("Shared pose registration requires the same positive column count for every board");
  }
  for (const board of boards) {
    if (!Number.isInteger(board.rows) || board.rows < 1 || board.frameCount !== board.columns * board.rows) {
      throw new Error("Shared pose registration requires complete boards with every slot used");
    }
  }

  const metadata = await Promise.all(boards.map(async (board) => {
    const value = await sharp(board.input).metadata();
    if (!value.width || !value.height) throw new Error("Shared pose board has no readable dimensions");
    return { width: value.width, height: value.height };
  }));
  let slotWidth = 1;
  let slotHeight = 1;
  boards.forEach((board, boardIndex) => {
    const size = metadata[boardIndex]!;
    for (let column = 0; column < board.columns; column += 1) {
      slotWidth = Math.max(slotWidth, Math.floor((column + 1) * size.width / board.columns) - Math.floor(column * size.width / board.columns));
    }
    for (let row = 0; row < board.rows; row += 1) {
      slotHeight = Math.max(slotHeight, Math.floor((row + 1) * size.height / board.rows) - Math.floor(row * size.height / board.rows));
    }
  });

  const totalRows = boards.reduce((sum, board) => sum + board.rows, 0);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  let rowOffset = 0;
  for (let boardIndex = 0; boardIndex < boards.length; boardIndex += 1) {
    const board = boards[boardIndex]!;
    const size = metadata[boardIndex]!;
    for (let index = 0; index < board.columns * board.rows; index += 1) {
      const column = index % board.columns;
      const row = Math.floor(index / board.columns);
      const left = Math.floor(column * size.width / board.columns);
      const right = Math.floor((column + 1) * size.width / board.columns);
      const top = Math.floor(row * size.height / board.rows);
      const bottom = Math.floor((row + 1) * size.height / board.rows);
      const width = right - left;
      const height = bottom - top;
      const tile = await sharp(board.input)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      composites.push({
        input: tile,
        left: column * slotWidth + Math.floor((slotWidth - width) / 2),
        // A board returned at a different height still describes grounded
        // sprites relative to the bottom of each source slot. Bottom-aligning
        // the lossless source tile preserves that baseline; vertical centring
        // would incorrectly turn the padding difference into a jump.
        top: (rowOffset + row) * slotHeight + (slotHeight - height),
      });
    }
    rowOffset += board.rows;
  }

  const combined = await sharp({
    create: {
      width: columns * slotWidth,
      height: totalRows * slotHeight,
      channels: 4,
      background: options.chromaKey,
    },
  }).composite(composites).png().toBuffer();
  const extracted = await extractPoseBoard(combined, {
    ...options,
    columns,
    rows: totalRows,
    frameCount: columns * totalRows,
    requireUnusedSlotsEmpty: true,
  });
  const framesByBoard: Buffer[][] = [];
  const diagnosticsByBoard: FrameDiagnostics[][] = [];
  let cursor = 0;
  for (const board of boards) {
    framesByBoard.push(extracted.frames.slice(cursor, cursor + board.frameCount));
    diagnosticsByBoard.push(extracted.diagnostics.slice(cursor, cursor + board.frameCount));
    cursor += board.frameCount;
  }
  return {
    framesByBoard,
    diagnosticsByBoard,
    sourceBoardSizes: metadata,
    sharedScale: extracted.sharedScale,
    ok: extracted.ok,
    errors: extracted.errors,
    warnings: extracted.warnings,
  };
}

export interface SpliceSourcePoseBoardSlotsInput {
  /** Newest board; its dimensions define the output grid arithmetic. */
  readonly base: Buffer;
  /** Earlier board whose listed slots replace the base slots. */
  readonly donor: Buffer;
  readonly columns: number;
  readonly rows: number;
  /** Row-major physical source slot indexes to take from the donor. */
  readonly slots: readonly number[];
  readonly chromaKey: string;
}

/**
 * Replace individual *source* slots of a pose board with the same slots of an
 * earlier board, before any normalization.
 *
 * A rejected board is usually rejected for one or two cells; the rest are
 * production quality. Salvaging must happen here, at source-slot granularity,
 * and never by merging already-extracted frames: `extractPoseBoard` derives one
 * `sharedScale` and one baseline per board, so frames normalized from two boards
 * carry incompatible scales and produce the exact size/baseline pop that
 * `extractFullPoseBoardsWithSharedRegistration` exists to prevent. Splicing the
 * raw slots keeps a single later extraction pass as the only owner of scale and
 * registration for every frame.
 *
 * The donor is resized to the base dimensions when the gateway returned a
 * different size, because slot rectangles are pure proportional divisions of the
 * board: after that resize, slot `i` of the donor covers exactly slot `i` of the
 * base. Each replaced rectangle is first painted with the chroma key so donor
 * transparency cannot let base pixels show through.
 */
export async function spliceSourcePoseBoardSlots(input: SpliceSourcePoseBoardSlotsInput): Promise<Buffer> {
  if (!Number.isInteger(input.columns) || input.columns < 1 || !Number.isInteger(input.rows) || input.rows < 1) {
    throw new Error("Board columns and rows must be positive integers");
  }
  const slotCount = input.columns * input.rows;
  const slots = [...new Set(input.slots)].sort((left, right) => left - right);
  if (slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= slotCount)) {
    throw new Error("Spliced slot indexes must address the board grid");
  }
  if (slots.length === 0) return input.base;
  if (slots.length === slotCount) return input.donor;
  const baseMetadata = await sharp(input.base).metadata();
  if (!baseMetadata.width || !baseMetadata.height) throw new Error("Base pose board has no readable dimensions");
  const donorMetadata = await sharp(input.donor).metadata();
  if (!donorMetadata.width || !donorMetadata.height) throw new Error("Donor pose board has no readable dimensions");
  const alignedDonor = donorMetadata.width === baseMetadata.width && donorMetadata.height === baseMetadata.height
    ? input.donor
    : await sharp(input.donor)
      .resize(baseMetadata.width, baseMetadata.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const slot of slots) {
    const column = slot % input.columns;
    const row = Math.floor(slot / input.columns);
    const left = Math.floor(column * baseMetadata.width / input.columns);
    const right = Math.floor((column + 1) * baseMetadata.width / input.columns);
    const top = Math.floor(row * baseMetadata.height / input.rows);
    const bottom = Math.floor((row + 1) * baseMetadata.height / input.rows);
    const width = right - left;
    const height = bottom - top;
    const tile = await sharp(alignedDonor).extract({ left, top, width, height }).png().toBuffer();
    composites.push({
      input: await sharp({ create: { width, height, channels: 4, background: input.chromaKey } })
        .composite([{ input: tile, left: 0, top: 0 }])
        .png()
        .toBuffer(),
      left,
      top,
    });
  }
  return sharp(input.base).composite(composites).png().toBuffer();
}

export async function mirrorFramesPreservingOrder(frames: readonly Buffer[]): Promise<readonly Buffer[]> {
  return Promise.all(frames.map((frame) => sharp(frame).flop().png().toBuffer()));
}

export async function inspectFrame(
  input: Buffer,
  index = 0,
  options: FrameInspectionOptions = {},
): Promise<FrameDiagnostics> {
  const analysis = await analyzeAlpha(input);
  const metadata = await sharp(input).metadata();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!analysis.bounds) errors.push("empty-frame");
  for (const finding of classifyFrameFindings(analysis, metadata.width ?? PET_CELL_WIDTH, metadata.height ?? PET_CELL_HEIGHT, {
    strictness: options.frameStrictness ?? DEFAULT_FRAME_STRICTNESS,
    allowMultipleForegroundComponents: options.allowMultipleForegroundComponents,
    allowTransparentHoles: options.allowTransparentHoles,
    edgeContactCode: "touches-cell-edge",
  })) {
    (finding.severity === "error" ? errors : warnings).push(finding.code);
  }
  return {
    index,
    sourceBounds: analysis.bounds,
    normalizedBounds: analysis.bounds,
    opaquePixels: analysis.opaquePixels,
    edgePixels: analysis.edgePixels,
    componentCount: analysis.componentCount,
    internalTransparentPixels: analysis.internalTransparentPixels,
    chromaCoverage: null,
    borderContactRuns: analysis.borderContactRuns,
    enclosedRegions: analysis.enclosedRegions,
    foregroundComponents: analysis.components,
    errors,
    warnings,
  };
}
