import { describe, expect, it } from "vitest";
import {
  buildBasePetPrompt,
  buildBaseChoiceQaContext,
  buildJumpingQaEvidenceContext,
  buildLookRowPrompt,
  buildStandardRowPrompt,
  buildVisualQaPrompt,
  type CodexPetJumpingQaEvidence,
  type CodexPetVisualIdentity,
} from "./codex-pet-prompts.js";

const identity: CodexPetVisualIdentity = {
  name: "测试喵",
  description: "一段产品背景描述",
  prompt: "很长的叙事设定，不应在姿势编辑时重新解释",
  stylePreset: "pixel",
  styleNotes: "保留蓝眼睛",
  chromaKey: "#0000ff",
};

describe("Codex pet prompts", () => {
  it("uses the full brief to establish the base character", () => {
    const prompt = buildBasePetPrompt(identity, 1);
    expect(prompt).toContain(identity.description);
    expect(prompt).toContain(identity.prompt);
    expect(prompt).toContain("animation-safe");
    expect(prompt).toContain("temporary gesture");
    expect(prompt).toContain("both paws relaxed, visibly attached, and lowered away from the eyes and mouth");
    expect(prompt).toContain("Do not copy an action pose as the canonical base");
  });

  it("uses original references to disambiguate base anatomy without weakening structure gates", () => {
    const context = buildBaseChoiceQaContext(2);
    expect(context).toContain("Image 1 is Candidate 2");
    expect(context).toContain("original references in upload order");
    expect(context).toContain("same shape, color, connection and location as a real paw");
    expect(context).toContain("they are not acceptance examples and cannot waive defects in image 1");
    expect(context).toContain("both eyes and mouth unobscured");
    expect(context).toContain("must never excuse a non-neutral gesture");
    expect(context).toContain("fail every concrete identity, anatomy, connectivity, clipping, readability or reproducibility blocker");
  });

  it("makes the canonical image authoritative for pose edits", () => {
    const prompt = buildStandardRowPrompt(identity, "running-right");
    expect(prompt).not.toContain(identity.description);
    expect(prompt).not.toContain(identity.prompt);
    expect(prompt).toContain("sole visual source of truth");
    expect(prompt).toContain("facing screen-right");
    expect(prompt).toContain("fixed part of the character");
    expect(prompt).toContain("one stable foot baseline");
    expect(prompt).toContain("at least 15% clear background");
  });

  it("locks both look rows to the approved cardinal quadrants and exact board cells", () => {
    const lookA = buildLookRowPrompt(identity, "look-a", "脚底固定，头部随视线转动");
    expect(lookA).toContain("Image 1 is the primary 4×2 partial anchor storyboard");
    expect(lookA).toContain("physical bottom-right already contains approved Frame 5");
    expect(lookA).toContain("Every other chroma-only slot in Image 1 is intentionally blank for you to fill");
    expect(lookA).toContain("top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT");
    expect(lookA).toContain("Frame 1 (physical top-left) MUST reproduce the approved 000 UP");
    expect(lookA).toContain("Frame 5 (physical bottom-right) MUST reproduce the approved 090 SCREEN-RIGHT");
    expect(lookA).toContain("Frame 8 (physical bottom-left) MUST be exactly one 22.5-degree step before the approved 180 DOWN");
    expect(lookA).toContain("Never enter the 270 SCREEN-LEFT pose family");
    expect(lookA).toContain("never make eyes, mouth, markings, limbs, props or tail teleport to the other side");
    expect(lookA).toContain("SERPENTINE board");
    expect(lookA).toContain("physical bottom row, read left-to-right, is frames 8, 7, 6, 5");
    expect(lookA).toContain("Frames 4 and 5 are vertically adjacent at the physical right edge");
    expect(lookA).toContain("the row change is never a reset, mirror point or viewpoint jump");

    const lookB = buildLookRowPrompt(identity, "look-b", "脚底固定，头部随视线转动");
    expect(lookB).toContain("Frame 1 (physical top-left) MUST reproduce the approved 180 DOWN");
    expect(lookB).toContain("Frame 5 (physical bottom-right) MUST reproduce the approved 270 SCREEN-LEFT");
    expect(lookB).toContain("Frame 8 (physical bottom-left) MUST be exactly one 22.5-degree step before the approved 000 UP");
    expect(lookB).toContain("Never enter the 090 SCREEN-RIGHT pose family");
    expect(lookB).toContain("Continue exactly one step after the approved 157.5 pose");
  });

  it("injects the approved anatomy guide only after base generation", () => {
    const guide = "头：圆形；眼：两只白眼；固定花纹：额头一点；歧义：额头点不是眼睛。";
    const guided = { ...identity, canonicalGuide: guide };
    expect(buildBasePetPrompt(guided, 1)).not.toContain(guide);
    expect(buildStandardRowPrompt(guided, "idle")).toContain(guide);
    expect(buildVisualQaPrompt("row", "idle", guide)).toContain(guide);
    expect(buildStandardRowPrompt(guided, "idle")).toContain("does not have to move in every animation or every frame");
    expect(buildVisualQaPrompt("row", "idle", guide)).toContain("do not fail a state just because that feature stays still");
    expect(buildVisualQaPrompt("base-choice", "candidate")).not.toContain(guide);
  });

  it("keeps jumping vertical travel distinct from scale and locks failed silhouettes", () => {
    const jumping = buildStandardRowPrompt(identity, "jumping");
    expect(jumping).toContain("single unmistakable highest peak");
    expect(jumping).toContain("frame 2 clearly airborne and rising");
    expect(jumping).toContain("frame 4 clearly airborne and descending");
    expect(jumping).toContain("monotonic up-up-down-down path");
    expect(jumping).toContain("5 columns × 1 row pose board");
    expect(jumping).toContain("frame 4 airborne descent visibly lower than frame 3");
    expect(jumping).toContain("Use all five slots and never reorder the phases");
    expect(jumping).toContain("never zoom, squash or stretch");

    const failed = buildStandardRowPrompt(identity, "failed");
    expect(failed).toContain("never bend, lower, round or reshape ears");
    expect(failed).toContain("narrow or lower the eyes");

    const failedQa = buildVisualQaPrompt("row", "failed 动作组", "眼：蓝色；四肢：棕色前爪；可动特征：眼睛、前爪");
    expect(failedQa).toContain("“failed” is a sad/error reaction, not an idle blink");
    expect(failedQa).toContain("may hold the defeated expression for several frames");
    expect(failedQa).toContain("Do not require the tail, ears or every other movable feature");
    expect(failedQa).toContain("name only that current action in repairRows");
  });

  it("binds jumping visual QA to shared-scale evidence instead of top, bottom or Y travel", () => {
    const evidence: CodexPetJumpingQaEvidence = {
      sharedScale: 0.742,
      // A tall peak/extended pose can increase height while width remains
      // stable; this must not be relabeled as proportional raster zoom.
      widthRatio: 1.018,
      heightRatio: 1.31,
      centerSpreadPixels: 0.8,
      normalizedFrames: [
        { frame: 1, width: 92, height: 126 },
        { frame: 2, width: 93, height: 139 },
        { frame: 3, width: 92, height: 165 },
        { frame: 4, width: 92, height: 141 },
        { frame: 5, width: 93, height: 127 },
      ],
      jumpingFrames: [
        { frame: 1, centerY: 132, groundY: 185, bodySpan: 104 },
        { frame: 2, centerY: 105, groundY: 158, bodySpan: 111 },
        { frame: 3, centerY: 72, groundY: 132, bodySpan: 126 },
        { frame: 4, centerY: 104, groundY: 157, bodySpan: 113 },
        { frame: 5, centerY: 131, groundY: 184, bodySpan: 105 },
      ],
    };
    const context = buildJumpingQaEvidenceContext(evidence);
    const prompt = buildVisualQaPrompt("row", `jumping 动作组。${context}`);

    expect(context).toContain("one shared raster scale=0.7420 was applied identically to every frame");
    expect(context).toContain("widthRatio=1.018 (near 1; this contradicts a uniform width-and-height zoom claim)");
    expect(context).toContain("heightRatio=1.310");
    expect(context).toContain("normalizedSizes=[f1=92x126,f2=93x139,f3=92x165,f4=92x141,f5=93x127]");
    expect(context).toContain("f3(centerY=72.0,groundY=132.0,bodySpan=126.0)");
    expect(prompt).toContain("never infer zoom or a baseline defect from sprite top/bottom, centerY, airborne groundY, or required vertical travel");
    expect(prompt).toContain("Overall normalized height/bodySpan may change because legs and body posture");
    expect(prompt).toContain("Only grounded frames 1 and 5 define the practical ground baseline");
    expect(prompt).toContain("Only fail scale/identity when rigid identity anchors such as head width, ear spacing, and torso width visibly enlarge together");
    expect(prompt).toContain("request independent adjudication");
    expect(context.length).toBeLessThan(1_800);
  });
});
