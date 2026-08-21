import { describe, expect, it } from "vitest";
import {
  CODEX_PET_BOARD_PROMPT_VERSION,
  CODEX_PET_IDLE_BOARD_PROMPT_VERSION,
  codexPetBoardInputRevision,
  codexPetCoupledStandardRepairRows,
  codexPetShouldMirrorRunningLeft,
  codexPetStandardRowPromptVersion,
} from "./codex-pet-runner.js";

describe("Codex pet board prompt versions", () => {
  it("keeps the current idle prompt durable while dynamic rows advance independently", () => {
    expect(codexPetStandardRowPromptVersion("idle")).toBe(CODEX_PET_IDLE_BOARD_PROMPT_VERSION);
    expect(codexPetStandardRowPromptVersion("running-right")).toBe(CODEX_PET_BOARD_PROMPT_VERSION);

    const binding = {
      inputArtifactIds: ["canonical"],
      columns: 3,
      rows: 2,
      frameCount: 6,
    } as const;
    const persistedIdleRevision = codexPetBoardInputRevision({
      ...binding,
      promptVersion: CODEX_PET_IDLE_BOARD_PROMPT_VERSION,
    });
    expect(codexPetBoardInputRevision({
      ...binding,
      promptVersion: codexPetStandardRowPromptVersion("idle"),
    })).toBe(persistedIdleRevision);
    expect(codexPetBoardInputRevision(binding)).not.toBe(persistedIdleRevision);
  });

  it("invalidates a durable board when its effective prompt or jumping target changes", () => {
    const binding = {
      inputArtifactIds: ["canonical"],
      columns: 5,
      rows: 1,
      frameCount: 5,
      promptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      prompt: "jump marker A",
      jumpingTargetHeight: 174,
    } as const;
    const revision = codexPetBoardInputRevision(binding);
    expect(codexPetBoardInputRevision({ ...binding, prompt: "jump marker B" })).not.toBe(revision);
    expect(codexPetBoardInputRevision({ ...binding, jumpingTargetHeight: 170 })).not.toBe(revision);
    expect(codexPetBoardInputRevision({ ...binding, allowAuxiliaryForegroundComponents: true })).not.toBe(revision);
    expect(codexPetBoardInputRevision({ ...binding })).toBe(revision);
  });

  it("bypasses running-left mirroring when either direction has user customization", () => {
    expect(codexPetShouldMirrorRunningLeft(true, undefined)).toBe(true);
    expect(codexPetShouldMirrorRunningLeft(true, {})).toBe(true);
    expect(codexPetShouldMirrorRunningLeft(false, {})).toBe(false);
    expect(codexPetShouldMirrorRunningLeft(true, { "running-right": "更有冲刺感" })).toBe(false);
    expect(codexPetShouldMirrorRunningLeft(true, { "running-left": "左转时压低身体" })).toBe(false);
  });

  it("repairs jumping after idle and keeps directional running repairs coupled", () => {
    expect(codexPetCoupledStandardRepairRows(["idle"])).toEqual(["idle", "jumping"]);
    expect(codexPetCoupledStandardRepairRows(["jumping"])).toEqual(["jumping"]);
    expect(codexPetCoupledStandardRepairRows(["running-left"])).toEqual(["running-left", "running-right"]);
  });
});
