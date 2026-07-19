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
}

export interface FrameInspectionOptions {
  readonly allowMultipleForegroundComponents?: boolean;
  readonly allowTransparentHoles?: boolean;
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
}

function indexOf(x: number, y: number, width: number): number {
  return y * width + x;
}

async function analyzeAlpha(input: Buffer, minAlpha = 24): Promise<AlphaAnalysis> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const mask = new Uint8Array(width * height);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let opaquePixels = 0;
  let edgePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(indexOf(x, y, width) * info.channels) + 3]!;
      if (alpha < minAlpha) continue;
      mask[indexOf(x, y, width)] = 1;
      opaquePixels += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgePixels += 1;
    }
  }
  if (opaquePixels === 0) {
    return { bounds: null, opaquePixels: 0, edgePixels: 0, componentCount: 0, internalTransparentPixels: 0 };
  }

  const visited = new Uint8Array(mask.length);
  const componentSizes: number[] = [];
  const queue = new Int32Array(mask.length);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const seed = indexOf(x, y, width);
      if (!mask[seed] || visited[seed]) continue;
      let head = 0;
      let tail = 0;
      let size = 0;
      queue[tail++] = seed;
      visited[seed] = 1;
      while (head < tail) {
        const current = queue[head++]!;
        size += 1;
        const cx = current % width;
        const cy = Math.floor(current / width);
        const neighbors = [
          cx > 0 ? current - 1 : -1,
          cx + 1 < width ? current + 1 : -1,
          cy > 0 ? current - width : -1,
          cy + 1 < height ? current + width : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      }
      componentSizes.push(size);
    }
  }
  const componentFloor = Math.max(12, Math.floor(opaquePixels * 0.001));
  const componentCount = componentSizes.filter((size) => size >= componentFloor).length;

  // Flood transparent pixels from the foreground bounding-box edge; remaining transparent pixels are holes.
  const transparentVisited = new Uint8Array(mask.length);
  let head = 0;
  let tail = 0;
  const pushTransparent = (x: number, y: number) => {
    const index = indexOf(x, y, width);
    if (mask[index] || transparentVisited[index]) return;
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
      if (neighbor < 0 || transparentVisited[neighbor] || mask[neighbor]) continue;
      transparentVisited[neighbor] = 1;
      queue[tail++] = neighbor;
    }
  }
  let internalTransparentPixels = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = indexOf(x, y, width);
      if (!mask[index] && !transparentVisited[index]) internalTransparentPixels += 1;
    }
  }
  return {
    bounds: { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 },
    opaquePixels,
    edgePixels,
    componentCount,
    internalTransparentPixels,
  };
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
    cleanedSlots.push(result.image);
    slotWidths.push(right - left);
    slotHeights.push(bottom - top);
    analyses.push(await analyzeAlpha(result.image));
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
      if (analysis.edgePixels > 0) frameErrors.push("source-touches-slot-edge");
      if (analysis.componentCount > 1) {
        (options.allowMultipleForegroundComponents ? frameWarnings : frameErrors).push("multiple-foreground-components");
      }
      if (analysis.internalTransparentPixels > Math.max(16, analysis.opaquePixels * 0.02)) {
        (options.allowTransparentHoles ? frameWarnings : frameErrors).push("possible-transparent-holes");
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

export async function mirrorFramesPreservingOrder(frames: readonly Buffer[]): Promise<readonly Buffer[]> {
  return Promise.all(frames.map((frame) => sharp(frame).flop().png().toBuffer()));
}

export async function inspectFrame(
  input: Buffer,
  index = 0,
  options: FrameInspectionOptions = {},
): Promise<FrameDiagnostics> {
  const analysis = await analyzeAlpha(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!analysis.bounds) errors.push("empty-frame");
  if (analysis.edgePixels > 0) errors.push("touches-cell-edge");
  if (analysis.componentCount > 1) {
    (options.allowMultipleForegroundComponents ? warnings : errors).push("multiple-foreground-components");
  }
  if (analysis.internalTransparentPixels > Math.max(16, analysis.opaquePixels * 0.02)) {
    (options.allowTransparentHoles ? warnings : errors).push("possible-transparent-holes");
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
    errors,
    warnings,
  };
}
