import { describe, expect, it } from "vitest";
import { assertCodexPetVisualQaProvenance } from "./codex-pet-runner.js";

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
});
