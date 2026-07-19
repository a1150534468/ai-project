import { LOOK_DIRECTIONS, petRowSpec, type PetRowSpec } from "@ai-assistant/codex-pet-pipeline";

export const CODEX_PET_STYLES = [
  "auto",
  "pixel",
  "plush",
  "clay",
  "sticker",
  "flat-illustration",
  "3d-toy",
  "painterly",
] as const;

export type CodexPetStyle = (typeof CODEX_PET_STYLES)[number];

export interface CodexPetVisualIdentity {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly stylePreset: string;
  readonly styleNotes: string;
  readonly chromaKey: string;
  /** Persisted after the user or visual QA approves the canonical base image. */
  canonicalGuide?: string;
}

export interface CodexPetJumpingQaEvidence {
  readonly sharedScale: number;
  readonly widthRatio: number | null;
  readonly heightRatio: number | null;
  readonly centerSpreadPixels: number | null;
  readonly normalizedFrames: readonly {
    /** One-based reading-order frame number. */
    readonly frame: number;
    readonly width: number | null;
    readonly height: number | null;
  }[];
  readonly jumpingFrames: readonly {
    /** One-based reading-order frame number. */
    readonly frame: number;
    readonly centerY: number | null;
    readonly groundY: number | null;
    readonly bodySpan: number | null;
  }[];
}

function qaMetric(value: number | null, digits = 1): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/**
 * Convert deterministic production-frame geometry into a compact, binding
 * context block for buildVisualQaPrompt. This keeps the multimodal reviewer
 * from mistaking the required jump arc or pose-dependent silhouette changes
 * for raster zoom/baseline drift.
 */
export function buildJumpingQaEvidenceContext(evidence: CodexPetJumpingQaEvidence): string {
  const normalizedFrames = evidence.normalizedFrames
    .map((frame) => `f${frame.frame}=${qaMetric(frame.width, 0)}x${qaMetric(frame.height, 0)}`)
    .join(",");
  const jumpingFrames = evidence.jumpingFrames
    .map((frame) => (
      `f${frame.frame}(centerY=${qaMetric(frame.centerY)},groundY=${qaMetric(frame.groundY)},bodySpan=${qaMetric(frame.bodySpan)})`
    ))
    .join(",");
  const widthRatioMeaning = evidence.widthRatio !== null
    && Number.isFinite(evidence.widthRatio)
    && evidence.widthRatio <= 1.08
    ? "near 1; this contradicts a uniform width-and-height zoom claim"
    : "review rigid identity anchors before inferring scale change";

  return [
    "Deterministic jumping geometry (normalized production cells):",
    `one shared raster scale=${qaMetric(evidence.sharedScale, 4)} was applied identically to every frame; widthRatio=${qaMetric(evidence.widthRatio, 3)} (${widthRatioMeaning}); heightRatio=${qaMetric(evidence.heightRatio, 3)}; horizontalCenterSpread=${qaMetric(evidence.centerSpreadPixels)}px; normalizedSizes=[${normalizedFrames || "n/a"}]; jumpY=[${jumpingFrames || "n/a"}].`,
    "Interpretation contract: never infer zoom or a baseline defect from sprite top/bottom, centerY, airborne groundY, or required vertical travel. Overall normalized height/bodySpan may change because legs and body posture anticipate, extend, tuck, and settle; that alone is not zoom, squash, or stretch. Only grounded frames 1 and 5 define the practical ground baseline.",
    "Only fail scale/identity when rigid identity anchors such as head width, ear spacing, and torso width visibly enlarge together, or when the character visibly squashes/stretches. In particular, widthRatio near 1 cannot support a proportional width-and-height zoom finding.",
    "If a visual impression contradicts this deterministic evidence, request independent adjudication and report the conflict as a warning; do not fail zoom/baseline on the contradictory impression alone",
  ].join(" ");
}

const STATE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  idle: "calm breathing/blinking micro-motion; frames must visibly vary but remain quiet",
  "running-right": "directional locomotion with every frame unmistakably facing screen-right in side or three-quarter profile; the muzzle, gaze and leading limbs point right and the gait clearly alternates",
  "running-left": "directional locomotion with every frame unmistakably facing screen-left in side or three-quarter profile; the muzzle, gaze and leading limbs point left and the gait clearly alternates",
  waving: "a friendly wave expressed only by the limb pose, rising and returning",
  jumping: "exactly one five-frame arc in reading order: frame 1 grounded anticipation; frame 2 clearly airborne and rising, with the whole-body center roughly halfway between ground and peak; frame 3 the single unmistakable highest peak; frame 4 clearly airborne and descending, visibly below the peak but still roughly halfway above ground; frame 5 grounded settle. The whole-body center must follow a monotonic up-up-down-down path—never make frames 2 or 4 ground-level copies or near-duplicates of the peak. Keep identical body size and head/ear silhouette in every frame and show the jump through vertical position and leg pose only, never zoom, squash or stretch the character",
  failed: "one coherent eight-frame sad/error loop: begin neutral, progressively narrow or lower the eyes and droop the attached paws/upper-body pose, hold the readable defeated expression, then recover; keep the body size and every identity-defining outer contour identical—never bend, lower, round or reshape ears, hair, head silhouette, markings or props",
  waiting: "one coherent expectant loop that clearly requests approval: look toward the viewer, make one small attached paw/ear/head asking gesture, then return; every limb and tail stays connected to the body",
  running: "one coherent focused task-processing loop using the existing character only: eyes scan, head makes a small attentive shift and attached paws make a subtle working/tapping gesture before returning; keep the feet/base fixed—this is not physical running, walking or jogging and must not add a device, paper, text or UI",
  review: "focused inspection through eyes, head tilt, lean or existing limb/prop position",
};

function styleDescription(style: string): string {
  switch (style) {
    case "pixel": return "crisp pixel-art sprite with deliberately sized pixels and no anti-aliased scenery";
    case "plush": return "soft handcrafted plush mascot with readable stitched details";
    case "clay": return "compact clay character with clean solid forms";
    case "sticker": return "bold sticker illustration with a connected silhouette";
    case "flat-illustration": return "flat illustrated mascot with large readable shapes";
    case "3d-toy": return "compact 3D collectible-toy mascot with clean materials";
    case "painterly": return "painterly mascot with controlled hard sprite edges and readable details";
    default: return "infer the most suitable pet-safe style from the supplied description and reference images";
  }
}

function canonicalGuideBlock(identity: CodexPetVisualIdentity): string {
  const guide = identity.canonicalGuide?.trim();
  return guide
    ? `Approved canonical anatomy and identity guide:\n${guide}\nTreat this guide as authoritative when distinguishing anatomy (especially eyes, paws/feet and mouth) from fixed markings. Preserve fixed features. A feature listed as movable is merely allowed to move when the requested action naturally needs it; it does not have to move in every animation or every frame.`
    : "";
}

function identityBlock(identity: CodexPetVisualIdentity): string {
  return [
    `Character name: ${identity.name}.`,
    identity.description ? `Description: ${identity.description}.` : "",
    identity.prompt ? `Authoritative character brief: ${identity.prompt}.` : "",
    `Visual style: ${styleDescription(identity.stylePreset)}.`,
    identity.styleNotes ? `Additional style constraint: ${identity.styleNotes}.` : "",
    "Keep exactly the same face, head shape, body proportions, palette, markings, material, silhouette, clothing and props as the supplied canonical character reference.",
  ].filter(Boolean).join("\n");
}

function canonicalReferenceBlock(identity: CodexPetVisualIdentity): string {
  return [
    `Character name: ${identity.name}.`,
    `Visual style: ${styleDescription(identity.stylePreset)}.`,
    identity.styleNotes ? `Additional style constraint: ${identity.styleNotes}.` : "",
    "The first attached canonical character image is the sole visual source of truth for this animation. Do not redesign it from the longer text brief.",
    "Keep exactly the same face, head shape, body proportions, palette, marking count and topology, material, silhouette, clothing and props in every pose.",
    "Treat every stripe, patch and symbol-like body mark as a fixed part of the character: never rewrite, add, remove or substitute it between frames.",
    canonicalGuideBlock(identity),
  ].filter(Boolean).join("\n");
}

const GLOBAL_SPRITE_RULES = [
  "Create production sprite source art, not a presentation sheet.",
  "Use one perfectly flat solid chroma background and keep every character color clearly different from it.",
  "Show the complete whole body with generous padding. Nothing may touch or cross a slot or outer canvas edge.",
  "No text, labels, numbers, logos, borders, visible grid, scenery, floor, cast shadow, glow, halo, blur or transparency checkerboard.",
  "No detached effects: no motion lines, dust, floating icons, punctuation, stars or separate droplets.",
  "Every pose must be one readable connected sprite component. Preserve identity and scale across all poses.",
].join("\n");

export function buildBasePetPrompt(identity: CodexPetVisualIdentity, candidateIndex: number): string {
  const variation = candidateIndex === 1
    ? "Use a calm front-facing stance with both paws relaxed, visibly attached, and lowered away from the eyes and mouth."
    : "Use a calm slight three-quarter stance with both paws relaxed, visibly attached, and kept away from the eyes and mouth.";
  return `${identityBlock(identity)}

Create one centered neutral full-body main character candidate on a flat ${identity.chromaKey} background. Candidate variation ${candidateIndex}: ${variation} Vary only this restrained pose/expression detail, never the character identity. The character must remain readable inside a final 192×208 desktop-pet cell.
An attached reference may show a temporary gesture, including paws crossing the face or torso. Preserve the character's real anatomy, paw shape, colors and fixed markings, but translate that temporary gesture into the neutral stance above. Do not copy an action pose as the canonical base. Make every limb-to-body attachment visually unambiguous.
Preserve defining marks from supplied references, but do not invent tiny decorative marks, letter-like strokes or extra accessories. Prefer a connected, animation-safe design whose important details can remain identical across many poses.

${GLOBAL_SPRITE_RULES}`;
}

export function buildBaseChoiceQaContext(candidateIndex: number): string {
  return `Image 1 is Candidate ${candidateIndex}. Images 2 onward, when present, are the user's original references in upload order. They explain feature categories, identity, anatomy, fixed markings and temporary gestures; they are not acceptance examples and cannot waive defects in image 1. Score image 1 independently for identity consistency, pet-size readability, a clean whole-body silhouette and animation reproducibility. The candidate itself must be a calm neutral canonical pose with both eyes and mouth unobscured, both forelimbs visibly attached, and no paw/arm crossing the face or torso. Copying a temporary reference gesture is a semantics/structure failure even when it is faithful. Use the references only to avoid relabeling a visible shape as text, a logo or a decorative glyph when they show the same shape, color, connection and location as a real paw, arm, mouth or fixed marking. They must never excuse a non-neutral gesture, self-occlusion, ambiguous attachment, disconnection, crop, slot overlap or unreadable anatomy in the candidate. This is one static canonical image: continuity means whether its design can be reproduced across future poses, not whether multiple time frames are present. Prefer a faithful candidate with stable large details; fail every concrete identity, anatomy, connectivity, clipping, readability or reproducibility blocker.`;
}

export function buildStandardRowPrompt(identity: CodexPetVisualIdentity, state: PetRowSpec["state"]): string {
  if (state === "look-a" || state === "look-b") throw new Error("Use buildLookRowPrompt for look rows");
  const spec = petRowSpec(state);
  const unused = spec.frameCount < spec.boardColumns * spec.boardRows
    ? `Leave the final ${spec.boardColumns * spec.boardRows - spec.frameCount} slot completely empty with only chroma background.`
    : "Use every slot.";
  const jumpingSlotMap = state === "jumping"
    ? "For this 5×1 board the exact left-to-right mapping is: frame 1 grounded anticipation; frame 2 airborne rise; frame 3 the unique highest peak; frame 4 airborne descent visibly lower than frame 3; frame 5 grounded settle on the same foot baseline as frame 1. Use all five slots and never reorder the phases."
    : "";
  const rowWord = spec.boardRows === 1 ? "row" : "rows";
  return `${canonicalReferenceBlock(identity)}

Generate exactly ${spec.frameCount} separated sequential poses for the “${state}” animation as a ${spec.boardColumns} columns × ${spec.boardRows} ${rowWord} pose board, read left-to-right then top-to-bottom. Action: ${STATE_INSTRUCTIONS[state]}.
${jumpingSlotMap}
${unused}
All poses share one scale. ${state === "jumping"
    ? "Show clear vertical lift and descent through body height."
    : "Keep the character horizontally centered on one stable foot baseline in every slot; express motion through the pose, not by moving the sprite around the board."} Scale down wide or extreme poses as needed so the complete silhouette keeps at least 15% clear background from every slot boundary. The attached layout is construction guidance only and must not appear in the result.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildCardinalPrompt(identity: CodexPetVisualIdentity, mechanics: string): string {
  return `${canonicalReferenceBlock(identity)}

Look mechanics: ${mechanics}

Generate exactly four separated cardinal looking poses as a 2×2 board, in this order: 000 looking UP, 090 looking toward SCREEN-RIGHT, 180 looking DOWN, 270 looking toward SCREEN-LEFT. These are viewer/screen coordinates. Make each cardinal unmistakable at 192×208 while preserving a stable lower-body anchor. Use eyes, eyelids, head, face, upper body, appendages and existing props only as physically natural for this character.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookRowPrompt(identity: CodexPetVisualIdentity, row: "look-a" | "look-b", mechanics: string): string {
  const directions = row === "look-a" ? LOOK_DIRECTIONS.slice(0, 8) : LOOK_DIRECTIONS.slice(8);
  const continuity = row === "look-a"
    ? `Use this exact anchor path:
- Frame 1 (physical top-left) MUST reproduce the approved 000 UP pose family from the cardinal reference's top-left cell.
- Frame 5 (physical bottom-right) MUST reproduce the approved 090 SCREEN-RIGHT pose family from the cardinal reference's top-right cell.
- Frame 8 (physical bottom-left) MUST be exactly one 22.5-degree step before the approved 180 DOWN pose family from the cardinal reference's bottom-left cell; it is not yet 180.
- Frames 1 through 8 may advance only along 000 UP -> 090 SCREEN-RIGHT -> almost 180 DOWN. Never enter the 270 SCREEN-LEFT pose family, never reverse into the opposite facial quadrant, and never make eyes, mouth, markings, limbs, props or tail teleport to the other side between adjacent frames.`
    : `Use this exact anchor path:
- Frame 1 (physical top-left) MUST reproduce the approved 180 DOWN pose family from the cardinal reference's bottom-left cell.
- Frame 5 (physical bottom-right) MUST reproduce the approved 270 SCREEN-LEFT pose family from the cardinal reference's bottom-right cell.
- Frame 8 (physical bottom-left) MUST be exactly one 22.5-degree step before the approved 000 UP pose family from the cardinal reference's top-left cell; it is not yet 000.
- Frames 1 through 8 may advance only along 180 DOWN -> 270 SCREEN-LEFT -> almost 000 UP. Never enter the 090 SCREEN-RIGHT pose family, never reverse into the opposite facial quadrant, and never make eyes, mouth, markings, limbs, props or tail teleport to the other side between adjacent frames.
- Continue exactly one step after the approved 157.5 pose in completed row A and end exactly one step before its 000 pose, preserving both row boundaries.`;
  return `${canonicalReferenceBlock(identity)}

Look mechanics: ${mechanics}
Reference roles are strict: Image 1 is the primary 4×2 partial anchor storyboard in the exact serpentine target geometry. Its physical top-left already contains approved Frame 1 and its physical bottom-right already contains approved Frame 5; preserve both anchor poses and their positions. Every other chroma-only slot in Image 1 is intentionally blank for you to fill, not an unused output slot. Image 2 is the approved canonical identity. Image 3 contains the complete approved 2×2 cardinal basis (top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT) plus secondary continuity/layout guidance; it must never override Image 1's placed endpoints or Image 2's identity.

Generate exactly eight separated poses as a 4 columns × 2 rows SERPENTINE board. Direction order: ${directions.join(", ")} degrees (chronological). Place frames 1, 2, 3, 4 from left-to-right across the TOP row, then place frames 5, 6, 7, 8 from right-to-left across the BOTTOM row. Therefore the physical bottom row, read left-to-right, is frames 8, 7, 6, 5. Follow the attached layout's visible frame numbers exactly. 000 is UP, 090 SCREEN-RIGHT, 180 DOWN, 270 SCREEN-LEFT.
${continuity}

Redraw this as one coherent interpolation family, not eight unrelated variants. Every adjacent 22.5-degree step must change the same anatomical landmarks by a similar visual amount. Keep the feet/base/torso anchor, scale, baseline and identity fixed. Preserve already-correct grid clearance, connectivity and body scale during repairs. Do not rotate, mirror, skew or tilt the whole raster sprite to fake gaze. Do not replace the original eye design.
Frames 4 and 5 are vertically adjacent at the physical right edge. Continue directly downward there; the row change is never a reset, mirror point or viewpoint jump. Frames 5 through 8 then continue right-to-left across the bottom row without reversing the clockwise turn.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookMechanicsPrompt(identity: CodexPetVisualIdentity): string {
  return `Describe the natural 16-direction look mechanics for this Codex desktop pet in at most 180 Chinese characters. State what remains anchored, what leads the gaze, what follows, how eyes/eyelids/head/body/appendages and existing props move, and how the four cardinals become unmistakable. Do not invent new props.\n\n${identityBlock(identity)}\n${canonicalGuideBlock(identity)}`;
}

export function buildVisualQaPrompt(
  kind: "base-choice" | "row" | "cardinals" | "directions" | "final",
  context: string,
  canonicalGuide?: string,
): string {
  const guide = canonicalGuide?.trim();
  return `You are a strict visual QA gate for a Codex v2 desktop pet. Inspect only the attached images. Return one compact JSON object without markdown. Kind: ${kind}. Context: ${context}.
${guide ? `Approved canonical anatomy and identity guide: ${guide}\nUse it to distinguish anatomical features—especially eyes, paws/feet and mouth—from fixed decorative markings, and report any genuine ambiguity instead of relabeling a feature. A feature listed as movable is merely allowed to move when the requested action naturally needs it; do not fail a state just because that feature stays still in this animation or frame.` : ""}
Required JSON: {"pass":boolean,"score":0-100,"mirrorSafe":boolean,"identity":boolean,"structure":boolean,"semantics":boolean,"continuity":boolean,"warnings":[string],"failures":[string],"repairPrompt":string,"repairRows":[string]}.
For a failed final review, repairRows must list complete action groups (never individual frames) using only these names when applicable: idle, running-right, running-left, waving, jumping, failed, waiting, running, review, look-a, look-b. Use an empty array when no repair is needed.
For a row review, the action name in Context is authoritative: assess that action instead of relabeling it as another row, and if repair is needed name only that current action in repairRows. In particular, “failed” is a sad/error reaction, not an idle blink: its guide-identified eyes may progressively narrow, droop or close and may hold the defeated expression for several frames before recovery. Do not require the tail, ears or every other movable feature to animate in a failed row. Do not call an action-appropriate deformation of guide-identified anatomy identity drift merely because its temporary outline resembles another feature; use its color, canonical position and frame-to-frame continuity to distinguish it from fixed markings or paws.
Reject identity/style drift, wrong pose count, merged/cropped poses, non-flat background, visible guides, detached effects, accidental transparent holes or sliced seams through a filled body, wrong action semantics, unintended scale/baseline jumps, wrong cardinals, wrong-quadrant directions or loop reversals. For jumping, require the ordered anticipation/rise/peak/descent/settle arc. Different vertical positions are mandatory and must never be reported as a baseline defect; judge scale only from the character's visible width/height and reject actual zoom, squash or stretch, not its top/bottom coordinates. mirrorSafe is true only if horizontal mirroring preserves every marking, text, prop handedness and meaning. mirrorSafe=false is informational and must never by itself make pass=false or be listed as a failure; it only means the opposite-facing row must be generated separately.`;
}
