import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PET_CELL_HEIGHT, PET_CELL_WIDTH, validateJumpingArc } from "./index.js";

async function jumpingFrame(bodyTop: number, legHeight: number): Promise<Buffer> {
  const bodyBottom = bodyTop + 82;
  return sharp({
    create: {
      width: PET_CELL_WIDTH,
      height: PET_CELL_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208">
    <rect x="48" y="${bodyTop}" width="96" height="82" rx="28" fill="#2459c7"/>
    <rect x="61" y="${bodyBottom - 8}" width="25" height="${legHeight}" rx="9" fill="#2459c7"/>
    <rect x="106" y="${bodyBottom - 8}" width="25" height="${Math.max(10, legHeight - 4)}" rx="9" fill="#2459c7"/>
  </svg>`) }]).png().toBuffer();
}

describe("jumping arc gate", () => {
  it("accepts grounded anticipation, rise, unique peak, descent and grounded settle despite changing leg poses", async () => {
    const frames = await Promise.all([
      jumpingFrame(79, 30),
      jumpingFrame(57, 22),
      jumpingFrame(29, 18),
      jumpingFrame(56, 26),
      jumpingFrame(80, 28),
    ]);

    const result = await validateJumpingArc(frames);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.positions.map((position) => position.centerY)).toEqual([125, 100, 71, 100, 125]);
    expect(result.thresholds).toEqual({
      groundTolerancePixels: 6,
      visibleRisePixels: 8,
      peakSeparationPixels: 7,
      peakLiftPixels: 18,
    });
  });

  it("rejects a static five-frame row", async () => {
    const frames = await Promise.all([
      jumpingFrame(79, 30),
      jumpingFrame(79, 22),
      jumpingFrame(79, 18),
      jumpingFrame(79, 26),
      jumpingFrame(80, 28),
    ]);

    const result = await validateJumpingArc(frames);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("jumping-arc:frame-2-rise-too-small:"))).toBe(true);
    expect(result.errors.some((error) => error.startsWith("jumping-arc:peak-lift-too-small:"))).toBe(true);
  });

  it("rejects idle-idle-peak-idle-idle even when frame 3 has enough total lift", async () => {
    const frames = await Promise.all([
      jumpingFrame(79, 30),
      jumpingFrame(79, 22),
      jumpingFrame(29, 18),
      jumpingFrame(79, 26),
      jumpingFrame(80, 28),
    ]);

    const result = await validateJumpingArc(frames);

    expect(result.peakLiftPixels).toBeGreaterThan(result.thresholds!.peakLiftPixels);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("jumping-arc:frame-2-rise-too-small:"))).toBe(true);
    expect(result.errors.some((error) => error.startsWith("jumping-arc:frame-4-not-airborne-before-settle:"))).toBe(true);
  });
});
