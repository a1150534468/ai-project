import { LOOK_DIRECTIONS, petRowSpec, type PetRowSpec } from "@ai-assistant/codex-pet-pipeline/constants";

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

export const CODEX_PET_ACTION_PROMPT_KEYS = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
  "look",
] as const;

export type CodexPetActionPromptKey = (typeof CODEX_PET_ACTION_PROMPT_KEYS)[number];
export type CodexPetActionPrompts = Readonly<Partial<Record<CodexPetActionPromptKey, string>>>;
export const CODEX_PET_ACTION_PROMPT_MAX_LENGTH = 500;
export const CODEX_PET_ACTION_PROMPTS_MAX_TOTAL_LENGTH = 4_000;

export function normalizeCodexPetActionPrompts(value: unknown): CodexPetActionPrompts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(CODEX_PET_ACTION_PROMPT_KEYS.flatMap((key) => {
    const prompt = typeof source[key] === "string"
      ? source[key].trim().slice(0, CODEX_PET_ACTION_PROMPT_MAX_LENGTH)
      : "";
    return prompt ? [[key, prompt]] : [];
  }));
}

export interface CodexPetVisualIdentity {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly actionPrompts?: CodexPetActionPrompts;
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
  idle: "calm facial micro-motion with this exact six-frame plan: frame 1 eyes open neutral; frame 2 eyes open with a tiny eyelid change; frame 3 eyes open with a tiny eye-highlight change; frame 4 eyes open with a tiny mouth change; frame 5 the single brief blink; frame 6 eyes open neutral return. Treat frame 1 as the non-facial pixel master: copy its complete body and outer silhouette into frames 2-6 before changing only the specified eyelid, eye-highlight or mouth pixels. Lock the complete outer silhouette pixel-for-pixel across all six frames: no head, helmet, torso, arm, hand, leg, foot or whole-character translation, bob, tilt, bend, squash, stretch or follow-through. Keep the single canonical antenna perfectly fixed and unchanged in all six frames; the shaft and its round terminal tip are one complete identity structure and both must remain connected, fully coloured and present even after the board continues onto its second row. Never omit, darken, crop or detach the terminal tip, relocate it below another character as a loose dot, bend the shaft, duplicate it, echo it, or draw an antenna-like motion trail. Keep both arms lowered and attached in all six frames. Never wave, raise a hand, sleep or keep the eyes closed beyond frame 5",
  "running-right": "one eight-slot directional run loop with every frame unmistakably facing screen-right in the same side or three-quarter profile. Preserve one rigid right-facing head, antenna and torso orientation in all eight slots; the face panel, muzzle, gaze and chest front remain on the screen-right side and may never turn toward the viewer, screen-left or the back. Animate the cycle through attached arm and leg opposition. At minimum alternate two clearly different contact/opposite-contact phases A/B across the loop; additional passing or airborne phases are optional only when they preserve the same rigid right-facing upper-body orientation. Keep the canonical dark face panel fully filled as opaque foreground in every phase; never erase it, open a hole through it, recolour it as the chroma key, or leave the eyes and mouth floating separately. Never repeat one frozen stride in all slots",
  "running-left": "one eight-slot directional run loop with every frame unmistakably facing screen-left in the same side or three-quarter profile. Preserve one rigid left-facing head, antenna and torso orientation in all eight slots; the face panel, muzzle, gaze and chest front remain on the screen-left side and may never turn toward the viewer, screen-right or the back. Animate the cycle through attached arm and leg opposition. At minimum alternate two clearly different contact/opposite-contact phases A/B across the loop; additional passing or airborne phases are optional only when they preserve the same rigid left-facing upper-body orientation. Keep the canonical dark face panel fully filled as opaque foreground in every phase; never erase it, open a hole through it, recolour it as the chroma key, or leave the eyes and mouth floating separately. Never repeat one frozen stride in all slots",
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
    "Keep the count and topology of every identity-defining anatomical feature constant in every frame. A singular feature such as one antenna, one tail, one horn or one nose remains exactly one; never create a duplicate, ghost, echo, afterimage, second endpoint or detached look-alike while showing motion.",
    canonicalGuideBlock(identity),
  ].filter(Boolean).join("\n");
}

function actionPromptBlock(
  identity: CodexPetVisualIdentity,
  action: CodexPetActionPromptKey,
  options: { readonly allowRequestedAdditions?: boolean } = {},
): string {
  const prompt = identity.actionPrompts?.[action]?.trim();
  if (!prompt) return "";
  const additions = options.allowRequestedAdditions
    ? "It may explicitly require a new action prop, compact scene object, short readable text, or small state-relevant effect; include those requested elements instead of deleting or replacing them with the default action."
    : "Apply it through this character's natural look mechanics without adding unrelated props, text, or effects.";
  return `Authoritative user specification for this ${action} animation: ${prompt}
This specification replaces the default action semantics for this animation. ${additions} It must still preserve character identity, exact frame count and order, direction contracts, the flat chroma background, safe margins, and sprite-sheet geometry.`;
}

const GLOBAL_SPRITE_RULES = [
  "Create production sprite source art, not a presentation sheet.",
  "The background is a production chroma-key matte, not an artistic backdrop: every background pixel must be the exact same requested chroma RGB value. Use one perfectly flat solid chroma background and keep every character color clearly different from it.",
  "Do not shade, light, vignette, texture, noise, dither, bloom, blur, or gradient the chroma background. No alternate purple/pink/green tones may appear outside the character silhouette.",
  "Show the complete whole body with generous padding. Nothing may touch or cross a slot or outer canvas edge.",
  "No text, labels, numbers, logos, borders, visible grid, scenery, floor, cast shadow, glow, halo, blur or transparency checkerboard.",
  "No detached effects: no motion lines, dust, floating icons, punctuation, stars or separate droplets.",
  "Every pose must be one readable connected sprite component. Preserve identity and scale across all poses.",
].join("\n");

function standardRowSpriteRules(hasUserActionPrompt: boolean): string {
  if (!hasUserActionPrompt) return GLOBAL_SPRITE_RULES;
  return [
    "Create production sprite source art, not a presentation sheet.",
    "The background is a production chroma-key matte, not an artistic backdrop: every background pixel must be the exact same requested chroma RGB value. Use one perfectly flat solid chroma background and keep every character, requested prop, text, and effect color clearly different from it.",
    "Do not shade, light, vignette, texture, noise, dither, bloom, blur, or gradient the chroma background. No alternate purple/pink/green tones may appear outside the requested foreground.",
    "Show the complete whole body and every requested action element with generous padding. Nothing may touch or cross a slot or outer canvas edge.",
    "No unrequested text, labels, numbers, logos, borders, visible grid, scenery, floor, cast shadow, glow, halo, blur, transparency checkerboard, motion lines, dust, icons, punctuation, stars, droplets, or decorative fragments.",
    "Requested short text, compact action props, and small state-relevant effects are foreground sprite content. Keep them opaque, hard-edged, visually close to the main character, and fully inside the same slot.",
    "Every pose must contain exactly one readable character. Preserve character identity and scale across all poses; never add a second character or partial duplicate.",
  ].join("\n");
}

/**
 * Direction rows use screen-heading semantics, not the conventional portrait
 * yaw convention where zero degrees is a front portrait.  Keeping this as a
 * single contract prevents the cardinal generator, row repair prompts and
 * visual QA from silently choosing opposite front/back meanings.
 */
export const CODEX_PET_CARDINAL_APPEARANCE_CONTRACT = [
  "Authoritative cardinal appearance contract (viewer/screen coordinates): 000 UP means the character's natural front/aim points toward the top edge; for a standing character with a visible front this is the rear/back-facing or top-facing pose family, with the front face normally occluded.",
  "090 SCREEN-RIGHT means the natural front/aim points toward the right edge and must show the right-facing profile or matching right-side landmarks.",
  "180 DOWN means the natural front/aim points toward the bottom edge; for a standing character with a visible front this is the front-facing or bottom-facing pose family, with the canonical face visible again.",
  "270 SCREEN-LEFT means the natural front/aim points toward the left edge and must show the left-facing profile or matching left-side landmarks.",
  "Do not reinterpret 000 as a front portrait or 180 as a rear portrait. Do not let a repair diagnostic override this contract. For eyeless or non-directional objects, use the object's natural aiming feature and the same four screen edges.",
].join(" ");

export function sanitizeCodexPetDirectionRepairPrompt(value: string): string {
  const diagnostic = value.trim();
  if (diagnostic.includes("The previous repair diagnostic was discarded because it reversed the approved 000/180 front-back contract.")) {
    return diagnostic;
  }
  const evidence = diagnostic.replaceAll(CODEX_PET_CARDINAL_APPEARANCE_CONTRACT, "").trim();
  const normalized = evidence.toLowerCase();
  const contradictsUp = /(?:000|0(?:\.0)?\s*(?:deg(?:ree)?s?|°))\s*(?:is|must be|means|as)?\s*(?:a\s+)?(?:front(?:-facing)?|front portrait|正面|正视)|(?:make|render|treat|show).{0,24}000.{0,24}(?:front(?:-facing)?|正面|正视)/is.test(normalized);
  const contradictsDown = /180(?:\.0)?\s*(?:deg(?:ree)?s?|°)?\s*(?:is|must be|means|as)?\s*(?:a\s+)?(?:back(?:-facing)?|rear(?:-facing)?|rear portrait|背面|后视)|(?:make|render|treat|show).{0,24}180.{0,24}(?:back(?:-facing)?|rear(?:-facing)?|背面|后视)/is.test(normalized);
  if (contradictsUp || contradictsDown) {
    return `${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT} The previous repair diagnostic was discarded because it reversed the approved 000/180 front-back contract. Repair only the observed continuity, identity, spacing or registration defect without changing any approved cardinal meaning.`;
  }
  return evidence
    ? `${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT} Accepted non-conflicting repair evidence: ${evidence}`
    : CODEX_PET_CARDINAL_APPEARANCE_CONTRACT;
}

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
  const userActionPrompt = identity.actionPrompts?.[state]?.trim();
  const unused = spec.frameCount < spec.boardColumns * spec.boardRows
    ? `Leave the final ${spec.boardColumns * spec.boardRows - spec.frameCount} slot completely empty with only chroma background.`
    : "Use every slot.";
  const jumpingSlotMap = state === "jumping"
    ? "For this 5×1 board the exact left-to-right mapping is: frame 1 grounded anticipation; frame 2 airborne rise; frame 3 the unique highest peak; frame 4 airborne descent visibly lower than frame 3; frame 5 grounded settle on the same foot baseline as frame 1. Use all five slots and never reorder the phases."
    : "";
  const rowWord = spec.boardRows === 1 ? "row" : "rows";
  const directionalProfileRule = state === "running-right" || state === "running-left"
    ? "This is a directional running cycle. A natural side or three-quarter running pose may occlude the far eye and part of the front face panel; preserve the visible eye, fixed face-panel topology, head module, markings and body identity without forcing every frame into a frontal two-eye view. The travel direction must remain consistent across the complete cycle."
    : "";
  const seedreamGaitScaffoldRule = state === "running-right" || state === "running-left"
    ? "If the attached construction reference alternates two source gait phases A/B across odd and even slots, treat its head, antenna, face-panel side, torso orientation, scale and placement as a rigid per-slot direction lock. Preserve the A/B limb opposition and redraw the eight slots in place. A clean A/B/A/B/A/B/A/B two-phase loop is valid and preferred over adding turns or broken anatomy; add intermediate limb phases only when every head and torso remains in the exact same facing profile. Never yaw the head or torso toward front, back or the opposite side in frames 4, 5 or 8. Never keep a scaffold pose and add a second head, body or character above or below it. Do not return eight copies of one stride. Every singular antenna or other appendage still appears exactly once per frame with no ghost or duplicate."
    : "";
  const foregroundContract = userActionPrompt
    ? "Hard extraction gate for every slot: draw exactly one complete character contained wholly inside that slot. The head, torso, arms, hands, legs, feet, ears, tail and antennae must stay attached through continuous opaque non-background sprite pixels. Props held or worn by the character should remain visibly connected where physically appropriate. An explicitly requested short text cue, state effect, or compact action object may use up to four separate opaque foreground components in addition to the character; keep every such component substantially smaller than the character, visually close to it, and inside the same safe margins. Never add random specks, unrequested marks, a second character, a partial duplicate, or content crossing into another slot."
    : "Hard extraction gate for every slot: draw exactly one complete character contained wholly inside that slot. The head, torso, arms, hands, legs, feet, ears, tail, antennae and any existing prop must connect to the main body through continuous opaque non-background sprite pixels. A lifted hand or foot must still be visibly joined to its arm or leg; never leave a chroma-key gap at a shoulder, wrist, hip or ankle. Do not split one character across neighboring slots. Do not draw detached sweat beads, action marks, punctuation, droplets, sparkles, dust or any other floating effect.";
  const actionSpecification = userActionPrompt
    ? actionPromptBlock(identity, state, { allowRequestedAdditions: true })
    : `Default action specification: ${STATE_INSTRUCTIONS[state]}.`;
  return `${canonicalReferenceBlock(identity)}

Generate exactly ${spec.frameCount} separated sequential poses for the “${state}” animation as a ${spec.boardColumns} columns × ${spec.boardRows} ${rowWord} pose board, read left-to-right then top-to-bottom.
${actionSpecification}
${jumpingSlotMap}
${unused}
${directionalProfileRule}
${seedreamGaitScaffoldRule}
All poses share one scale. ${state === "jumping"
    ? "Show clear vertical lift and descent through body height."
    : "Keep the character horizontally centered on one stable foot baseline in every slot; express motion through the pose, not by moving the sprite around the board."} Scale down wide or extreme poses as needed so the complete silhouette keeps at least 15% clear background from every slot boundary. The attached layout is construction guidance only and must not appear in the result.
${foregroundContract}
The second attached construction reference may repeat the approved canonical character once inside every target slot. Use only its exact one-complete-character-per-slot count, scale, padding and placement. Redraw each requested action phase by replacing the scaffold character in place; never retain it and add another head, body or character above or below. The complete canvas must contain exactly ${spec.frameCount} total heads and exactly ${spec.frameCount} total bodies, forming exactly ${spec.frameCount} complete characters and no partial duplicates. Never merge the top and bottom slots into one tall character, and never split a character across a row boundary. Do not return repeated static copies.

Background color must be exactly ${identity.chromaKey} at every background pixel; render it as a uniform solid production key, never as a gradient or lit surface.
The chroma key ${identity.chromaKey} is reserved exclusively for exterior background outside each complete character. No exact or near-key pixel may appear anywhere inside a character's bounding box or enclosed silhouette, including its face panel, screen, eyes, mouth, joints or gaps between attached limbs. Every canonical face/screen panel remains fully filled, opaque foreground in its original dark colour; background must never show through it.
${standardRowSpriteRules(Boolean(userActionPrompt))}`;
}

export function buildCardinalPrompt(identity: CodexPetVisualIdentity, mechanics: string): string {
  return `${canonicalReferenceBlock(identity)}

Look mechanics: ${mechanics}
${actionPromptBlock(identity, "look")}

Generate exactly four separated cardinal looking poses as a 2×2 board, in this order: 000 looking UP, 090 looking toward SCREEN-RIGHT, 180 looking DOWN, 270 looking toward SCREEN-LEFT. These are viewer/screen coordinates. Make each cardinal unmistakable at 192×208 while preserving a stable lower-body anchor. Use eyes, eyelids, head, face, upper body, appendages and existing props only as physically natural for this character.
${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT}

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookRowPrompt(identity: CodexPetVisualIdentity, row: "look-a" | "look-b", mechanics: string): string {
  const directions = row === "look-a" ? LOOK_DIRECTIONS.slice(0, 8) : LOOK_DIRECTIONS.slice(8);
  const referenceRoles = row === "look-a"
    ? "Reference roles are strict: Image 1 is the primary 4×2 partial anchor storyboard in ordinary row-major target geometry. Its physical top-left already contains approved Frame 1 and its physical bottom-left already contains approved Frame 5; preserve both anchor poses and their positions. Every other chroma-only slot in Image 1 is intentionally blank for you to fill, not an unused output slot. Image 2 is the approved canonical identity. Image 3 contains the complete approved 2×2 cardinal basis (top-left 000 UP, top-right 090 SCREEN-RIGHT, bottom-left 180 DOWN, bottom-right 270 SCREEN-LEFT) plus secondary continuity/layout guidance; it must never override Image 1's placed endpoints or Image 2's identity."
    : "Reference roles are strict: Image 1 is the primary full 4×2 SCREEN-LEFT trajectory scaffold in ordinary row-major target geometry. It is reference-only evidence assembled from the approved 180 DOWN and 270 SCREEN-LEFT cardinals plus horizontally reflected pose-family evidence from approved row A. Redraw all eight poses as one fresh coherent family; do not paste or ship the scaffold pixels. Preserve its screen-side trajectory, its exact Frame 1 and Frame 5 cardinal families, and its monotonically changing asymmetric landmarks. Image 2 is the approved canonical identity. Supporting images contain the complete approved cardinal basis, endpoint storyboard, approved row A and layout evidence; they must never override Image 1's SCREEN-LEFT path or Image 2's identity.";
  const continuity = row === "look-a"
    ? `Use this exact anchor path:
- Frame 1 (physical top-left) MUST reproduce the approved 000 UP pose family from the cardinal reference's top-left cell.
- Frame 5 (physical bottom-left) MUST reproduce the approved 090 SCREEN-RIGHT pose family from the cardinal reference's top-right cell.
- Frame 8 (physical bottom-right) MUST be exactly one 22.5-degree step before the approved 180 DOWN pose family from the cardinal reference's bottom-left cell; it is not yet 180.
- Frames 1 through 8 may advance only along 000 UP -> 090 SCREEN-RIGHT -> almost 180 DOWN. Never enter the 270 SCREEN-LEFT pose family, never reverse into the opposite facial quadrant, and never make eyes, mouth, markings, limbs, props or tail teleport to the other side between adjacent frames.`
    : `Use this exact anchor path:
- Frame 1 (physical top-left) MUST reproduce the approved 180 DOWN pose family from the cardinal reference's bottom-left cell.
- Frame 5 (physical bottom-left) MUST reproduce the approved 270 SCREEN-LEFT pose family from the cardinal reference's bottom-right cell.
- Frame 8 (physical bottom-right) MUST be exactly one 22.5-degree step before the approved 000 UP pose family from the cardinal reference's top-left cell; it is not yet 000.
- Frames 1 through 8 may advance only along 180 DOWN -> 270 SCREEN-LEFT -> almost 000 UP. Never enter the 090 SCREEN-RIGHT pose family, never reverse into the opposite facial quadrant, and never make eyes, mouth, markings, limbs, props or tail teleport to the other side between adjacent frames.
- For every asymmetric identity landmark that distinguishes the two horizontal sides (such as a side module, face panel edge, antenna, marking or attached prop), keep its viewer/screen side monotonic across this arc: frames 1-4 may only move from the approved 180 DOWN family toward the approved 270 SCREEN-LEFT family, frames 5-8 may only move from 270 toward the approved 000 UP family. A landmark that is on the screen-left side at 270 must never jump to screen-right in frames 2-4 or 6-8; do not mirror or swap the landmark midway through the row.
- The chronological order is 1,2,3,4 across the top row then 5,6,7,8 across the bottom row from left to right; never reset the viewpoint at the row boundary.
- Continue exactly one step after the approved 157.5 pose in completed row A and end exactly one step before its 000 pose, preserving both row boundaries.`;
  const frameAppearancePlan = row === "look-a"
    ? `Binding visible pose-family plan for the half-turn from back/up through screen-right toward front/down:
- Frame 1: exact approved 000 rear/back-facing UP family; front face normally hidden.
- Frame 2: rear view with only a slight SCREEN-RIGHT-side reveal.
- Frame 3: rear-right three-quarter view; never show the screen-left profile family.
- Frame 4: approaching the approved SCREEN-RIGHT profile from the rear.
- Frame 5: exact approved 090 SCREEN-RIGHT profile, with the face/front edge on the same screen side as the approved top-right cardinal.
- Frame 6: right-front three-quarter view; reveal more of the face while remaining unmistakably on the screen-right half-turn.
- Frame 7: near-front view still offset toward screen-right.
- Frame 8: almost the approved 180 front/down-facing family, but still one visible step on its screen-right side.
This is one 157.5-degree half-turn, not a full 360-degree turntable. No frame may use the approved 270 SCREEN-LEFT family or put the face/front edge on its screen side.`
    : `Binding visible pose-family plan for the half-turn from front/down through screen-left toward back/up:
- Frame 1: exact approved 180 front/down-facing family, with the canonical face visible.
- Frame 2: front view with only a slight SCREEN-LEFT-side turn.
- Frame 3: front-left three-quarter view; never show the screen-right profile family.
- Frame 4: approaching the approved SCREEN-LEFT profile from the front.
- Frame 5: exact approved 270 SCREEN-LEFT profile, with the face/front edge on the same screen side as the approved bottom-right cardinal.
- Frame 6: left-rear three-quarter view; hide more of the face while remaining on the screen-left half-turn.
- Frame 7: near-rear view still offset toward screen-left.
- Frame 8: almost the approved 000 rear/back-facing UP family, but still one visible step on its screen-left side.
This is one 157.5-degree half-turn, not a full 360-degree turntable. No frame may use the approved 090 SCREEN-RIGHT family or put the face/front edge on its screen side.`;
  return `${canonicalReferenceBlock(identity)}

Look mechanics: ${mechanics}
${actionPromptBlock(identity, "look")}
${referenceRoles}

Viewer-coordinate appearance lock: ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT} The approved cardinal images are the source of truth for the exact anatomy, but they must themselves obey this screen-heading contract.

Generate exactly eight separated poses as a 4 columns × 2 rows row-major board. Direction order: ${directions.join(", ")} degrees (chronological). Place frames 1, 2, 3, 4 from left-to-right across the TOP row, then place frames 5, 6, 7, 8 from left-to-right across the BOTTOM row. Follow the attached layout's visible frame numbers exactly. 000 is UP, 090 SCREEN-RIGHT, 180 DOWN, 270 SCREEN-LEFT.
${continuity}
${frameAppearancePlan}

Redraw this as one coherent interpolation family, not eight unrelated variants. Every adjacent 22.5-degree step must change the same anatomical landmarks by a similar visual amount. Keep the feet/base/torso anchor, scale, baseline and identity fixed. Preserve already-correct grid clearance, connectivity and body scale during repairs. Do not rotate, mirror, skew or tilt the whole raster sprite to fake gaze. Do not replace the original eye design.
Frames 4 and 5 are the row-boundary neighbors in chronological order; continue directly from the top-right pose into the bottom-left pose without a reset, mirror point or viewpoint jump. Frames 5 through 8 then continue left-to-right across the bottom row without reversing the clockwise turn.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookMechanicsPrompt(identity: CodexPetVisualIdentity): string {
  return `Describe the natural 16-direction look mechanics for this Codex desktop pet in at most 180 Chinese characters. State what remains anchored, what leads the gaze, what follows, how eyes/eyelids/head/body/appendages and existing props move, and how the four cardinals become unmistakable. Use this fixed screen-heading contract: ${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT} Do not invent new props.\n\n${canonicalReferenceBlock(identity)}\n${actionPromptBlock(identity, "look")}`;
}

export function buildVisualQaPrompt(
  kind: "base-choice" | "row" | "cardinals" | "directions" | "final",
  context: string,
  canonicalGuide?: string,
  authoritativeActionSpecification?: string,
): string {
  const guide = canonicalGuide?.trim();
  const userAction = authoritativeActionSpecification?.trim();
  const directionalProfileRule = kind === "row" && /(running-right|running-left)/.test(context)
    ? "For this directional running row, side and three-quarter views are expected: the far eye and part of the frontal face panel may be naturally occluded. Do not call the missing frontal second eye identity drift when the visible eye, head module, face-panel boundary, fixed markings, proportions and travel direction remain coherent. Judge the complete cycle's facing direction and identity topology, not frontal eye count."
    : "";
  const customizedActiveTask = Boolean(userAction) && (
    (kind === "row" && context.trimStart().startsWith("running 动作组"))
    || (kind === "final" && /(?:^|;\s*)running\s*:/.test(userAction!))
  );
  const activeTaskRule = ((kind === "row" && context.trimStart().startsWith("running 动作组")) || kind === "final")
    && !customizedActiveTask
    ? "Codex state semantics are authoritative: the state named running (without -left or -right) means active task processing, not physical locomotion. It should read through attentive eyes, a small head shift, and subtle attached-paw working motion while the feet/base stay fixed. Never require or reward alternating leg stride, foot displacement, walking, jogging, sprinting, body travel, or other locomotion cues in this state; those are wrong-action failures."
    : "";
  const directionContract = kind === "cardinals" || kind === "directions" || kind === "final"
    ? `\n${CODEX_PET_CARDINAL_APPEARANCE_CONTRACT} For cardinal QA, the normalized board's physical cells are top-left 000, top-right 090, bottom-left 180, bottom-right 270. For direction-row QA, compare row endpoints to those exact pose families; a front/back reversal is a hard failure even when the numeric labels are present.`
    : "";
  const userActionRule = userAction
    ? `\nAuthoritative user action specification: ${userAction}\nJudge the named customized row against this specification instead of the default action recipe. Do not reject a requested short text cue, compact action prop, or small state-relevant effect solely because it is detached from the character. It must still stay opaque, bounded, close to the character, inside its cell, and must not become a second character, random residue, or cross-cell content.`
    : "";
  return `You are a strict visual QA gate for a Codex v2 desktop pet. Inspect only the attached images. Return one compact JSON object without markdown. Kind: ${kind}. Context: ${context}.
${guide ? `Approved canonical anatomy and identity guide: ${guide}\nUse it to distinguish anatomical features—especially eyes, paws/feet and mouth—from fixed decorative markings, and report any genuine ambiguity instead of relabeling a feature. A feature listed as movable is merely allowed to move when the requested action naturally needs it; do not fail a state just because that feature stays still in this animation or frame.` : ""}
${directionalProfileRule}
${activeTaskRule}
${directionContract}
${userActionRule}
Required JSON: {"pass":boolean,"score":0-100,"mirrorSafe":boolean,"identity":boolean,"structure":boolean,"semantics":boolean,"continuity":boolean,"warnings":[string],"failures":[string],"repairPrompt":string,"repairRows":[string]}.
For a failed final review, repairRows must list complete action groups (never individual frames) using only these names when applicable: idle, running-right, running-left, waving, jumping, failed, waiting, running, review, look-a, look-b. Use an empty array when no repair is needed.
For a row review, the action name in Context is authoritative: assess that action instead of relabeling it as another row, and if repair is needed name only that current action in repairRows. In particular, “failed” is a sad/error reaction, not an idle blink: its guide-identified eyes may progressively narrow, droop or close and may hold the defeated expression for several frames before recovery. Do not require the tail, ears or every other movable feature to animate in a failed row. Do not call an action-appropriate deformation of guide-identified anatomy identity drift merely because its temporary outline resembles another feature; use its color, canonical position and frame-to-frame continuity to distinguish it from fixed markings or paws.
Reject identity/style drift, wrong pose count, merged/cropped poses, non-flat background, visible guides, ${userAction ? "unrequested detached residue or auxiliary content that violates the bounded user-action rule" : "detached effects"}, accidental transparent holes or sliced seams through a filled body, wrong action semantics, unintended scale/baseline jumps, wrong cardinals, wrong-quadrant directions or loop reversals. For jumping, require the ordered anticipation/rise/peak/descent/settle arc. Different vertical positions are mandatory and must never be reported as a baseline defect; judge scale only from the character's visible width/height and reject actual zoom, squash or stretch, not its top/bottom coordinates. mirrorSafe is true only if horizontal mirroring preserves every marking, text, prop handedness and meaning. mirrorSafe=false is informational and must never by itself make pass=false or be listed as a failure; it only means the opposite-facing row must be generated separately.`;
}
