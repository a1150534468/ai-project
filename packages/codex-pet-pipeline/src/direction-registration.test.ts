import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
  PET_ATLAS_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  registerFirstDirectionRowToNeutral,
  registerSecondDirectionRowWithManifest,
  validateNeutralLockedDirectionFrames,
} from "./index.js";

async function neutralCell(): Promise<Buffer> {
  return sharp({
    create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208">
    <rect x="54" y="30" width="84" height="166" rx="28" fill="#2459c7"/>
  </svg>`) }]).png().toBuffer();
}

async function directionBoard(bodyWidth: number, bodyHeight: number): Promise<Buffer> {
  const width = 1536;
  const height = 1024;
  const slotWidth = width / 4;
  const slotHeight = height / 2;
  const overlays = Array.from({ length: 8 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = Math.round(column * slotWidth + (slotWidth - bodyWidth) / 2);
    const y = Math.round((row + 1) * slotHeight - 42 - bodyHeight);
    return {
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect x="${x}" y="${y}" width="${bodyWidth}" height="${bodyHeight}" rx="36" fill="#2459c7"/>
      </svg>`),
    };
  });
  return sharp({ create: { width, height, channels: 4, background: "#ff00ff" } })
    .composite(overlays)
    .png()
    .toBuffer();
}

async function directionBoardWithEdgeResidue(): Promise<Buffer> {
  const board = await directionBoard(120, 300);
  return sharp(board).composite([{
    // This isolated pixel is in physical source slot 4, the fifth
    // chronological frame in the row-major board.
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024"><rect x="0" y="1023" width="1" height="1" fill="#ffffff"/></svg>`),
  }]).png().toBuffer();
}

async function coloredDirectionBoard(colors: readonly string[]): Promise<Buffer> {
  const width = 1536;
  const height = 1024;
  const slotWidth = width / 4;
  const slotHeight = height / 2;
  return sharp({ create: { width, height, channels: 4, background: "#ff00ff" } })
    .composite(colors.map((color, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = Math.round(column * slotWidth + (slotWidth - 120) / 2);
      const y = Math.round((row + 1) * slotHeight - 42 - 300);
      return { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="120" height="300" rx="36" fill="${color}"/></svg>`) };
    }))
    .png()
    .toBuffer();
}

function digests(frames: readonly Buffer[]): readonly string[] {
  return frames.map((frame) => createHash("sha256").update(frame).digest("hex"));
}

describe("neutral-locked direction registration", () => {
  it("registers row-major source slots in chronological direction order", async () => {
    const colors = ["#aa1100", "#bb2200", "#cc3300", "#dd4400", "#1155aa", "#2266bb", "#3377cc", "#4488dd"];
    const registered = await registerFirstDirectionRowToNeutral(await coloredDirectionBoard(colors), await neutralCell(), {
      chromaKey: "#ff00ff",
      frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT,
    });
    expect(registered.ok, registered.errors.join("; ")).toBe(true);
    const sampled = await Promise.all(registered.frames.map(async (frame, index) => {
      const bounds = registered.diagnostics[index]!.normalizedBounds!;
      const { data } = await sharp(frame).extract({
        left: Math.round(bounds.left + (bounds.width - 1) / 2),
        top: Math.round(bounds.top + (bounds.height - 1) / 2),
        width: 1,
        height: 1,
      }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return `#${[data[0], data[1], data[2]].map((value) => value!.toString(16).padStart(2, "0")).join("")}`;
    }));
    expect(sampled).toEqual(LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT.map((sourceSlot) => colors[sourceSlot]));
  });

  it("keeps approved row 9 byte-identical when an extremely wide row 10 is rejected", async () => {
    const neutral = await neutralCell();
    const first = await registerFirstDirectionRowToNeutral(await directionBoard(120, 300), neutral, {
      chromaKey: "#ff00ff",
    });
    expect(first.ok).toBe(true);
    expect((await sharp(first.registeredRow).metadata())).toMatchObject({ width: PET_ATLAS_WIDTH, height: PET_CELL_HEIGHT });
    const before = digests(first.frames);

    const second = await registerSecondDirectionRowWithManifest(await directionBoard(360, 300), neutral, first.manifest, {
      chromaKey: "#ff00ff",
    });

    expect(second.ok).toBe(false);
    expect(second.errors.some((error) => error.includes("registered-frame-outside-safe-margin") || error.includes("registered-near-edge-pixels"))).toBe(true);
    expect(second.manifest.transform.scale).toBe(first.manifest.transform.scale);
    expect(digests(first.frames)).toEqual(before);
  });

  it("rejects a direction family that remains materially smaller than neutral", async () => {
    const neutral = await neutralCell();
    const registered = await registerFirstDirectionRowToNeutral(await directionBoard(52, 88), neutral, {
      chromaKey: "#ff00ff",
    });
    expect(registered.ok).toBe(false);
    expect(registered.validation.medianHeightRatio).toBeLessThan(0.8);
    expect(registered.errors.some((error) => error.startsWith("look-scale-too-small:"))).toBe(true);
  });

  it("rejects persisted look cells that float above the approved neutral baseline", async () => {
    const neutral = await neutralCell();
    const registered = await registerFirstDirectionRowToNeutral(await directionBoard(120, 300), neutral, {
      chromaKey: "#ff00ff",
    });
    expect(registered.ok).toBe(true);
    const floating = await Promise.all(registered.frames.map((frame) => sharp({
      create: { width: PET_CELL_WIDTH, height: PET_CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: frame, left: 0, top: -12 }]).png().toBuffer()));

    const validation = await validateNeutralLockedDirectionFrames(neutral, floating);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes("floating-baseline-delta"))).toBe(true);
  });

  it("ignores insignificant slot-edge residue when deriving registration geometry", async () => {
    const registered = await registerFirstDirectionRowToNeutral(
      await directionBoardWithEdgeResidue(),
      await neutralCell(),
      { chromaKey: "#ff00ff", frameOrder: LOOK_BOARD_CHRONOLOGICAL_TO_SOURCE_SLOT },
    );

    expect(registered.ok, registered.errors.join("; ")).toBe(true);
    expect(registered.diagnostics[7]?.sourceGeometry?.bounds).toEqual(registered.diagnostics[7]?.sourceBounds);
    expect(registered.validation.frames[7]?.baselineDeltaPixels).toBe(0);
    expect(registered.validation.medianHeightRatio).toBeGreaterThanOrEqual(0.8);
  });
});
