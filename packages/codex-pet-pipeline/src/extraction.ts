/**
 * 姿态板抽取的四个公开入口(`extractPoseBoard` / `extractFullPoseBoardsWithSharedRegistration` /
 * `spliceSourcePoseBoardSlots` / `mirrorFramesPreservingOrder` / `inspectFrame`)。原文件 1398 行,
 * 把契约、连通域谓词、alpha 分析、评级共 847 行搬到 4 个同域文件,这里只留下编排。
 *
 * **本文件刻意不做成纯 re-export 门面。** 计划的判据是 800 行,拆完 594 行已在判据以下;这五个入口
 * 就是这个模块的身份,再往下拆只会多一层间接。
 *
 * **导出面必须逐字不变。** `index.ts` 是 `export * from "./extraction.js"`,包外(apps/api)看到的
 * 每个名字都从这里流出:20 个名字 = 5 个函数 + `SpliceSourcePoseBoardSlotsInput` + 由文件顶部
 * re-export 原样转出的 12 个类型和 2 个常量。少转一个名字,受害者是 apps/api 而不是本包。
 * 包内三个直接 importer 也因此零改动:continuity.ts(PixelBounds)、assembly.ts(inspectFrame /
 * mirrorFramesPreservingOrder / FrameInspectionOptions)、direction-registration.ts(inspectFrame /
 * FrameDiagnostics / PixelBounds)。
 *
 * **没有 extraction.test.ts。** 覆盖这条链的是 pipeline.test.ts(经 index 的 export *)和 apps/api 的
 * codex-pet-visual.test.ts,都是黑盒。所以这次拆分不靠测试兜底,靠的是"搬走的每一行与 HEAD 逐字节
 * 相同"的证明;后续改动请沿用同一条纪律。
 *
 * `extractPoseBoard` 里几处顺序不能动:
 *  - 全部参数校验(grid / frameOrder 是否为排列 / cell / padding / chroma 覆盖率区间 / 几何阈值)
 *    都在**读第一个像素之前**。放到后面等于为一次注定 throw 的调用付满一轮解码。
 *  - 整轮**只 resize 一次**,用一个 sharedScale。任何"顺手"按帧缩放都会在方向行接缝处变成可见的
 *    大小/基线跳变 —— 这正是 `extractFullPoseBoardsWithSharedRegistration` 存在的原因。
 *  - 渗色擦除只在 slot 阶段开(`dropNeighbourBleed: strictness !== "strict"`),归一化 cell 阶段不开。
 *  - `analysis.cleanedImage ?? result.image`:只有真的删过像素才有 cleanedImage。
 *  - 共享配准把源 cell **无损平铺**后只做一次抽取,且按底边对齐 —— 竖直居中会把两块板的高度差
 *    变成假的跳跃。
 *
 * 依赖方向:types + alpha + findings。types → components → alpha → findings → **extraction.ts**。
 */

import sharp from "sharp";
import { PET_CELL_HEIGHT, PET_CELL_WIDTH } from "./constants.js";
import { removeChroma, type ChromaRemovalResult } from "./chroma.js";
import { validateJumpingArc } from "./jumping.js";
import { DEFAULT_FRAME_STRICTNESS } from "./extraction-types.js";
import type {
  ExtractPoseBoardOptions,
  ExtractPoseBoardResult,
  FrameDiagnostics,
  FrameInspectionOptions,
  FullPoseBoardRegistrationInput,
  PixelBounds,
  SharedPoseBoardRegistrationResult,
} from "./extraction-types.js";
import { analyzeAlpha, type AlphaAnalysis } from "./extraction-alpha.js";
import { classifyFrameFindings } from "./extraction-findings.js";

// 导出面与拆分前逐字一致:这 14 个名字原样转出,不新增也不减少。
export { DEFAULT_FRAME_STRICTNESS, FRAME_TOLERANCE } from "./extraction-types.js";
export type {
  BorderContactRuns,
  EnclosedRegionDiagnostics,
  ExtractPoseBoardOptions,
  ExtractPoseBoardResult,
  ForegroundComponentDiagnostics,
  FrameDiagnostics,
  FrameInspectionOptions,
  FrameStrictness,
  FullPoseBoardRegistrationInput,
  PixelBounds,
  PoseBoardGeometryDiagnostics,
  SharedPoseBoardRegistrationResult,
} from "./extraction-types.js";

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
    const analysis = await analyzeAlpha(result.image, {
      dropNeighbourBleed: strictness !== "strict",
      allowAuxiliaryForegroundComponents: options.allowAuxiliaryForegroundComponents,
    });
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
  const jumpingTargetHeight = options.jumpingTargetHeight;
  if (jumpingTargetHeight !== undefined
    && (!preserveVerticalTravel || !Number.isFinite(jumpingTargetHeight) || jumpingTargetHeight < 1)) {
    throw new Error("jumpingTargetHeight requires vertical travel and must be a positive finite number");
  }
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
  const horizontalScale = (cellWidth - padding * 2 - 2) / sharedWidth;
  const jumpTopPadding = 3;
  const minimumJumpLift = 18;
  const maximumJumpLift = 24;
  const groundBaseline = cellHeight - padding - 1;
  const maximumPoseHeight = placed.length ? Math.max(...placed.map((item) => item.height)) : 1;
  // Reserve the complete normalized arc before choosing the shared character
  // scale. Reserving only the minimum lift can leave a tall character with a
  // 19px peak even though the unchanged body-relative gate requires 23px.
  const maximumJumpingPoseHeight = groundBaseline - jumpTopPadding + 1 - maximumJumpLift;
  const sharedScale = jumpingTargetHeight === undefined
    ? Math.min(horizontalScale, (cellHeight - padding * 2 - 2) / sharedHeight)
    : Math.min(
      horizontalScale,
      Math.min(jumpingTargetHeight, maximumJumpingPoseHeight) / maximumPoseHeight,
    );
  const normalizedMaximumPoseHeight = Math.max(
    1,
    ...placed.map((item) => Math.max(1, Math.round(item.height * sharedScale))),
  );
  const compressedJumpLift = jumpingTargetHeight === undefined
    ? null
    : Math.min(
      maximumJumpLift,
      Math.max(minimumJumpLift, groundBaseline - jumpTopPadding + 1 - normalizedMaximumPoseHeight),
    );
  const maximumSourceLift = nonempty.length
    ? Math.max(...nonempty.map((item) => item.bottomGap - groundGap))
    : 0;
  const horizontalOrigin = (cellWidth - 1) / 2 - ((minLeft + maxRight) / 2) * sharedScale;
  const baseline = groundBaseline - maxBottom * sharedScale;
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
        allowAuxiliaryForegroundComponents: options.allowAuxiliaryForegroundComponents,
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
      const sourceLift = positioned[index] ? positioned[index]!.bottomGap - groundGap : 0;
      const normalizedJumpLift = compressedJumpLift !== null && maximumSourceLift > 0
        ? Math.round((sourceLift / maximumSourceLift) * compressedJumpLift)
        : 0;
      const top = jumpingTargetHeight !== undefined
        ? groundBaseline - targetHeight + 1 - normalizedJumpLift
        : preserveVerticalTravel
          ? Math.round(baseline + registration.top * sharedScale)
          : cellHeight - padding - targetHeight;
      const requiredTopPadding = jumpingTargetHeight === undefined ? padding : jumpTopPadding;
      if (left < padding || top < requiredTopPadding || left + targetWidth > cellWidth - padding || top + targetHeight > cellHeight - padding) {
        frameErrors.push("normalized-frame-outside-safe-margin");
      }
      frames.push(await sharp({
        create: { width: cellWidth, height: cellHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      }).composite([{ input: cropped, left, top }]).png().toBuffer());
    }
    const normalized = await analyzeAlpha(frames[index]!, {
      allowAuxiliaryForegroundComponents: options.allowAuxiliaryForegroundComponents,
    });
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
  const analysis = await analyzeAlpha(input, {
    allowAuxiliaryForegroundComponents: options.allowAuxiliaryForegroundComponents,
  });
  const metadata = await sharp(input).metadata();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!analysis.bounds) errors.push("empty-frame");
  for (const finding of classifyFrameFindings(analysis, metadata.width ?? PET_CELL_WIDTH, metadata.height ?? PET_CELL_HEIGHT, {
    strictness: options.frameStrictness ?? DEFAULT_FRAME_STRICTNESS,
    allowMultipleForegroundComponents: options.allowMultipleForegroundComponents,
    allowAuxiliaryForegroundComponents: options.allowAuxiliaryForegroundComponents,
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
