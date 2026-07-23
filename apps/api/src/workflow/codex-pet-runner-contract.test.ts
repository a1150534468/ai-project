import { describe, expect, it } from "vitest";
import { DOUBAO_IMAGE_MODEL, GPT_IMAGE_MODEL, QWEN_IMAGE_MODEL } from "./image-service.js";
import { assertCodexPetVisualQaProvenance, codexPetMaxBoardAttempts, codexPetRepairGenerationReferences, codexPetShouldAttachFailedBoardForRepair } from "./codex-pet-runner.js";

describe("Codex pet runner visual model provenance", () => {
  it("requires every actual visual model to equal the frozen requested model", () => {
    expect(assertCodexPetVisualQaProvenance({
      requestedModel: "qwen3.6-flash",
      actualModels: ["qwen3.6-flash"],
      routes: ["bailian_model_route"],
    }, "qwen3.6-flash", "row-review")).toMatchObject({
      requestedModel: "qwen3.6-flash",
      actualModels: ["qwen3.6-flash"],
      routes: ["bailian_model_route"],
    });

    expect(() => assertCodexPetVisualQaProvenance({
      requestedModel: "qwen3.6-flash",
      actualModels: ["gpt-5.6-sol"],
      routes: ["bailian_model_route"],
    }, "qwen3.6-flash", "row-review")).toThrow("缺少可信的 qwen3.6-flash 模型来源证明");
  });

  it("does not feed a rejected pose board back into Seedream repairs", () => {
    expect(codexPetShouldAttachFailedBoardForRepair(DOUBAO_IMAGE_MODEL)).toBe(false);
    expect(codexPetShouldAttachFailedBoardForRepair(GPT_IMAGE_MODEL)).toBe(true);
    expect(codexPetShouldAttachFailedBoardForRepair(QWEN_IMAGE_MODEL)).toBe(true);

    const canonical = { b64: "canonical", mime: "image/png", filename: "canonical-base.png" } as const;
    const layout = { b64: "layout", mime: "image/png", filename: "running-right-layout.png" } as const;
    const failed = Buffer.from("rejected-board");
    expect(codexPetRepairGenerationReferences(DOUBAO_IMAGE_MODEL, [canonical, layout], failed).map((item) => item.filename))
      .toEqual(["canonical-base.png", "running-right-layout.png"]);
    expect(codexPetRepairGenerationReferences(GPT_IMAGE_MODEL, [canonical, layout], failed).map((item) => item.filename))
      .toEqual(["canonical-base.png", "running-right-layout.png", "previous-failed-pose-board.png"]);
  });

  it("lets a real-verification runtime cap retries without expanding a durable limit", () => {
    expect(codexPetMaxBoardAttempts({}, undefined)).toBe(3);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "1" }, undefined)).toBe(1);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "3" }, 1)).toBe(1);
    expect(codexPetMaxBoardAttempts({ CODEX_PET_MAX_BOARD_ATTEMPTS: "invalid" }, 2)).toBe(2);
  });
});
