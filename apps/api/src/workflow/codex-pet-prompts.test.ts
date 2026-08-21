import { describe, expect, it } from "vitest";
import {
  buildBasePetPrompt,
  buildBaseChoiceQaContext,
  buildCardinalPrompt,
  buildJumpingQaEvidenceContext,
  buildLookMechanicsPrompt,
  buildLookRowPrompt,
  buildStandardRowPrompt,
  buildVisualQaPrompt,
  sanitizeCodexPetDirectionRepairPrompt,
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

  it("keeps character and per-action prompts isolated across every generation stage", () => {
    const actionPrompts = {
      idle: "ONLY_ACTION_A01",
      "running-right": "ONLY_ACTION_B02",
      "running-left": "ONLY_ACTION_C03",
      waving: "ONLY_ACTION_D04",
      jumping: "ONLY_ACTION_E05",
      failed: "ONLY_ACTION_F06",
      waiting: "ONLY_ACTION_G07",
      running: "ONLY_ACTION_H08",
      review: "ONLY_ACTION_I09",
      look: "ONLY_ACTION_J10",
    } as const;
    const customized = { ...identity, actionPrompts };
    const allMarkers = Object.values(actionPrompts);
    const base = buildBasePetPrompt(customized, 1);
    expect(base).toContain(identity.prompt);
    allMarkers.forEach((marker) => expect(base).not.toContain(marker));

    for (const [state, ownMarker] of Object.entries(actionPrompts).filter(([state]) => state !== "look")) {
      const row = buildStandardRowPrompt(customized, state as Exclude<keyof typeof actionPrompts, "look">);
      expect(row).not.toContain(identity.prompt);
      expect(row).toContain(ownMarker);
      allMarkers.filter((marker) => marker !== ownMarker).forEach((marker) => expect(row).not.toContain(marker));
    }

    const lookPrompts = [
      buildLookMechanicsPrompt(customized),
      buildCardinalPrompt(customized, "脚底固定"),
      buildLookRowPrompt(customized, "look-a", "脚底固定"),
      buildLookRowPrompt(customized, "look-b", "脚底固定"),
    ];
    for (const prompt of lookPrompts) {
      expect(prompt).toContain(actionPrompts.look);
      expect(prompt).not.toContain(identity.prompt);
      allMarkers.filter((marker) => marker !== actionPrompts.look).forEach((marker) => expect(prompt).not.toContain(marker));
    }
  });

  it("preserves the previous row prompts when no action customization is supplied", () => {
    expect(buildStandardRowPrompt(identity, "waving"))
      .toBe(buildStandardRowPrompt({ ...identity, actionPrompts: {} }, "waving"));
    expect(buildLookRowPrompt(identity, "look-a", "脚底固定"))
      .toBe(buildLookRowPrompt({ ...identity, actionPrompts: {} }, "look-a", "脚底固定"));
  });

  it("makes ds action prompts authoritative over conflicting default semantics", () => {
    const idleAction = "Standing, nodding off to sleep, with \"ZZZ\" floating above (sleeping indication)";
    const runningAction = "Sitting at a computer desk and typing on a keyboard";
    const customized = {
      ...identity,
      actionPrompts: { idle: idleAction, running: runningAction },
    };

    const idle = buildStandardRowPrompt(customized, "idle");
    expect(idle).toContain(`Authoritative user specification for this idle animation: ${idleAction}`);
    expect(idle).toContain("This specification replaces the default action semantics");
    expect(idle).toContain("short readable text");
    expect(idle).toContain("up to four separate opaque foreground components");
    expect(idle).not.toContain("Never wave, raise a hand, sleep");
    expect(idle).not.toContain("No text, labels, numbers");
    expect(idle).not.toContain("No detached effects");

    const running = buildStandardRowPrompt(customized, "running");
    expect(running).toContain(`Authoritative user specification for this running animation: ${runningAction}`);
    expect(running).not.toContain("must not add a device, paper, text or UI");
    expect(running).not.toContain("using the existing character only");

    const defaultIdle = buildStandardRowPrompt(identity, "idle");
    expect(defaultIdle).toContain("Never wave, raise a hand, sleep");
    expect(defaultIdle).toContain("No detached effects");
  });

  it("lets QA grade requested auxiliary content against the authoritative action", () => {
    const action = "Standing and sleeping with ZZZ floating above";
    const prompt = buildVisualQaPrompt("row", "idle 动作组", undefined, action);
    expect(prompt).toContain(`Authoritative user action specification: ${action}`);
    expect(prompt).toContain("Do not reject a requested short text cue");
    expect(prompt).toContain("unrequested detached residue");
    expect(prompt).not.toContain("visible guides, detached effects");

    const running = buildVisualQaPrompt("row", "running 动作组", undefined, "Dancing in place");
    expect(running).not.toContain("Codex state semantics are authoritative");
    expect(running).toContain("Dancing in place");
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
    expect(prompt).toContain("exactly one complete character contained wholly inside that slot");
    expect(prompt).toContain("continuous opaque non-background sprite pixels");
    expect(prompt).toContain("never leave a chroma-key gap at a shoulder, wrist, hip or ankle");
    expect(prompt).toContain("detached sweat beads");
    expect(prompt).toContain("alternates two source gait phases A/B");
    expect(prompt).toContain("At minimum alternate two clearly different contact/opposite-contact phases A/B");
    expect(prompt).toContain("A clean A/B/A/B/A/B/A/B two-phase loop is valid");
  });

  it("locks both look rows to the approved cardinal quadrants and exact board cells", () => {
    const lookA = buildLookRowPrompt(identity, "look-a", "脚底固定，头部随视线转动");
    expect(lookA).toContain("Image 1 is the primary 4×2 partial anchor storyboard");
    expect(lookA).toContain("physical bottom-left already contains approved Frame 5");
    expect(lookA).toContain("Every other chroma-only slot in Image 1 is intentionally blank for you to fill");
    expect(lookA).toContain("top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT");
    expect(lookA).toContain("000 UP means the character's natural front/aim points toward the top edge");
    expect(lookA).toContain("Do not reinterpret 000 as a front portrait or 180 as a rear portrait");
    expect(lookA).toContain("Frame 1 (physical top-left) MUST reproduce the approved 000 UP");
    expect(lookA).toContain("Frame 5 (physical bottom-left) MUST reproduce the approved 090 SCREEN-RIGHT");
    expect(lookA).toContain("Frame 8 (physical bottom-right) MUST be exactly one 22.5-degree step before the approved 180 DOWN");
    expect(lookA).toContain("Never enter the 270 SCREEN-LEFT pose family");
    expect(lookA).toContain("never make eyes, mouth, markings, limbs, props or tail teleport to the other side");
    expect(lookA).toContain("row-major board");
    expect(lookA).toContain("Frames 4 and 5 are the row-boundary neighbors in chronological order");
    expect(lookA).toContain("without a reset, mirror point or viewpoint jump");
    expect(lookA).toContain("Frame 2: rear view with only a slight SCREEN-RIGHT-side reveal");
    expect(lookA).toContain("Frame 5: exact approved 090 SCREEN-RIGHT profile");
    expect(lookA).toContain("This is one 157.5-degree half-turn, not a full 360-degree turntable");
    expect(lookA).toContain("No frame may use the approved 270 SCREEN-LEFT family");

    const lookB = buildLookRowPrompt(identity, "look-b", "脚底固定，头部随视线转动");
    expect(lookB).toContain("Frame 1 (physical top-left) MUST reproduce the approved 180 DOWN");
    expect(lookB).toContain("Frame 5 (physical bottom-left) MUST reproduce the approved 270 SCREEN-LEFT");
    expect(lookB).toContain("Frame 8 (physical bottom-right) MUST be exactly one 22.5-degree step before the approved 000 UP");
    expect(lookB).toContain("Never enter the 090 SCREEN-RIGHT pose family");
    expect(lookB).toContain("Continue exactly one step after the approved 157.5 pose");
    expect(lookB).toContain("keep its viewer/screen side monotonic across this arc");
    expect(lookB).toContain("must never jump to screen-right");
    expect(lookB).toContain("primary full 4×2 SCREEN-LEFT trajectory scaffold");
    expect(lookB).toContain("reference-only evidence assembled from the approved 180 DOWN and 270 SCREEN-LEFT cardinals");
    expect(lookB).toContain("Redraw all eight poses as one fresh coherent family");
    expect(lookB).toContain("Frame 2: front view with only a slight SCREEN-LEFT-side turn");
    expect(lookB).toContain("Frame 5: exact approved 270 SCREEN-LEFT profile");
    expect(lookB).toContain("No frame may use the approved 090 SCREEN-RIGHT family");
  });

  it("fixes cardinal appearance to screen-heading semantics", () => {
    const cardinal = buildCardinalPrompt(identity, "脚底固定，头部和眼睛随屏幕方向转动");
    expect(cardinal).toContain("000 UP means the character's natural front/aim points toward the top edge");
    expect(cardinal).toContain("180 DOWN means the natural front/aim points toward the bottom edge");
    expect(cardinal).toContain("Do not reinterpret 000 as a front portrait or 180 as a rear portrait");

    const qa = buildVisualQaPrompt("cardinals", "四个方向锚点");
    expect(qa).toContain("the normalized board's physical cells are top-left 000, top-right 090, bottom-left 180, bottom-right 270");
    expect(qa).toContain("a front/back reversal is a hard failure");
  });

  it("rejects repair diagnostics that reverse the approved 000/180 contract", () => {
    const accepted = sanitizeCodexPetDirectionRepairPrompt("Keep 090 screen-right and 270 screen-left distinct");
    expect(accepted).toContain("090 SCREEN-RIGHT");
    expect(accepted).toContain("Accepted non-conflicting repair evidence");

    const rejected = sanitizeCodexPetDirectionRepairPrompt("Make 000 front-facing and 180 a rear portrait");
    expect(rejected).toContain("diagnostic was discarded");
    expect(rejected).toContain("000 UP means the character's natural front/aim points toward the top edge");
    expect(rejected).not.toContain("Make 000 front-facing");
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

  it("keeps idle awake and limits blinking to one brief pose", () => {
    const idle = buildStandardRowPrompt(identity, "idle");
    expect(idle).toContain("frame 5 the single brief blink");
    expect(idle).toContain("Treat frame 1 as the non-facial pixel master");
    expect(idle).toContain("Lock the complete outer silhouette pixel-for-pixel across all six frames");
    expect(idle).toContain("no head, helmet, torso, arm, hand, leg, foot or whole-character translation");
    expect(idle).toContain("the shaft and its round terminal tip are one complete identity structure");
    expect(idle).toContain("even after the board continues onto its second row");
    expect(idle).toContain("relocate it below another character as a loose dot");
    expect(idle).toContain("Keep the single canonical antenna perfectly fixed and unchanged");
    expect(idle).toContain("bend the shaft, duplicate it, echo it");
    expect(idle).toContain("A singular feature such as one antenna");
    expect(idle).toContain("Keep both arms lowered and attached in all six frames");
    expect(idle).toContain("Never wave, raise a hand, sleep");
    expect(idle).toContain("Never merge the top and bottom slots into one tall character");
  });

  it("locks every directional run frame to one screen side and an explicit phase cycle", () => {
    const right = buildStandardRowPrompt(identity, "running-right");
    expect(right).toContain("rigid right-facing head, antenna and torso orientation");
    expect(right).toContain("may never turn toward the viewer, screen-left or the back");
    expect(right).toContain("A clean A/B/A/B/A/B/A/B two-phase loop is valid");
    expect(right).toContain("Never yaw the head or torso toward front, back or the opposite side in frames 4, 5 or 8");
    expect(right).toContain("Keep the canonical dark face panel fully filled as opaque foreground");
    expect(right).toContain("leave the eyes and mouth floating separately");
    expect(right).toContain("The chroma key #0000ff is reserved exclusively for exterior background");
    expect(right).toContain("No exact or near-key pixel may appear anywhere inside a character's bounding box");
    expect(right).toContain("redraw the eight slots in place");
    expect(right).toContain("Never keep a scaffold pose and add a second head, body or character above or below it");
    expect(right).toContain("exactly 8 total heads and exactly 8 total bodies");
    expect(right).toContain("exactly 8 complete characters and no partial duplicates");
    expect(right).toContain("Never repeat one frozen stride");

    const left = buildStandardRowPrompt(identity, "running-left");
    expect(left).toContain("rigid left-facing head, antenna and torso orientation");
    expect(left).toContain("may never turn toward the viewer, screen-right or the back");
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

  it("keeps the non-directional running state focused on active task work", () => {
    const generation = buildStandardRowPrompt(identity, "running");
    expect(generation).toContain("this is not physical running, walking or jogging");

    const rowQa = buildVisualQaPrompt("row", "running 动作组：身份、6 帧结构、动作语义和连续性");
    expect(rowQa).toContain("means active task processing, not physical locomotion");
    expect(rowQa).toContain("Never require or reward alternating leg stride");
    expect(rowQa).toContain("those are wrong-action failures");

    const directionalQa = buildVisualQaPrompt("row", "running-right 动作组");
    expect(directionalQa).not.toContain("means active task processing, not physical locomotion");
    expect(buildVisualQaPrompt("final", "完整 v2 atlas")).toContain("means active task processing, not physical locomotion");
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
