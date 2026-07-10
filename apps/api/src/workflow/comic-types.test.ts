import { describe, expect, it } from "vitest";
import {
  COMIC_ASSET_TYPES,
  COMIC_WORKFLOW_STAGES,
  nextComicWorkflowStage,
  normalizeComicAssetIds,
} from "./comic-types.js";

describe("comic workflow types", () => {
  it("keeps the approved non-white-model stage order", () => {
    expect(COMIC_WORKFLOW_STAGES).toEqual(["script", "assets", "storyboard", "render"]);
  });

  it("advances through stages and stays on render at the end", () => {
    expect(nextComicWorkflowStage("script")).toBe("assets");
    expect(nextComicWorkflowStage("assets")).toBe("storyboard");
    expect(nextComicWorkflowStage("storyboard")).toBe("render");
    expect(nextComicWorkflowStage("render")).toBe("render");
  });

  it("normalizes shot asset ids without duplicates or empty values", () => {
    expect(normalizeComicAssetIds([" asset-1 ", "", "asset-2", "asset-1"])).toEqual(["asset-1", "asset-2"]);
  });

  it("keeps asset types scoped to comic production assets", () => {
    expect(COMIC_ASSET_TYPES).toEqual(["character", "scene", "prop", "style"]);
  });
});
