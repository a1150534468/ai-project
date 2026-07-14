import { describe, expect, it } from "vitest";
import { allocateNovelContext } from "./context-budget.js";

describe("allocateNovelContext", () => {
  it("keeps required constraints and drops lower-priority memory first", () => {
    const selected = allocateNovelContext([
      { id: "contract", layer: "contract", content: "c", estimatedTokens: 80, required: true },
      { id: "plan", layer: "chapterPlan", content: "p", estimatedTokens: 80 },
      { id: "memory", layer: "memory", content: "m", estimatedTokens: 80 },
    ], 160);
    expect(selected.map((item) => item.id)).toEqual(["contract", "plan"]);
  });
});
