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
}

const STATE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  idle: "calm breathing/blinking micro-motion; frames must visibly vary but remain quiet",
  "running-right": "directional locomotion facing and travelling screen-right with a clearly alternating gait",
  "running-left": "directional locomotion facing and travelling screen-left with a clearly alternating gait",
  waving: "a friendly wave expressed only by the limb pose, rising and returning",
  jumping: "anticipation, lift, peak, descent and settle expressed only by body height",
  failed: "a readable sad, deflated or error reaction using the character itself",
  waiting: "an expectant asking pose that clearly requests approval or user input",
  running: "focused active task work or processing; this is not physical running or jogging",
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

const GLOBAL_SPRITE_RULES = [
  "Create production sprite source art, not a presentation sheet.",
  "Use one perfectly flat solid chroma background and keep every character color clearly different from it.",
  "Show the complete whole body with generous padding. Nothing may touch or cross a slot or outer canvas edge.",
  "No text, labels, numbers, logos, borders, visible grid, scenery, floor, cast shadow, glow, halo, blur or transparency checkerboard.",
  "No detached effects: no motion lines, dust, floating icons, punctuation, stars or separate droplets.",
  "Every pose must be one readable connected sprite component. Preserve identity and scale across all poses.",
].join("\n");

export function buildBasePetPrompt(identity: CodexPetVisualIdentity, candidateIndex: number): string {
  return `${identityBlock(identity)}

Create one centered neutral full-body main character candidate on a flat ${identity.chromaKey} background. Candidate variation ${candidateIndex}: vary only tasteful pose/expression details, never the character identity. The character must remain readable inside a final 192×208 desktop-pet cell.

${GLOBAL_SPRITE_RULES}`;
}

export function buildStandardRowPrompt(identity: CodexPetVisualIdentity, state: PetRowSpec["state"]): string {
  if (state === "look-a" || state === "look-b") throw new Error("Use buildLookRowPrompt for look rows");
  const spec = petRowSpec(state);
  const unused = spec.frameCount < spec.boardColumns * spec.boardRows
    ? `Leave the final ${spec.boardColumns * spec.boardRows - spec.frameCount} slot completely empty with only chroma background.`
    : "Use every slot.";
  return `${identityBlock(identity)}

Generate exactly ${spec.frameCount} separated sequential poses for the “${state}” animation as a ${spec.boardColumns} columns × ${spec.boardRows} rows pose board, read left-to-right then top-to-bottom. Action: ${STATE_INSTRUCTIONS[state]}.
${unused}
  All poses share one scale. Preserve the action's natural relative movement inside the slots${state === "jumping" ? ", including clear vertical lift and descent instead of forcing every frame onto one baseline" : " while keeping a stable grounded anchor"}. Each pose stays centered inside its own equal slot with at least 10% safe padding. The attached layout is construction guidance only and must not appear in the result.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildCardinalPrompt(identity: CodexPetVisualIdentity, mechanics: string): string {
  return `${identityBlock(identity)}

Look mechanics: ${mechanics}

Generate exactly four separated cardinal looking poses as a 2×2 board, in this order: 000 looking UP, 090 looking toward SCREEN-RIGHT, 180 looking DOWN, 270 looking toward SCREEN-LEFT. These are viewer/screen coordinates. Make each cardinal unmistakable at 192×208 while preserving a stable lower-body anchor. Use eyes, eyelids, head, face, upper body, appendages and existing props only as physically natural for this character.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookRowPrompt(identity: CodexPetVisualIdentity, row: "look-a" | "look-b", mechanics: string): string {
  const directions = row === "look-a" ? LOOK_DIRECTIONS.slice(0, 8) : LOOK_DIRECTIONS.slice(8);
  const continuity = row === "look-a"
    ? "Interpolate one coherent clockwise family from the approved up/right/down cardinal pose families."
    : "Continue exactly one step after 157.5 and end exactly one step before 000, using completed row A for boundary continuity.";
  return `${identityBlock(identity)}

Look mechanics: ${mechanics}
Generate exactly eight separated poses as a 4 columns × 2 rows board, read left-to-right then top-to-bottom. Direction order: ${directions.join(", ")} degrees. 000 is UP, 090 SCREEN-RIGHT, 180 DOWN, 270 SCREEN-LEFT. ${continuity}
Every adjacent 22.5-degree step must change by a similar visual amount. Keep the feet/base/torso anchor, scale, baseline and identity fixed. Do not rotate, skew or tilt the whole raster sprite to fake gaze. Do not replace the original eye design.

Background color must be exactly ${identity.chromaKey}.
${GLOBAL_SPRITE_RULES}`;
}

export function buildLookMechanicsPrompt(identity: CodexPetVisualIdentity): string {
  return `Describe the natural 16-direction look mechanics for this Codex desktop pet in at most 180 Chinese characters. State what remains anchored, what leads the gaze, what follows, how eyes/eyelids/head/body/appendages and existing props move, and how the four cardinals become unmistakable. Do not invent new props.\n\n${identityBlock(identity)}`;
}

export function buildVisualQaPrompt(kind: "base-choice" | "row" | "cardinals" | "directions" | "final", context: string): string {
  return `You are a strict visual QA gate for a Codex v2 desktop pet. Inspect only the attached images. Return one compact JSON object without markdown. Kind: ${kind}. Context: ${context}.
Required JSON: {"pass":boolean,"score":0-100,"mirrorSafe":boolean,"identity":boolean,"structure":boolean,"semantics":boolean,"continuity":boolean,"warnings":[string],"failures":[string],"repairPrompt":string,"repairRows":[string]}.
For a failed final review, repairRows must list complete action groups (never individual frames) using only these names when applicable: idle, running-right, running-left, waving, jumping, failed, waiting, running, review, look-a, look-b. Use an empty array when no repair is needed.
Reject identity/style drift, wrong pose count, merged/cropped poses, non-flat background, visible guides, detached effects, accidental transparent holes or sliced seams through a filled body, wrong action semantics, unintended scale/baseline jumps, wrong cardinals, wrong-quadrant directions or loop reversals. For jumping, require a readable anticipation/lift/peak/descent/settle path and do not mistake intentional vertical travel for a baseline defect. mirrorSafe is true only if horizontal mirroring preserves every marking, text, prop handedness and meaning.`;
}
