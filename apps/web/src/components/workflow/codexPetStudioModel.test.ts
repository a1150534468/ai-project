import { describe, expect, it } from "vitest";
import type { CodexPetEvent, CodexPetJob, CodexPetRun } from "../../codexPetApi";
import {
  CODEX_PET_LOOK_DIRECTIONS,
  CODEX_PET_STANDARD_STATES,
  EMPTY_CODEX_PET_DRAFT,
  codexPetCurrentSubtask,
  codexPetDisplayProgress,
  codexPetModelContractState,
  codexPetValidationPassed,
  isCodexPetDeliveryReady,
  mergeCodexPetEvents,
  validateCodexPetDraft,
} from "./codexPetStudioModel";

function makeRun(overrides: Partial<CodexPetRun> = {}): CodexPetRun {
  return {
    id: "run-1",
    projectId: "project-1",
    status: "archiving",
    progressStage: "archiving",
    progressPercent: 100,
    progressMessage: "归档中",
    autoContinue: false,
    colorKey: "#ff00ff",
    billingPoints: 200,
    billingRefundedAt: null,
    cancelRequested: false,
    hasSuccessfulImage: true,
    selectedBaseArtifactId: "base-1",
    spritesheetArtifactId: "sheet-1",
    packageArtifactId: "zip-1",
    previewArtifactId: "preview-1",
    validationReport: { ok: true, spriteVersionNumber: 2, errors: [], warnings: [] },
    requestedModel: "gpt-image-2",
    modelContractVersion: "gpt-only-v1",
    visualQaModel: "gpt-5.6-sol",
    visualQaActualModels: ["gpt-5.6-sol"],
    visualQaRoutes: ["chatgpt_model_route"],
    actualModels: ["gpt-image-2-codex"],
    usage: { totalTokens: 123 },
    knowledgeDocumentId: null,
    lastEventSequence: 10,
    error: null,
    startedAt: "2026-07-17T08:00:00.000Z",
    completedAt: null,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:10:00.000Z",
    ...overrides,
  };
}

function makeEvent(sequence: number, message: string): CodexPetEvent {
  return {
    sequence,
    type: "stage.started",
    stage: "base_generating",
    jobKey: null,
    message,
    progress: sequence,
    payload: {},
    createdAt: "2026-07-17T08:00:00.000Z",
  };
}

function makeJob(key: string, status: string, updatedAt: string): CodexPetJob {
  return {
    id: `job-${key}`,
    key,
    kind: "standard_row",
    status,
    attempt: status === "running" ? 2 : 1,
    maxAttempts: 3,
    error: null,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt,
  };
}

describe("codexPetStudioModel", () => {
  it("requires either a prompt or reference image and enforces the 30-character name", () => {
    expect(validateCodexPetDraft(EMPTY_CODEX_PET_DRAFT)).toBe("请输入桌宠名称");
    expect(validateCodexPetDraft({ ...EMPTY_CODEX_PET_DRAFT, name: "码仔" })).toBe("请填写角色提示词或上传至少一张参考图");
    expect(validateCodexPetDraft(
      { ...EMPTY_CODEX_PET_DRAFT, name: "先存起来" },
      { requireVisualInput: false },
    )).toBeNull();
    expect(validateCodexPetDraft({ ...EMPTY_CODEX_PET_DRAFT, name: "码仔", prompt: "一只薄荷色机器人" })).toBeNull();
    expect(validateCodexPetDraft({ ...EMPTY_CODEX_PET_DRAFT, name: "宠".repeat(31), prompt: "角色" })).toBe("桌宠名称不能超过 30 个字");
  });

  it("deduplicates persisted and SSE events by monotonic sequence", () => {
    const merged = mergeCodexPetEvents(
      [makeEvent(1, "旧消息"), makeEvent(2, "第二条")],
      [makeEvent(1, "补发后的消息"), makeEvent(3, "第三条")],
    );
    expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(merged[0]?.message).toBe("补发后的消息");
  });

  it("chooses a running job before queued work and stale completion events", () => {
    const jobs = [
      makeJob("row-running-right", "running", "2026-07-17T08:02:00.000Z"),
      makeJob("row-idle", "completed", "2026-07-17T08:03:00.000Z"),
      makeJob("row-waving", "queued", "2026-07-17T08:04:00.000Z"),
    ];
    expect(codexPetCurrentSubtask(jobs, "row-idle", "standard_generating"))
      .toBe("row-running-right");
    expect(codexPetCurrentSubtask(jobs.filter((job) => job.status !== "running"), "row-idle", "standard_generating"))
      .toBe("row-waving");
    expect(codexPetCurrentSubtask(jobs.filter((job) => job.status === "completed"), "row-idle", "standard_generating"))
      .toBe("row-idle");
    expect(codexPetCurrentSubtask([], null, "standard_generating")).toBe("standard_generating");
  });

  it("keeps the final two percent locked until validation, package, spritesheet and knowledge archive all exist", () => {
    const archiving = makeRun();
    expect(codexPetDisplayProgress(archiving, 100)).toBe(98);
    expect(isCodexPetDeliveryReady(archiving)).toBe(false);

    const ready = makeRun({ status: "ready", knowledgeDocumentId: "document-1", completedAt: "2026-07-17T08:12:00.000Z" });
    expect(isCodexPetDeliveryReady(ready)).toBe(true);
    expect(codexPetDisplayProgress(ready, 100)).toBe(100);

    expect(isCodexPetDeliveryReady({ ...ready, validationReport: { ok: false } })).toBe(false);
    expect(isCodexPetDeliveryReady({ ...ready, validationReport: { ok: true, spriteVersionNumber: 1 } })).toBe(false);
    expect(isCodexPetDeliveryReady({
      ...ready,
      validationReport: { ok: true, spriteVersionNumber: 2, directionRegistration: { ok: false } },
    })).toBe(false);
    expect(codexPetDisplayProgress({ ...ready, packageArtifactId: null }, 100)).toBe(98);
  });

  it("accepts only the fixed GPT Image and GPT-5.6 model provenance", () => {
    const ready = makeRun({
      status: "ready",
      knowledgeDocumentId: "document-1",
      completedAt: "2026-07-17T08:12:00.000Z",
    });
    expect(codexPetModelContractState(ready)).toBe("valid");

    const pending = makeRun({ visualQaActualModels: [], visualQaRoutes: [] });
    expect(codexPetModelContractState(pending)).toBe("pending");

    const invalidRuns: readonly CodexPetRun[] = [
      { ...ready, requestedModel: "qwen-image-2.0-pro-2026-04-22" },
      { ...ready, actualModels: ["gpt-image-2-qwen-fallback"] },
      { ...ready, visualQaModel: "qwen3.7-plus" },
      { ...ready, visualQaModel: "CHAT_MULTIMODAL_MODEL" },
      { ...ready, visualQaActualModels: ["gpt-5.6-sol-qwen-fallback"] },
      { ...ready, visualQaRoutes: ["default_multimodal_route"] },
      { ...ready, modelContractVersion: "" },
    ];
    for (const invalid of invalidRuns) {
      expect(codexPetModelContractState(invalid)).toBe("invalid");
      expect(isCodexPetDeliveryReady(invalid)).toBe(false);
    }
  });

  it("accepts the supported validation report status shapes", () => {
    expect(codexPetValidationPassed({ ok: true })).toBe(true);
    expect(codexPetValidationPassed({ validationStatus: "passed" })).toBe(true);
    expect(codexPetValidationPassed({ status: "FAILED" })).toBe(false);
    expect(codexPetValidationPassed(null)).toBe(false);
  });

  it("exposes all required v2 animation rows and clockwise look directions", () => {
    expect(CODEX_PET_STANDARD_STATES.map((state) => state.id)).toEqual([
      "idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review",
    ]);
    expect(CODEX_PET_LOOK_DIRECTIONS).toHaveLength(16);
    expect(CODEX_PET_LOOK_DIRECTIONS[0]).toBe("000");
    expect(CODEX_PET_LOOK_DIRECTIONS[8]).toBe("180");
    expect(CODEX_PET_LOOK_DIRECTIONS[15]).toBe("337.5");
  });
});
