import { describe, expect, it } from "vitest";
import {
  approvalTokenForCodexPetLookPoc,
  captureCodexPetLookPocLaunch,
  captureCodexPetLookBPocLaunch,
  createCodexPetLookPocSingleCallGuard,
} from "./codex-pet-look-poc-guard.js";

describe("codex pet look POC call guard", () => {
  it("captures launch controls without allowing dotenv values to enable live mode", () => {
    expect(captureCodexPetLookPocLaunch({})).toMatchObject({ mode: "disabled" });
    expect(captureCodexPetLookPocLaunch({
      PREPARE_CODEX_PET_LOOK_POC: "1",
      CODEX_PET_LOOK_POC_RUN_ID: "run-1",
      RUN_CODEX_PET_LOOK_POC: "0",
    })).toMatchObject({ mode: "prepare", sourceRunId: "run-1" });
  });

  it("requires an exact run-bound approval token for live mode", () => {
    expect(() => captureCodexPetLookPocLaunch({
      RUN_CODEX_PET_LOOK_POC: "1",
      CODEX_PET_LOOK_POC_RUN_ID: "run-1",
    })).toThrow(/exact run-bound approval token/);
    expect(() => captureCodexPetLookPocLaunch({
      RUN_CODEX_PET_LOOK_POC: "1",
      CODEX_PET_LOOK_POC_RUN_ID: "run-1",
      CODEX_PET_LOOK_POC_APPROVAL_TOKEN: approvalTokenForCodexPetLookPoc("run-2"),
    })).toThrow(/exact run-bound approval token/);
    expect(captureCodexPetLookPocLaunch({
      RUN_CODEX_PET_LOOK_POC: "1",
      CODEX_PET_LOOK_POC_RUN_ID: "run-1",
      CODEX_PET_LOOK_POC_APPROVAL_TOKEN: approvalTokenForCodexPetLookPoc("run-1"),
    })).toMatchObject({ mode: "live", sourceRunId: "run-1" });
  });

  it("allows exactly one attempt and advertises no retry", () => {
    const guard = createCodexPetLookPocSingleCallGuard({
      runId: "run-1",
      approvalToken: approvalTokenForCodexPetLookPoc("run-1"),
    });
    expect(guard.maxAttempts).toBe(1);
    expect(guard.approvedImageCalls).toBe(1);
    guard.onAttempt(1);
    expect(guard.attemptCount()).toBe(1);
    expect(() => guard.onAttempt(1)).toThrow(/already been consumed/);
    expect(() => guard.onAttempt(2)).toThrow(/already been consumed/);
  });

  it("rejects a guard token bound to another run", () => {
    expect(() => createCodexPetLookPocSingleCallGuard({
      runId: "run-1",
      approvalToken: approvalTokenForCodexPetLookPoc("run-2"),
    })).toThrow(/does not match the source run/);
  });

  it("captures look-b controls separately and keeps them disabled by default", () => {
    expect(captureCodexPetLookBPocLaunch({})).toMatchObject({ mode: "disabled" });
    expect(() => captureCodexPetLookBPocLaunch({
      RUN_CODEX_PET_LOOK_B_POC: "1",
      CODEX_PET_LOOK_B_POC_RUN_ID: "run-1",
    })).toThrow(/exact run-bound approval token/);
    expect(captureCodexPetLookBPocLaunch({
      PREPARE_CODEX_PET_LOOK_B_POC: "1",
      CODEX_PET_LOOK_B_POC_RUN_ID: "run-1",
      CODEX_PET_LOOK_B_POC_SOURCE_DIR: "/tmp/look-a",
    })).toMatchObject({ mode: "prepare", sourceRunId: "run-1", sourceDir: "/tmp/look-a" });
  });
});
