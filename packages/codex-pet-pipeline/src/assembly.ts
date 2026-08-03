import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import {
  LOOK_DIRECTIONS,
  PET_ATLAS_COLUMNS,
  PET_ATLAS_HEIGHT,
  PET_ATLAS_ROWS,
  PET_ATLAS_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  PET_ROW_SPECS,
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  type PetRowSpec,
} from "./constants.js";
import { colorDistance, countOpaqueKeyPixels, formatHexColor, parseHexColor } from "./chroma.js";
import { inspectFrame, mirrorFramesPreservingOrder, type FrameInspectionOptions } from "./extraction.js";

export type PetFramesByState = Partial<Record<PetRowSpec["state"], readonly Buffer[]>>;

/**
 * Re-label the per-cell findings `inspectFrame` graded, keeping the atlas's own
 * wording for edge contact. Severity is decided once, inside the extractor, so
 * the atlas gate and the board gate cannot drift apart.
 */
function cellFindingCodes(codes: readonly string[]): readonly string[] {
  return codes
    .filter((code) => code !== "empty-frame")
    .map((code) => code === "touches-cell-edge" ? "foreground-touches-cell-edge" : code);
}

export interface AtlasCellValidation {
  readonly row: number;
  readonly column: number;
  readonly state: string;
  readonly expectedUsed: boolean;
  readonly opaquePixels: number;
  /**
   * Chroma pixels the final despill left behind in this cell, so residue is
   * attributable to an action group instead of only to the whole atlas. A caller
   * repairing rows needs to know *which* row to regenerate; `0` when no chroma
   * key was supplied.
   */
  readonly opaqueChromaPixels: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface AtlasValidationReport {
  readonly ok: boolean;
  readonly spriteVersionNumber: 2;
  readonly width: number;
  readonly height: number;
  readonly columns: 8;
  readonly rows: 11;
  readonly cellWidth: 192;
  readonly cellHeight: 208;
  readonly transparent: boolean;
  readonly opaqueChromaPixels: number;
  readonly cells: readonly AtlasCellValidation[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface StandardAtlasValidationReport {
  readonly ok: boolean;
  /** Rows 0-8 are a QA/assembly intermediate and are never installable. */
  readonly intermediateOnly: true;
  readonly width: number;
  readonly height: number;
  readonly columns: 8;
  readonly rows: 9;
  readonly cellWidth: 192;
  readonly cellHeight: 208;
  readonly transparent: boolean;
  readonly cells: readonly AtlasCellValidation[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface DespillReport {
  readonly ok: boolean;
  readonly algorithm: "edge-local-nearest-interior-v1";
  readonly key: string;
  readonly radius: number;
  readonly changedPixels: number;
  readonly clearedHiddenRgbPixels: number;
  readonly remainingOpaqueKeyPixels: number;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function createLayoutGuide(options: {
  readonly columns: number;
  readonly rows?: number;
  readonly frameCount: number;
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
  /** Optional row-major labels for the physical source slots. */
  readonly slotLabels?: readonly string[];
}): Promise<Buffer> {
  const rows = options.rows ?? 2;
  const width = options.width ?? 1536;
  const height = options.height ?? 1024;
  if (!Number.isInteger(options.columns) || options.columns < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error("Layout columns and rows must be positive integers");
  }
  if (!Number.isInteger(options.frameCount) || options.frameCount < 1 || options.frameCount > options.columns * rows) {
    throw new Error("frameCount must fit inside the layout grid");
  }
  if (options.slotLabels && options.slotLabels.length !== options.columns * rows) {
    throw new Error("slotLabels must provide one label for every layout slot");
  }
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("Layout width and height must be positive integers");
  }
  const cellWidth = width / options.columns;
  const cellHeight = height / rows;
  const slots = Array.from({ length: options.columns * rows }, (_, index) => {
    const column = index % options.columns;
    const row = Math.floor(index / options.columns);
    const x = column * cellWidth;
    const y = row * cellHeight;
    const used = index < options.frameCount;
    const inset = Math.max(20, Math.min(cellWidth, cellHeight) * 0.09);
    return `<g>
      <rect x="${x + 2}" y="${y + 2}" width="${cellWidth - 4}" height="${cellHeight - 4}" fill="${used ? "#f5f7fb" : "#e3e7ee"}" stroke="#667085" stroke-width="4" stroke-dasharray="16 12"/>
      <rect x="${x + inset}" y="${y + inset}" width="${cellWidth - inset * 2}" height="${cellHeight - inset * 2}" fill="none" stroke="${used ? "#5b7cff" : "#98a2b3"}" stroke-width="3" stroke-dasharray="10 10"/>
      <text x="${x + cellWidth / 2}" y="${y + cellHeight / 2}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${Math.min(cellWidth, cellHeight) * 0.15}" font-weight="700" fill="${used ? "#344054" : "#98a2b3"}">${used ? escapeXml(options.slotLabels?.[index] ?? String(index + 1)) : "EMPTY"}</text>
    </g>`;
  }).join("");
  const title = escapeXml(options.title ?? `${options.frameCount}-pose layout reference`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${slots}
    <rect x="0" y="0" width="100%" height="56" fill="#101828" opacity="0.92"/>
    <text x="24" y="36" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#fff">${title} · keep each pose inside its dashed safe area</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function assemblePetAtlas(framesByState: PetFramesByState, format: "png" | "webp" = "webp"): Promise<Buffer> {
  return assembleRows(framesByState, PET_ROW_SPECS, PET_ATLAS_HEIGHT, format);
}

async function assembleRows(
  framesByState: PetFramesByState,
  specs: readonly PetRowSpec[],
  height: number,
  format: "png" | "webp",
): Promise<Buffer> {
  const composites: OverlayOptions[] = [];
  for (const spec of specs) {
    const frames = framesByState[spec.state];
    if (!frames || frames.length !== spec.frameCount) {
      throw new Error(`${spec.state} requires exactly ${spec.frameCount} frames`);
    }
    for (let column = 0; column < frames.length; column += 1) {
      const metadata = await sharp(frames[column]!).metadata();
      if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
        throw new Error(`${spec.state}[${column}] must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
      }
      composites.push({ input: frames[column]!, left: column * PET_CELL_WIDTH, top: spec.row * PET_CELL_HEIGHT });
    }
  }
  const pipeline = sharp({
    create: {
      width: PET_ATLAS_WIDTH,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites);
  return format === "png" ? pipeline.png().toBuffer() : pipeline.webp({ lossless: true, effort: 5 }).toBuffer();
}

/** Intermediate rows 0-8 only. Never package this image as a new Codex pet. */
export async function assembleStandardPetAtlas(framesByState: PetFramesByState, format: "png" | "webp" = "webp"): Promise<Buffer> {
  return assembleRows(framesByState, PET_ROW_SPECS.slice(0, 9), PET_CELL_HEIGHT * 9, format);
}

/**
 * Compose the four already-extracted and approved cardinal frames into a
 * compact, deterministic 2×2 anchor strip.  This strip is intentionally
 * raster-only (no labels or guides) so it can be supplied to the image model
 * as a stable reference for both interpolated direction rows.  The frame
 * order is always 000 (up), 090 (screen-right), 180 (down), 270 (screen-left)
 * and therefore must not be inferred from the source board layout.
 */
export async function composeCardinalAnchorStrip(frames: readonly Buffer[]): Promise<Buffer> {
  if (frames.length !== 4) throw new Error("Cardinal anchor strip requires exactly four frames");
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      throw new Error(`Cardinal anchor frame ${index} must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
  }));
  const positions = [
    { left: 0, top: 0 },
    { left: PET_CELL_WIDTH, top: 0 },
    { left: 0, top: PET_CELL_HEIGHT },
    { left: PET_CELL_WIDTH, top: PET_CELL_HEIGHT },
  ];
  return sharp({
    create: {
      width: PET_CELL_WIDTH * 2,
      height: PET_CELL_HEIGHT * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(frames.map((input, index) => ({ input, ...positions[index]! }))).png().toBuffer();
}

/**
 * Place the two exact cardinal endpoints used inside one row-major look row.
 * GPT Image edits treats its first image as the primary edit canvas, so the
 * endpoint storyboard must match the same physical left-to-right order that
 * the generated row prompt describes.
 *
 * The other six slots remain pure chroma and are explicitly filled by the
 * image model. The complete 2×2 cardinal strip remains a separate supporting
 * reference for the next endpoint and overall direction meaning.
 */
export async function createLookAnchorStoryboard(
  cardinalStrip: Buffer,
  row: "look-a" | "look-b",
  chromaKey: string,
): Promise<Buffer> {
  const metadata = await sharp(cardinalStrip).metadata();
  if (metadata.width !== PET_CELL_WIDTH * 2 || metadata.height !== PET_CELL_HEIGHT * 2) {
    throw new Error("Look anchor storyboard requires a 384x416 approved cardinal strip");
  }
  const cardinalIndices = row === "look-a" ? [0, 1] : [2, 3];
  const targetSlots = [0, 4];
  const slotWidth = 1536 / 4;
  const slotHeight = 1024 / 2;
  const targetWidth = 278;
  const targetHeight = 302;
  const anchors = await Promise.all(cardinalIndices.map(async (cardinalIndex) => {
    const column = cardinalIndex % 2;
    const cardinalRow = Math.floor(cardinalIndex / 2);
    return sharp(cardinalStrip)
      .extract({
        left: column * PET_CELL_WIDTH,
        top: cardinalRow * PET_CELL_HEIGHT,
        width: PET_CELL_WIDTH,
        height: PET_CELL_HEIGHT,
      })
      .resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
  }));
  return sharp({ create: { width: 1536, height: 1024, channels: 4, background: chromaKey } })
    .composite(anchors.map((input, index) => {
      const slot = targetSlots[index]!;
      const column = slot % 4;
      const sourceRow = Math.floor(slot / 4);
      return {
        input,
        left: Math.round(column * slotWidth + (slotWidth - targetWidth) / 2),
        top: Math.round((sourceRow + 1) * slotHeight - 64 - targetHeight),
      };
    }))
    .png()
    .toBuffer();
}

/**
 * Repack chronological look-direction cells into the model's physical 4x2
 * source board without resampling. The extraction layer reverses this mapping
 * after generation, so row-major direction order remains explicit in both
 * the runner and recovery tools.
 */
export async function composeLookSourceBoardReference(
  frames: readonly Buffer[],
  chromaKey: string,
): Promise<Buffer> {
  if (frames.length !== LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT.length) {
    throw new Error("Look source-board reference requires exactly eight chronological frames");
  }
  const sourceSlots = new Array<Buffer>(frames.length);
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT.forEach((sourceSlot, chronologicalIndex) => {
    sourceSlots[sourceSlot] = frames[chronologicalIndex]!;
  });
  return composeNormalizedPoseBoard(sourceSlots, { columns: 4, rows: 2, chromaKey });
}

/**
 * Build the non-deliverable row-10 trajectory scaffold from approved row 9
 * cells and cardinal endpoints. It supplies direction meaning only; a fresh
 * coherent row-10 generation is still required before any atlas assembly.
 */
export async function composeLookBScreenLeftTrajectoryReference(
  registeredLookAFrames: readonly Buffer[],
  cardinalFrames: readonly Buffer[],
  chromaKey: string,
): Promise<Buffer> {
  if (registeredLookAFrames.length !== 8 || cardinalFrames.length !== 4) {
    throw new Error("look-b screen-left trajectory scaffold requires eight row-A cells and four cardinals");
  }
  const mirrored = await mirrorFramesPreservingOrder(registeredLookAFrames);
  return composeLookSourceBoardReference([
    cardinalFrames[2]!,
    mirrored[7]!,
    mirrored[6]!,
    mirrored[5]!,
    cardinalFrames[3]!,
    mirrored[3]!,
    mirrored[2]!,
    mirrored[1]!,
  ], chromaKey);
}

/**
 * Compose already-normalized pet cells back into a compact chroma pose board.
 *
 * Image models rarely keep the implicit row/column gutters of a generated
 * board pixel-perfect. Extraction owns registration, so visual QA should
 * inspect these production cells rather than incidental source whitespace.
 * Unused slots remain pure chroma.
 */
export async function composeNormalizedPoseBoard(
  frames: readonly Buffer[],
  options: {
    readonly columns: number;
    readonly rows: number;
    readonly chromaKey: string;
  },
): Promise<Buffer> {
  if (!Number.isInteger(options.columns) || options.columns < 1
    || !Number.isInteger(options.rows) || options.rows < 1) {
    throw new Error("Pose-board columns and rows must be positive integers");
  }
  const slotCount = options.columns * options.rows;
  if (frames.length < 1 || frames.length > slotCount) {
    throw new Error("Normalized pose frames must fit inside the board grid");
  }
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      throw new Error(`Normalized pose frame ${index} must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
  }));
  const key = parseHexColor(options.chromaKey);
  return sharp({
    create: {
      width: options.columns * PET_CELL_WIDTH,
      height: options.rows * PET_CELL_HEIGHT,
      channels: 4,
      background: { ...key, alpha: 1 },
    },
  }).composite(frames.map((input, index) => ({
    input,
    left: (index % options.columns) * PET_CELL_WIDTH,
    top: Math.floor(index / options.columns) * PET_CELL_HEIGHT,
  }))).png().toBuffer();
}

export async function despillChromaEdges(
  input: Buffer,
  keyInput: string,
  radius = 5,
): Promise<{ image: Buffer; report: DespillReport }> {
  const key = parseHexColor(keyInput);
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = Buffer.from(data);
  let changedPixels = 0;
  let clearedHiddenRgbPixels = 0;
  const pixel = (x: number, y: number) => (y * info.width + x) * info.channels;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = pixel(x, y);
      const alpha = source[offset + 3]!;
      if (alpha === 0) {
        if (data[offset] || data[offset + 1] || data[offset + 2]) clearedHiddenRgbPixels += 1;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        continue;
      }
      const currentDistance = colorDistance({ r: source[offset]!, g: source[offset + 1]!, b: source[offset + 2]! }, key);
      if (alpha === 255 && currentDistance > 110) continue;
      let selectedOffset = -1;
      let selectedScore = Number.NEGATIVE_INFINITY;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0 || dx * dx + dy * dy > radius * radius) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
          const candidate = pixel(nx, ny);
          const candidateAlpha = source[candidate + 3]!;
          if (candidateAlpha < 224) continue;
          const distance = colorDistance({ r: source[candidate]!, g: source[candidate + 1]!, b: source[candidate + 2]! }, key);
          const score = distance - Math.sqrt(dx * dx + dy * dy) * 4;
          if (distance > 110 && score > selectedScore) {
            selectedOffset = candidate;
            selectedScore = score;
          }
        }
      }
      if (selectedOffset >= 0) {
        data[offset] = source[selectedOffset]!;
        data[offset + 1] = source[selectedOffset + 1]!;
        data[offset + 2] = source[selectedOffset + 2]!;
        changedPixels += 1;
      }
    }
  }
  const image = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  const remainingOpaqueKeyPixels = await countOpaqueKeyPixels(image, key, 32);
  return {
    image,
    report: {
      ok: remainingOpaqueKeyPixels === 0,
      algorithm: "edge-local-nearest-interior-v1",
      key: formatHexColor(key),
      radius,
      changedPixels,
      clearedHiddenRgbPixels,
      remainingOpaqueKeyPixels,
    },
  };
}

export async function validatePetAtlas(
  input: Buffer,
  chromaKey?: string,
  inspectionOptions: FrameInspectionOptions = {},
): Promise<AtlasValidationReport> {
  const metadata = await sharp(input).metadata();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (metadata.width !== PET_ATLAS_WIDTH) errors.push(`width:${metadata.width ?? 0}:expected:${PET_ATLAS_WIDTH}`);
  if (metadata.height !== PET_ATLAS_HEIGHT) errors.push(`height:${metadata.height ?? 0}:expected:${PET_ATLAS_HEIGHT}`);
  if (!metadata.hasAlpha) errors.push("atlas-missing-alpha-channel");
  const cells: AtlasCellValidation[] = [];
  if (metadata.width === PET_ATLAS_WIDTH && metadata.height === PET_ATLAS_HEIGHT) {
    for (let row = 0; row < PET_ATLAS_ROWS; row += 1) {
      const spec = PET_ROW_SPECS[row]!;
      for (let column = 0; column < PET_ATLAS_COLUMNS; column += 1) {
        const cell = await sharp(input).extract({
          left: column * PET_CELL_WIDTH,
          top: row * PET_CELL_HEIGHT,
          width: PET_CELL_WIDTH,
          height: PET_CELL_HEIGHT,
        }).png().toBuffer();
        const diagnostics = await inspectFrame(cell, column, inspectionOptions);
        const expectedUsed = column < spec.frameCount;
        const cellErrors: string[] = [];
        const cellWarnings: string[] = [];
        if (expectedUsed && diagnostics.opaquePixels === 0) cellErrors.push("used-cell-empty");
        if (!expectedUsed && diagnostics.opaquePixels > 0) cellErrors.push("unused-cell-not-transparent");
        if (expectedUsed) {
          cellErrors.push(...cellFindingCodes(diagnostics.errors));
          cellWarnings.push(...cellFindingCodes(diagnostics.warnings));
        }
        const cellChromaPixels = chromaKey ? await countOpaqueKeyPixels(cell, chromaKey, 32) : 0;
        if (cellChromaPixels > 0) cellErrors.push(`opaque-chroma-pixels:${cellChromaPixels}`);
        errors.push(...cellErrors.map((error) => `${spec.state}[${column}]:${error}`));
        warnings.push(...cellWarnings.map((warning) => `${spec.state}[${column}]:${warning}`));
        cells.push({
          row,
          column,
          state: spec.state,
          expectedUsed,
          opaquePixels: diagnostics.opaquePixels,
          opaqueChromaPixels: cellChromaPixels,
          errors: cellErrors,
          warnings: cellWarnings,
        });
      }
    }
  }
  const opaqueChromaPixels = chromaKey && metadata.width === PET_ATLAS_WIDTH && metadata.height === PET_ATLAS_HEIGHT
    ? await countOpaqueKeyPixels(input, chromaKey, 32)
    : 0;
  // Cells already carry their own share as `<state>[<column>]:opaque-chroma-pixels`.
  // The atlas-wide count stays a separate error only for residue outside the
  // cell grid, which no row regeneration could fix.
  const attributedChromaPixels = cells.reduce((total, cell) => total + cell.opaqueChromaPixels, 0);
  if (opaqueChromaPixels > attributedChromaPixels) {
    errors.push(`opaque-chroma-pixels:${opaqueChromaPixels - attributedChromaPixels}`);
  }
  return {
    ok: errors.length === 0,
    spriteVersionNumber: 2,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    columns: 8,
    rows: 11,
    cellWidth: 192,
    cellHeight: 208,
    transparent: Boolean(metadata.hasAlpha),
    opaqueChromaPixels,
    cells,
    errors,
    warnings,
  };
}

/**
 * Validate the deterministic rows 0-8 intermediate before it is used to
 * ground direction generation. Chroma spill is intentionally not a gate at
 * this stage: the complete 8x11 atlas owns the single final despill pass.
 */
export async function validateStandardPetAtlas(
  input: Buffer,
  inspectionOptions: FrameInspectionOptions = {},
): Promise<StandardAtlasValidationReport> {
  const specs = PET_ROW_SPECS.slice(0, 9);
  const expectedHeight = PET_CELL_HEIGHT * specs.length;
  const metadata = await sharp(input).metadata();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (metadata.width !== PET_ATLAS_WIDTH) errors.push(`width:${metadata.width ?? 0}:expected:${PET_ATLAS_WIDTH}`);
  if (metadata.height !== expectedHeight) errors.push(`height:${metadata.height ?? 0}:expected:${expectedHeight}`);
  if (!metadata.hasAlpha) errors.push("atlas-missing-alpha-channel");
  const cells: AtlasCellValidation[] = [];
  if (metadata.width === PET_ATLAS_WIDTH && metadata.height === expectedHeight) {
    for (const spec of specs) {
      for (let column = 0; column < PET_ATLAS_COLUMNS; column += 1) {
        const cell = await sharp(input).extract({
          left: column * PET_CELL_WIDTH,
          top: spec.row * PET_CELL_HEIGHT,
          width: PET_CELL_WIDTH,
          height: PET_CELL_HEIGHT,
        }).png().toBuffer();
        const diagnostics = await inspectFrame(cell, column, inspectionOptions);
        const expectedUsed = column < spec.frameCount;
        const cellErrors: string[] = [];
        const cellWarnings: string[] = [];
        if (expectedUsed && diagnostics.opaquePixels === 0) cellErrors.push("used-cell-empty");
        if (!expectedUsed && diagnostics.opaquePixels > 0) cellErrors.push("unused-cell-not-transparent");
        if (expectedUsed) {
          cellErrors.push(...cellFindingCodes(diagnostics.errors));
          cellWarnings.push(...cellFindingCodes(diagnostics.warnings));
        }
        errors.push(...cellErrors.map((error) => `${spec.state}[${column}]:${error}`));
        warnings.push(...cellWarnings.map((warning) => `${spec.state}[${column}]:${warning}`));
        // Chroma is deliberately not graded here: the complete atlas owns the
        // single despill pass, so this intermediate has nothing to attribute.
        cells.push({
          row: spec.row,
          column,
          state: spec.state,
          expectedUsed,
          opaquePixels: diagnostics.opaquePixels,
          opaqueChromaPixels: 0,
          errors: cellErrors,
          warnings: cellWarnings,
        });
      }
    }
  }
  return {
    ok: errors.length === 0,
    intermediateOnly: true,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    columns: 8,
    rows: 9,
    cellWidth: 192,
    cellHeight: 208,
    transparent: Boolean(metadata.hasAlpha),
    cells,
    errors,
    warnings,
  };
}

function checkerSvg(width: number, height: number, step: number): Buffer {
  const squares: string[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      squares.push(`<rect x="${x}" y="${y}" width="${step}" height="${step}" fill="${((x / step + y / step) % 2) ? "#e8ebf0" : "#f8f9fb"}"/>`);
    }
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${squares.join("")}</svg>`);
}

export async function createAtlasContactSheet(atlas: Buffer, scale = 0.5): Promise<Buffer> {
  return createContactSheetForSpecs(atlas, PET_ROW_SPECS, scale);
}

export async function createStandardAtlasContactSheet(atlas: Buffer, scale = 0.5): Promise<Buffer> {
  return createContactSheetForSpecs(atlas, PET_ROW_SPECS.slice(0, 9), scale);
}

async function createContactSheetForSpecs(atlas: Buffer, specs: readonly PetRowSpec[], scale: number): Promise<Buffer> {
  const width = Math.round(PET_ATLAS_WIDTH * scale);
  const sourceHeight = PET_CELL_HEIGHT * specs.length;
  const height = Math.round(sourceHeight * scale);
  const resized = await sharp(atlas).resize(width, height).png().toBuffer();
  const grid = specs.map((spec) => {
    const y = spec.row * PET_CELL_HEIGHT * scale;
    return `<text x="6" y="${y + 18}" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#101828" stroke="#fff" stroke-width="3" paint-order="stroke">${escapeXml(spec.state)}</text>`;
  }).join("");
  const lines = Array.from({ length: PET_ATLAS_COLUMNS + 1 }, (_, column) => `<line x1="${column * PET_CELL_WIDTH * scale}" y1="0" x2="${column * PET_CELL_WIDTH * scale}" y2="${height}" stroke="#475467" stroke-opacity=".28"/>`).join("")
    + Array.from({ length: specs.length + 1 }, (_, row) => `<line x1="0" y1="${row * PET_CELL_HEIGHT * scale}" x2="${width}" y2="${row * PET_CELL_HEIGHT * scale}" stroke="#475467" stroke-opacity=".28"/>`).join("");
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines}${grid}</svg>`);
  return sharp(checkerSvg(width, height, Math.max(8, Math.round(16 * scale))))
    .composite([{ input: resized }, { input: overlay }])
    .png()
    .toBuffer();
}

export async function createDirectionQaSheet(atlas: Buffer): Promise<Buffer> {
  const cardWidth = PET_CELL_WIDTH + 16;
  const cardHeight = PET_CELL_HEIGHT + 34;
  const columns = 6;
  const items: Array<{ label: string; input: Buffer }> = [];
  const neutral = await sharp(atlas).extract({ left: 0, top: 0, width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT }).png().toBuffer();
  items.push({ label: "neutral", input: neutral });
  for (let index = 0; index < LOOK_DIRECTIONS.length; index += 1) {
    const row = index < 8 ? 9 : 10;
    const column = index % 8;
    items.push({
      label: `${LOOK_DIRECTIONS[index]}°`,
      input: await sharp(atlas).extract({ left: column * PET_CELL_WIDTH, top: row * PET_CELL_HEIGHT, width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT }).png().toBuffer(),
    });
  }
  const rows = Math.ceil(items.length / columns);
  const width = columns * cardWidth;
  const height = rows * cardHeight;
  const composites: OverlayOptions[] = [];
  items.forEach((item, index) => {
    const x = (index % columns) * cardWidth + 8;
    const y = Math.floor(index / columns) * cardHeight + 26;
    composites.push({ input: item.input, left: x, top: y });
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cardWidth}" height="26"><text x="${cardWidth / 2}" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#101828">${escapeXml(item.label)}</text></svg>`);
    composites.push({ input: label, left: (index % columns) * cardWidth, top: Math.floor(index / columns) * cardHeight });
  });
  return sharp(checkerSvg(width, height, 16)).composite(composites).png().toBuffer();
}

export interface DirectionBlindAnswerKey {
  readonly pairs: readonly {
    readonly pair: string;
    readonly axis: "horizontal" | "vertical";
    readonly A: { readonly direction: string; readonly expected: "screen-left" | "screen-right" | "up" | "down" };
    readonly B: { readonly direction: string; readonly expected: "screen-left" | "screen-right" | "up" | "down" };
    readonly cardinal: boolean;
  }[];
}

const HORIZONTAL_BLIND_PAIRS = [
  ["090", "270"], ["067.5", "292.5"], ["112.5", "247.5"], ["045", "315"],
  ["135", "225"], ["022.5", "337.5"], ["157.5", "202.5"],
] as const;
const VERTICAL_BLIND_PAIRS = [
  ["000", "180"], ["022.5", "157.5"], ["337.5", "202.5"], ["045", "135"],
  ["315", "225"], ["067.5", "112.5"], ["292.5", "247.5"],
] as const;

function directionCellPosition(direction: string): { row: number; column: number } {
  const index = LOOK_DIRECTIONS.indexOf(direction as typeof LOOK_DIRECTIONS[number]);
  if (index < 0) throw new Error(`Unknown look direction: ${direction}`);
  return { row: index < 8 ? 9 : 10, column: index % 8 };
}

export async function createDirectionBlindQaSheet(atlas: Buffer): Promise<{ image: Buffer; answerKey: DirectionBlindAnswerKey }> {
  const definitions = [
    ...HORIZONTAL_BLIND_PAIRS.map((directions, index) => ({ axis: "horizontal" as const, directions, pair: `horizontal-${index + 1}` })),
    ...VERTICAL_BLIND_PAIRS.map((directions, index) => ({ axis: "vertical" as const, directions, pair: `vertical-${index + 1}` })),
  ];
  const cardWidth = PET_CELL_WIDTH + 12;
  const rowHeight = PET_CELL_HEIGHT + 54;
  const width = cardWidth * 2;
  const height = rowHeight * definitions.length;
  const overlays: OverlayOptions[] = [];
  const answerPairs: DirectionBlindAnswerKey["pairs"][number][] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    const ordered = index % 2 === 0 ? definition.directions : [definition.directions[1], definition.directions[0]] as const;
    const answers: Array<{ direction: string; expected: "screen-left" | "screen-right" | "up" | "down" }> = [];
    for (let side = 0; side < 2; side += 1) {
      const direction = ordered[side]!;
      const position = directionCellPosition(direction);
      const cell = await sharp(atlas).extract({
        left: position.column * PET_CELL_WIDTH,
        top: position.row * PET_CELL_HEIGHT,
        width: PET_CELL_WIDTH,
        height: PET_CELL_HEIGHT,
      }).png().toBuffer();
      overlays.push({ input: cell, left: side * cardWidth + 6, top: index * rowHeight + 50 });
      const degrees = Number(direction);
      const expected = definition.axis === "horizontal"
        ? degrees > 0 && degrees < 180 ? "screen-right" : "screen-left"
        : degrees < 90 || degrees > 270 ? "up" : "down";
      answers.push({ direction, expected });
    }
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="50">
      <rect width="100%" height="100%" fill="#fff" fill-opacity=".86"/>
      <text x="8" y="19" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#101828">${definition.pair} · classify ${definition.axis} axis</text>
      <text x="${cardWidth / 2}" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700">A</text>
      <text x="${cardWidth + cardWidth / 2}" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700">B</text>
    </svg>`);
    overlays.push({ input: label, left: 0, top: index * rowHeight });
    answerPairs.push({
      pair: definition.pair,
      axis: definition.axis,
      A: answers[0]!,
      B: answers[1]!,
      cardinal: definition.pair === "horizontal-1" || definition.pair === "vertical-1",
    });
  }
  return {
    image: await sharp(checkerSvg(width, height, 16)).composite(overlays).png().toBuffer(),
    answerKey: { pairs: answerPairs },
  };
}

export interface AnimatedWebpPreview {
  readonly image: Buffer;
  readonly durations: readonly number[];
  readonly frameCount: number;
  readonly loop: number;
  readonly width: typeof PET_CELL_WIDTH;
  readonly height: typeof PET_CELL_HEIGHT;
  readonly mime: "image/webp";
}

/** Create a genuinely animated, infinitely looping WebP preview in frame order. */
export async function createAnimatedWebpPreview(
  frames: readonly Buffer[],
  durations: readonly number[],
  loop = 0,
): Promise<AnimatedWebpPreview> {
  if (frames.length === 0 || frames.length !== durations.length) {
    throw new Error("Preview frames and durations must have equal non-zero length");
  }
  if (!Number.isInteger(loop) || loop < 0 || loop > 65_535) throw new Error("Preview loop must be an integer from 0 to 65535");
  durations.forEach((duration, index) => {
    if (!Number.isInteger(duration) || duration < 1 || duration > 65_535) {
      throw new Error(`Preview duration ${index} must be an integer from 1 to 65535 milliseconds`);
    }
  });
  await Promise.all(frames.map(async (frame, index) => {
    const metadata = await sharp(frame).metadata();
    if (metadata.width !== PET_CELL_WIDTH || metadata.height !== PET_CELL_HEIGHT) {
      throw new Error(`Preview frame ${index} must be ${PET_CELL_WIDTH}x${PET_CELL_HEIGHT}`);
    }
  }));

  // Sharp/libvips represents animation pages as one vertical image plus pageHeight.
  // Compositing in this order therefore preserves both frame order and timing.
  const image = await sharp({
    create: {
      width: PET_CELL_WIDTH,
      height: PET_CELL_HEIGHT * frames.length,
      pageHeight: PET_CELL_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(frames.map((input, index) => ({ input, left: 0, top: index * PET_CELL_HEIGHT })))
    .webp({ lossless: true, effort: 5, exact: true, loop, delay: [...durations] })
    .toBuffer();
  return {
    image,
    durations: [...durations],
    frameCount: frames.length,
    loop,
    width: PET_CELL_WIDTH,
    height: PET_CELL_HEIGHT,
    mime: "image/webp",
  };
}

/** @deprecated Kept as a compatibility alias; output is now an animated WebP, not a horizontal strip. */
export async function createAnimationPreviewStrip(
  frames: readonly Buffer[],
  durations: readonly number[],
): Promise<AnimatedWebpPreview> {
  return createAnimatedWebpPreview(frames, durations);
}
