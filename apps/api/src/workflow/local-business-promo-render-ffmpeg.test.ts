import { describe, expect, it } from "vitest";
import { runCommand } from "./local-business-promo-render-ffmpeg.js";

describe("local-business-promo-render-ffmpeg", () => {
  it("times out long-running child processes", async () => {
    const startedAt = Date.now();
    await expect(runCommand("node", [
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 150,
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
