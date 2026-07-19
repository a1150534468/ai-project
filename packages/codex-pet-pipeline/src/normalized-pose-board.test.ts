import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { composeNormalizedPoseBoard } from "./assembly.js";
import { PET_CELL_HEIGHT, PET_CELL_WIDTH } from "./constants.js";

async function frame(color: string): Promise<Buffer> {
  return sharp({
    create: {
      width: PET_CELL_WIDTH,
      height: PET_CELL_HEIGHT,
      channels: 4,
      background: color,
    },
  }).png().toBuffer();
}

describe("composeNormalizedPoseBoard", () => {
  it("places cells in reading order and leaves unused slots chroma-only", async () => {
    const board = await composeNormalizedPoseBoard(
      [await frame("#ff0000"), await frame("#00ff00"), await frame("#ffffff")],
      { columns: 2, rows: 2, chromaKey: "#0000ff" },
    );
    const { data, info } = await sharp(board).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(PET_CELL_WIDTH * 2);
    expect(info.height).toBe(PET_CELL_HEIGHT * 2);
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 4)];
    };
    expect(pixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(PET_CELL_WIDTH + 10, 10)).toEqual([0, 255, 0, 255]);
    expect(pixel(10, PET_CELL_HEIGHT + 10)).toEqual([255, 255, 255, 255]);
    expect(pixel(PET_CELL_WIDTH + 10, PET_CELL_HEIGHT + 10)).toEqual([0, 0, 255, 255]);
  });
});
