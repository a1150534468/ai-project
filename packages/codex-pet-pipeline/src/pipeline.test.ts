import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import {
  PET_ATLAS_HEIGHT,
  PET_ATLAS_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  PET_ROW_SPECS,
  assemblePetAtlas,
  assembleStandardPetAtlas,
  composeCardinalAnchorStrip,
  buildCodexInstallDeepLink,
  chooseChromaKey,
  createAnimatedWebpPreview,
  createAnimationPreviewStrip,
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionQaSheet,
  createLayoutGuide,
  despillChromaEdges,
  extractFullPoseBoardsWithSharedRegistration,
  extractPoseBoard,
  inspectCodexPetZip,
  inspectFrame,
  measureDirectionContinuity,
  measureDirectionRowContinuity,
  mirrorFramesPreservingOrder,
  validatePetAtlas,
  validateStandardPetAtlas,
  type PetFramesByState,
} from "./index.js";

async function rectFrame(options: {
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
} = {}): Promise<Buffer> {
  const color = options.color ?? "#2255cc";
  const x = options.x ?? 42;
  const y = options.y ?? 35;
  const width = options.width ?? 82;
  const height = options.height ?? 155;
  const sprite = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PET_CELL_WIDTH}" height="${PET_CELL_HEIGHT}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.min(28, width / 4, height / 4)}" fill="${color}"/>
  </svg>`);
  return sharp({
    create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: sprite }]).png().toBuffer();
}

async function solidFrame(color = "#2255cc", x = 42): Promise<Buffer> {
  return rectFrame({ color, x });
}

async function poseBoard(columns: number, rows: number, frameCount: number, occupyUnused = false): Promise<Buffer> {
  const width = columns * 320;
  const height = rows * 360;
  const composites: OverlayOptions[] = [];
  const count = occupyUnused ? columns * rows : frameCount;
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const widthVariation = 90 + (index % 3) * 12;
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360">
      <rect x="${Math.round((320 - widthVariation) / 2)}" y="80" width="${widthVariation}" height="230" rx="35" fill="#2459c7"/>
    </svg>`);
    composites.push({ input: svg, left: column * 320, top: row * 360 });
  }
  return sharp({ create: { width, height, channels: 4, background: "#ff00ff" } }).composite(composites).png().toBuffer();
}

async function boardWithOverlays(columns: number, rows: number, overlays: readonly OverlayOptions[], background = "#ff00ff"): Promise<Buffer> {
  return sharp({ create: { width: columns * 320, height: rows * 360, channels: 4, background } })
    .composite([...overlays])
    .png()
    .toBuffer();
}

describe("codex pet deterministic pipeline", () => {
  it("builds layout guides for all supported board geometries", async () => {
    for (const [columns, frameCount] of [[4, 8], [3, 6], [3, 5], [2, 4]] as const) {
      const guide = await createLayoutGuide({ columns, frameCount });
      const metadata = await sharp(guide).metadata();
      expect(metadata.width).toBe(1536);
      expect(metadata.height).toBe(1024);
    }
    await expect(createLayoutGuide({ columns: 0, frameCount: 1 })).rejects.toThrow(/positive integers/);
    await expect(createLayoutGuide({ columns: 2, rows: 2, frameCount: 0 })).rejects.toThrow(/fit inside/);
  });

  it("extracts 4x2, 3x2 and 2x2 boards with one scale/baseline and enforces unused slots", async () => {
    for (const geometry of [
      { columns: 4, rows: 2, frameCount: 8 },
      { columns: 3, rows: 2, frameCount: 6 },
      { columns: 3, rows: 2, frameCount: 5 },
      { columns: 2, rows: 2, frameCount: 4 },
    ]) {
      const extracted = await extractPoseBoard(await poseBoard(geometry.columns, geometry.rows, geometry.frameCount), {
        ...geometry,
        chromaKey: "#ff00ff",
      });
      expect(extracted.errors, `${geometry.columns}x${geometry.rows}/${geometry.frameCount}`).toEqual([]);
      expect(extracted.frames).toHaveLength(geometry.frameCount);
      expect(extracted.unusedSlotOpaquePixels).toHaveLength(geometry.columns * geometry.rows - geometry.frameCount);
      expect(extracted.unusedSlotOpaquePixels.every((pixels) => pixels === 0)).toBe(true);
      expect(new Set(extracted.diagnostics.map((item) => item.normalizedBounds?.bottom))).toEqual(new Set([195]));
      for (const frame of extracted.frames) {
        const metadata = await sharp(frame).metadata();
        expect([metadata.width, metadata.height]).toEqual([192, 208]);
      }
    }

    const invalid = await extractPoseBoard(await poseBoard(3, 2, 5, true), {
      columns: 3,
      rows: 2,
      frameCount: 5,
      chromaKey: "#ff00ff",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContain("unused-slot-5:not-empty");
  });

  it("registers both direction boards with one scale and baseline", async () => {
    const directionBoard = async (bodyHeight: number, width = 1280, height = 720) => {
      const slotWidth = width / 4;
      const slotHeight = height / 2;
      const overlays = Array.from({ length: 8 }, (_, index) => {
        const bodyWidth = 100;
        const column = index % 4;
        const row = Math.floor(index / 4);
        const x = Math.round(column * slotWidth + (slotWidth - bodyWidth) / 2);
        const y = Math.round((row + 1) * slotHeight - 45 - bodyHeight);
        return {
          input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${bodyWidth}" height="${bodyHeight}" rx="25" fill="#2459c7"/></svg>`),
        };
      });
      return sharp({ create: { width, height, channels: 4, background: "#ff00ff" } }).composite(overlays).png().toBuffer();
    };
    const first = await directionBoard(170);
    // A different real gateway size is accepted without pre-resizing.
    const second = await directionBoard(260, 1536, 1024);
    const [firstIndependent, secondIndependent] = await Promise.all([
      extractPoseBoard(first, { columns: 4, rows: 2, frameCount: 8, chromaKey: "#ff00ff" }),
      extractPoseBoard(second, { columns: 4, rows: 2, frameCount: 8, chromaKey: "#ff00ff" }),
    ]);
    expect(firstIndependent.sharedScale).not.toBeCloseTo(secondIndependent.sharedScale, 5);

    const registered = await extractFullPoseBoardsWithSharedRegistration([
      { input: first, columns: 4, rows: 2, frameCount: 8 },
      { input: second, columns: 4, rows: 2, frameCount: 8 },
    ], { chromaKey: "#ff00ff" });
    expect(registered.errors).toEqual([]);
    expect(registered.framesByBoard.map((frames) => frames.length)).toEqual([8, 8]);
    expect(registered.sourceBoardSizes).toEqual([{ width: 1280, height: 720 }, { width: 1536, height: 1024 }]);
    const all = registered.diagnosticsByBoard.flat();
    expect(new Set(all.map((item) => item.normalizedBounds?.bottom))).toEqual(new Set([195]));
    // One registration exposes the genuine source-size mismatch instead of
    // independently fitting both rows to almost the same cell height.
    expect(registered.diagnosticsByBoard[0]![0]!.normalizedBounds!.height)
      .toBeLessThan(registered.diagnosticsByBoard[1]![0]!.normalizedBounds!.height);
  });

  it("enforces explicit chroma-key coverage bounds for every used pose slot", async () => {
    const missingKey = await sharp({ create: { width: 640, height: 720, channels: 4, background: "#ffffff" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720">
        <rect x="105" y="70" width="110" height="240" rx="30" fill="#2459c7"/>
        <rect x="425" y="70" width="110" height="240" rx="30" fill="#2459c7"/>
        <rect x="105" y="430" width="110" height="240" rx="30" fill="#2459c7"/>
        <rect x="425" y="430" width="110" height="240" rx="30" fill="#2459c7"/>
      </svg>`) }])
      .png()
      .toBuffer();
    const low = await extractPoseBoard(missingKey, { columns: 2, rows: 2, frameCount: 4, chromaKey: "#ff00ff" });
    expect(low.ok).toBe(false);
    expect(low.diagnostics.every((item) => item.chromaCoverage === 0)).toBe(true);
    expect(low.errors.some((error) => error.startsWith("frame-0:chroma-coverage-too-low:"))).toBe(true);

    const almostEmpty = await sharp({ create: { width: 640, height: 720, channels: 4, background: "#ff00ff" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720">
        <rect x="159" y="179" width="2" height="2" fill="#2459c7"/>
        <rect x="479" y="179" width="2" height="2" fill="#2459c7"/>
        <rect x="159" y="539" width="2" height="2" fill="#2459c7"/>
        <rect x="479" y="539" width="2" height="2" fill="#2459c7"/>
      </svg>`) }])
      .png()
      .toBuffer();
    const high = await extractPoseBoard(almostEmpty, { columns: 2, rows: 2, frameCount: 4, chromaKey: "#ff00ff" });
    expect(high.ok).toBe(false);
    expect(high.errors.some((error) => error.startsWith("frame-0:chroma-coverage-too-high:"))).toBe(true);
  });

  it("reports empty poses, cross-slot foreground and source-edge contact", async () => {
    const slotSprite = (x: number, y: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720">
      <rect x="${x}" y="${y}" width="90" height="220" rx="24" fill="#2459c7"/>
    </svg>`);
    const emptyBoard = await boardWithOverlays(2, 2, [
      { input: slotSprite(110, 70), left: 0, top: 0 },
      { input: slotSprite(430, 70), left: 0, top: 0 },
      { input: slotSprite(430, 430), left: 0, top: 0 },
    ]);
    const empty = await extractPoseBoard(emptyBoard, { columns: 2, rows: 2, frameCount: 4, chromaKey: "#ff00ff" });
    expect(empty.ok).toBe(false);
    expect(empty.errors).toContain("frame-2:empty-frame");

    const crossingSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="720">
      <rect x="270" y="70" width="100" height="220" rx="20" fill="#2459c7"/>
      <rect x="0" y="430" width="90" height="220" fill="#2459c7"/>
      <rect x="430" y="430" width="90" height="220" rx="20" fill="#2459c7"/>
    </svg>`);
    const crossing = await extractPoseBoard(await boardWithOverlays(2, 2, [{ input: crossingSvg, left: 0, top: 0 }]), {
      columns: 2,
      rows: 2,
      frameCount: 4,
      chromaKey: "#ff00ff",
    });
    expect(crossing.ok).toBe(false);
    expect(crossing.errors).toContain("frame-0:source-touches-slot-edge");
    expect(crossing.errors).toContain("frame-1:source-touches-slot-edge");
    expect(crossing.errors).toContain("frame-2:source-touches-slot-edge");
  });

  it("preserves intentional vertical travel across jumping frames", async () => {
    const yPositions = [170, 100, 30, 100, 170];
    const overlays = yPositions.map((y, index) => ({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360">
        <rect x="105" y="${y}" width="110" height="120" rx="28" fill="#2459c7"/>
      </svg>`),
      left: (index % 3) * 320,
      top: Math.floor(index / 3) * 360,
    }));
    const extracted = await extractPoseBoard(await boardWithOverlays(3, 2, overlays), {
      columns: 3,
      rows: 2,
      frameCount: 5,
      chromaKey: "#ff00ff",
    });

    expect(extracted.errors).toEqual([]);
    const bottoms = extracted.diagnostics.map((item) => item.normalizedBounds!.bottom);
    expect(bottoms[0]).toBe(bottoms[4]);
    expect(bottoms[2]!).toBeLessThan(bottoms[0]! - 80);
    expect(bottoms[1]!).toBeGreaterThan(bottoms[2]!);
    expect(bottoms[1]!).toBeLessThan(bottoms[0]!);
  });

  it("reports deterministic scale and baseline discontinuities while allowing intentional jumps", async () => {
    const poses = [
      { y: 80, height: 230 },
      { y: 200, height: 110 },
      { y: 80, height: 230 },
      { y: 20, height: 230 },
    ];
    const overlays = poses.map((pose, index) => ({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360">
        <rect x="105" y="${pose.y}" width="110" height="${pose.height}" rx="28" fill="#2459c7"/>
      </svg>`),
      left: (index % 2) * 320,
      top: Math.floor(index / 2) * 360,
    }));
    const board = await boardWithOverlays(2, 2, overlays);
    const ordinary = await extractPoseBoard(board, {
      columns: 2,
      rows: 2,
      frameCount: 4,
      chromaKey: "#ff00ff",
    });
    expect(ordinary.ok).toBe(true);
    expect(ordinary.geometry.heightRatio).toBeGreaterThan(2);
    expect(ordinary.geometry.baselineSpreadPixels).toBeGreaterThan(30);
    expect(ordinary.geometry.warnings.some((warning) => warning.startsWith("geometry:height-ratio:"))).toBe(true);
    expect(ordinary.geometry.warnings.some((warning) => warning.startsWith("geometry:baseline-spread:"))).toBe(true);

    const jumping = await extractPoseBoard(board, {
      columns: 2,
      rows: 2,
      frameCount: 4,
      chromaKey: "#ff00ff",
      allowVerticalTravel: true,
    });
    expect(jumping.geometry.warnings.some((warning) => warning.startsWith("geometry:height-ratio:"))).toBe(true);
    expect(jumping.geometry.warnings.some((warning) => warning.startsWith("geometry:baseline-spread:"))).toBe(false);
  });

  it("selects a non-conflicting chroma key and preserves the character colour", async () => {
    const magentaCharacter = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    const key = await chooseChromaKey(magentaCharacter, ["#ff00ff", "#00ff00", "#00ffff"]);
    expect(key).not.toBe("#ff00ff");
    const overlays: OverlayOptions[] = [];
    for (let index = 0; index < 4; index += 1) {
      overlays.push({
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360"><rect x="105" y="70" width="110" height="240" rx="30" fill="#ff00ff"/></svg>`),
        left: (index % 2) * 320,
        top: Math.floor(index / 2) * 360,
      });
    }
    const extracted = await extractPoseBoard(await boardWithOverlays(2, 2, overlays, key), {
      columns: 2,
      rows: 2,
      frameCount: 4,
      chromaKey: key,
    });
    expect(extracted.errors).toEqual([]);
    expect(extracted.diagnostics.every((item) => item.opaquePixels > 20_000)).toBe(true);
  });

  it("selects one chroma key against all uploaded reference palettes", async () => {
    const magentaReference = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    const greenReference = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#00ff00" } }).png().toBuffer();
    expect(await chooseChromaKey(
      [magentaReference, greenReference],
      ["#ff00ff", "#00ff00", "#0000ff"],
    )).toBe("#0000ff");
  });

  it("finds accidental transparent interior holes without treating the exterior as a hole", async () => {
    const ring = await sharp({
      create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208">
      <path fill="#2459c7" fill-rule="evenodd" d="M30 25H162V190H30Z M72 72H120V145H72Z"/>
    </svg>`) }]).png().toBuffer();
    const diagnostics = await inspectFrame(ring);
    expect(diagnostics.internalTransparentPixels).toBeGreaterThan(3_000);
    expect(diagnostics.errors).toContain("possible-transparent-holes");

    const intentional = await inspectFrame(ring, 0, { allowTransparentHoles: true });
    expect(intentional.errors).not.toContain("possible-transparent-holes");
    expect(intentional.warnings).toContain("possible-transparent-holes");
  });

  it("rejects detached foreground components unless the design explicitly opts in", async () => {
    const detached = await sharp({
      create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208">
      <rect x="30" y="40" width="82" height="140" rx="24" fill="#2459c7"/>
      <circle cx="150" cy="80" r="18" fill="#2459c7"/>
    </svg>`) }]).png().toBuffer();

    const diagnostics = await inspectFrame(detached);
    expect(diagnostics.componentCount).toBe(2);
    expect(diagnostics.errors).toContain("multiple-foreground-components");

    const intentional = await inspectFrame(detached, 0, { allowMultipleForegroundComponents: true });
    expect(intentional.errors).not.toContain("multiple-foreground-components");
    expect(intentional.warnings).toContain("multiple-foreground-components");
  });

  it("mirrors each frame without reversing animation order", async () => {
    const frames = [await solidFrame("#ff2200", 20), await solidFrame("#0044ff", 50)];
    const mirrored = await mirrorFramesPreservingOrder(frames);
    const first = await sharp(mirrored[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const second = await sharp(mirrored[1]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const firstPixel = (80 * first.info.width + 100) * first.info.channels;
    const secondPixel = (80 * second.info.width + 80) * second.info.channels;
    expect(first.data[firstPixel]).toBeGreaterThan(first.data[firstPixel + 2]);
    expect(second.data[secondPixel + 2]).toBeGreaterThan(second.data[secondPixel]);
  });

  it("assembles and validates an exact transparent 8x11 v2 atlas", async () => {
    const frame = await solidFrame();
    const byState: PetFramesByState = {};
    for (const spec of PET_ROW_SPECS) byState[spec.state] = Array.from({ length: spec.frameCount }, () => frame);
    const atlas = await assemblePetAtlas(byState, "png");
    const metadata = await sharp(atlas).metadata();
    expect([metadata.width, metadata.height]).toEqual([PET_ATLAS_WIDTH, PET_ATLAS_HEIGHT]);
    const validation = await validatePetAtlas(atlas, "#ff00ff");
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.cells.filter((cell) => !cell.expectedUsed).every((cell) => cell.opaquePixels === 0)).toBe(true);

    const contact = await createAtlasContactSheet(atlas);
    const directions = await createDirectionQaSheet(atlas);
    expect((await sharp(contact).metadata()).width).toBe(768);
    expect((await sharp(directions).metadata()).width).toBeGreaterThan(1000);
  });

  it("validates the 8x9 standard atlas before direction generation", async () => {
    const frame = await solidFrame();
    const byState: PetFramesByState = {};
    for (const spec of PET_ROW_SPECS.slice(0, 9)) byState[spec.state] = Array.from({ length: spec.frameCount }, () => frame);
    const atlas = await assembleStandardPetAtlas(byState, "png");
    const validation = await validateStandardPetAtlas(atlas);
    expect(validation).toMatchObject({ ok: true, intermediateOnly: true, width: 1536, height: 1872, rows: 9 });
    expect(validation.cells.filter((cell) => !cell.expectedUsed).every((cell) => cell.opaquePixels === 0)).toBe(true);

    const contaminated = await sharp(atlas).composite([{ input: frame, left: 7 * PET_CELL_WIDTH, top: 0 }]).png().toBuffer();
    const failed = await validateStandardPetAtlas(contaminated);
    expect(failed.ok).toBe(false);
    expect(failed.errors).toContain("idle[7]:unused-cell-not-transparent");
  });

  it("composes an ordered, label-free cardinal anchor strip", async () => {
    const frames = [
      await solidFrame("#ff0000", 20),
      await solidFrame("#00ff00", 40),
      await solidFrame("#0000ff", 60),
      await solidFrame("#ffff00", 80),
    ];
    const strip = await composeCardinalAnchorStrip(frames);
    const metadata = await sharp(strip).metadata();
    expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([384, 416, true]);
    const pixel = await sharp(strip).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number, channel: number) => pixel.data[(y * pixel.info.width + x) * pixel.info.channels + channel]!;
    // Each quadrant is deliberately sampled away from the transparent frame
    // margins; colours prove that the 000/090/180/270 order is stable.
    expect(at(70, 100, 0)).toBeGreaterThan(at(70, 100, 1));
    expect(at(250, 100, 1)).toBeGreaterThan(at(250, 100, 0));
    expect(at(70, 310, 2)).toBeGreaterThan(at(70, 310, 0));
    expect(at(300, 310, 0)).toBeGreaterThan(at(300, 310, 2));
  });

  it("measures every cyclic direction adjacency and keeps metric warnings non-semantic", async () => {
    const normal = await rectFrame();
    const jumped = await rectFrame({ x: 78, y: 10, width: 55, height: 112 });
    const byState: PetFramesByState = {};
    for (const spec of PET_ROW_SPECS) byState[spec.state] = Array.from({ length: spec.frameCount }, () => normal);
    byState["look-a"] = [normal, normal, normal, normal, normal, normal, normal, jumped];
    const atlas = await assemblePetAtlas(byState, "png");
    const report = await measureDirectionContinuity(atlas);

    expect(report.pairs).toHaveLength(16);
    expect(report.frames).toHaveLength(16);
    expect(report.pairs.map((pair) => `${pair.from}->${pair.to}`)).toContain("157.5->180");
    expect(report.pairs.map((pair) => `${pair.from}->${pair.to}`)).toContain("337.5->000");
    expect(report.pairs.find((pair) => pair.from === "157.5")?.crossesAtlasRowBoundary).toBe(true);
    expect(report.pairs.find((pair) => pair.from === "337.5")?.wrapsLoop).toBe(true);

    const boundary = report.pairs.find((pair) => pair.from === "157.5")!;
    expect(boundary.bboxCenterDelta?.distance).toBeGreaterThan(8);
    expect(boundary.bboxAreaRatio).toBeGreaterThan(1.15);
    expect(boundary.alphaDifferencePixels).toBeGreaterThan(0);
    expect(boundary.alphaDifferenceRatio).toBeGreaterThan(0);
    expect(boundary.baselineDeltaPixels).toBeGreaterThan(8);
    expect(boundary.warnings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "bbox-center-jump",
      "bbox-area-jump",
      "bbox-dimension-jump",
      "alpha-mass-jump",
      "alpha-difference-high",
      "baseline-jump",
    ]));
    expect(boundary.warnings[0]?.evidence).toBeTypeOf("object");
    expect(report.reviewRequired).toBe(true);
    expect(report.semanticAssessment).toBe("not-assessed");
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);

    const rowReport = await measureDirectionRowContinuity(
      byState["look-a"]!,
      ["000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5"],
    );
    expect(rowReport.frames).toHaveLength(8);
    expect(rowReport.pairs).toHaveLength(7);
    expect(rowReport.pairs.map((pair) => `${pair.from}->${pair.to}`)).not.toContain("157.5->180");
    expect(rowReport.ok).toBe(true);
  });

  it("emits playable animated WebP frames in order with exact durations", async () => {
    const frames = [
      await rectFrame({ color: "#ff0000" }),
      await rectFrame({ color: "#00ff00" }),
      await rectFrame({ color: "#0000ff" }),
    ];
    const durations = [80, 170, 290];
    const preview = await createAnimatedWebpPreview(frames, durations);
    const metadata = await sharp(preview.image, { animated: true }).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.pages).toBe(3);
    expect(metadata.pageHeight).toBe(PET_CELL_HEIGHT);
    expect(metadata.width).toBe(PET_CELL_WIDTH);
    expect(metadata.height).toBe(PET_CELL_HEIGHT * 3);
    expect(metadata.delay).toEqual(durations);
    expect(metadata.loop).toBe(0);
    expect(preview).toMatchObject({ frameCount: 3, durations, loop: 0, width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, mime: "image/webp" });

    const decoded = await sharp(preview.image, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const channelAt = (page: number, channel: number) => decoded.data[
      (((page * PET_CELL_HEIGHT + 80) * PET_CELL_WIDTH + 70) * decoded.info.channels) + channel
    ]!;
    expect(channelAt(0, 0)).toBeGreaterThan(channelAt(0, 1));
    expect(channelAt(1, 1)).toBeGreaterThan(channelAt(1, 0));
    expect(channelAt(2, 2)).toBeGreaterThan(channelAt(2, 0));

    const compatibility = await createAnimationPreviewStrip(frames.slice(0, 2), durations.slice(0, 2));
    expect((await sharp(compatibility.image, { animated: true }).metadata()).pages).toBe(2);
  });

  it("clears hidden RGB, despills keyed edge pixels and chooses a distant key", async () => {
    const reference = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#ff00ff" } }).png().toBuffer();
    expect(await chooseChromaKey(reference, ["#ff00ff", "#00ff00"])).toBe("#00ff00");
    const source = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#ff00ff" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="4" y="4" width="12" height="12" fill="#1357bb"/></svg>`) }])
      .png().toBuffer();
    const result = await despillChromaEdges(source, "#ff00ff");
    expect(result.report.algorithm).toBe("edge-local-nearest-interior-v1");
    expect(result.report.remainingOpaqueKeyPixels).toBeGreaterThan(0);
    expect(result.report.ok).toBe(false);
  });

  it("packages pet.json and spritesheet.webp and builds an encoded HTTPS install link", async () => {
    const frame = await solidFrame();
    const byState: PetFramesByState = {};
    for (const spec of PET_ROW_SPECS) byState[spec.state] = Array.from({ length: spec.frameCount }, () => frame);
    const atlas = await assemblePetAtlas(byState, "png");
    const packaged = await createCodexPetPackage({ id: "My Friendly Pet", displayName: "小蓝", description: "测试桌宠", spritesheet: atlas });
    expect(packaged.manifest.spriteVersionNumber).toBe(2);
    const inspected = await inspectCodexPetZip(packaged.zip);
    expect(inspected.manifest.id).toBe("my-friendly-pet");
    expect(inspected.spritesheetBytes).toBeGreaterThan(0);
    const link = buildCodexInstallDeepLink({ name: "小蓝 & Codex", description: "你好", imageUrl: "https://assets.example.test/pet.webp?sig=a%2Bb" });
    expect(link).toContain("spriteVersionNumber=2");
    expect(link).toContain("imageUrl=https%3A%2F%2Fassets.example.test");
    expect(() => buildCodexInstallDeepLink({ name: "bad", imageUrl: "http://example.test/pet.webp" })).toThrow(/HTTPS/);
  });

  it("rejects an opaque atlas at the package boundary", async () => {
    const opaque = await sharp({
      create: { width: PET_ATLAS_WIDTH, height: PET_ATLAS_HEIGHT, channels: 4, background: { r: 32, g: 64, b: 128, alpha: 1 } },
    }).png().toBuffer();
    await expect(createCodexPetPackage({ id: "opaque", displayName: "Opaque", spritesheet: opaque })).rejects.toThrow(/transparent pixels|transparent 1536x2288/);
  });

  it("rejects ZIPs with extra files or a manifest outside the pet root", async () => {
    const frame = await solidFrame();
    const byState: PetFramesByState = {};
    for (const spec of PET_ROW_SPECS) byState[spec.state] = Array.from({ length: spec.frameCount }, () => frame);
    const atlas = await assemblePetAtlas(byState, "png");
    const packaged = await createCodexPetPackage({ id: "strict-package", displayName: "Strict", spritesheet: atlas });

    const extra = await (async () => {
      const zip = await (await import("jszip")).default.loadAsync(packaged.zip);
      zip.file("strict-package/diagnostics.json", "private");
      return zip.generateAsync({ type: "nodebuffer" });
    })();
    await expect(inspectCodexPetZip(extra)).rejects.toThrow(/exactly pet\.json and spritesheet/);

    const misplaced = await (async () => {
      const zip = await (await import("jszip")).default.loadAsync(packaged.zip);
      const manifest = await zip.file("strict-package/pet.json")!.async("nodebuffer");
      zip.remove("strict-package/pet.json");
      zip.file("pet.json", manifest);
      return zip.generateAsync({ type: "nodebuffer" });
    })();
    await expect(inspectCodexPetZip(misplaced)).rejects.toThrow(/pet id directory|exactly one pet\.json/);
  });
});
