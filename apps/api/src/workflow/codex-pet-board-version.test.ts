import { describe, expect, it } from "vitest";
import {
  CODEX_PET_BOARD_PROMPT_VERSION,
  CODEX_PET_IDLE_BOARD_PROMPT_VERSION,
  codexPetBoardInputRevision,
  codexPetStandardRowPromptVersion,
} from "./codex-pet-runner.js";

describe("Codex pet board prompt versions", () => {
  it("keeps a passed v7 idle durable while dynamic rows advance independently", () => {
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
});
