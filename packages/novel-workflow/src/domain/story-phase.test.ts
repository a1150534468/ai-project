import { describe, expect, it } from "vitest";
import { resolveNovelStoryPhase } from "./story-phase.js";

describe("resolveNovelStoryPhase", () => {
  it("uses PlotPilot-compatible convergence thresholds", () => {
    expect(resolveNovelStoryPhase(0, 100).phase).toBe("opening");
    expect(resolveNovelStoryPhase(25, 100).phase).toBe("development");
    expect(resolveNovelStoryPhase(75, 100)).toMatchObject({ phase: "convergence", allowNewForeshadow: false });
    expect(resolveNovelStoryPhase(90, 100)).toMatchObject({ phase: "ending", maximumRevealLevel: "final" });
  });
});
