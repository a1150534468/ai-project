export const CODEX_PET_LOOK_POC_APPROVAL_PREFIX = "approve-one-gpt-image-call:";
export const CODEX_PET_LOOK_POC_REQUESTED_MODEL = "gpt-image-2";
export const CODEX_PET_LOOK_POC_EXPECTED_ACTUAL_MODEL = "gpt-image-2-codex";

export type CodexPetLookPocMode = "disabled" | "prepare" | "live";

export type CodexPetLookPocLaunchConfig = {
  readonly mode: CodexPetLookPocMode;
  readonly sourceRunId: string;
  readonly outputDir: string;
  readonly extraRepairHint: string;
  readonly approvalToken: string;
};

export type CodexPetLookBPocLaunchConfig = {
  readonly mode: CodexPetLookPocMode;
  readonly sourceRunId: string;
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly extraRepairHint: string;
  readonly approvalToken: string;
};

function text(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function approvalTokenForCodexPetLookPoc(runId: string): string {
  const normalizedRunId = text(runId);
  if (!normalizedRunId) throw new Error("run ID is required for a look POC approval token");
  return `${CODEX_PET_LOOK_POC_APPROVAL_PREFIX}${normalizedRunId}`;
}

/**
 * Read launch controls before loading a dotenv file.  This prevents a local
 * env file from silently enabling a live provider call or replacing the run
 * bound to an explicit user approval.
 */
export function captureCodexPetLookPocLaunch(env: NodeJS.ProcessEnv): CodexPetLookPocLaunchConfig {
  const prepare = env.PREPARE_CODEX_PET_LOOK_POC === "1";
  const live = env.RUN_CODEX_PET_LOOK_POC === "1";
  if (prepare && live) throw new Error("prepare and live look POC modes cannot be enabled together");
  const mode: CodexPetLookPocMode = live ? "live" : prepare ? "prepare" : "disabled";
  const sourceRunId = text(env.CODEX_PET_LOOK_POC_RUN_ID);
  const approvalToken = text(env.CODEX_PET_LOOK_POC_APPROVAL_TOKEN);
  if (mode !== "disabled" && !sourceRunId) {
    throw new Error("CODEX_PET_LOOK_POC_RUN_ID is required when the look POC is enabled");
  }
  if (mode === "live" && approvalToken !== approvalTokenForCodexPetLookPoc(sourceRunId)) {
    throw new Error("live look POC requires the exact run-bound approval token");
  }
  return {
    mode,
    sourceRunId,
    outputDir: text(env.CODEX_PET_LOOK_POC_OUTPUT_DIR) || "/tmp/codex-pet-look-poc",
    extraRepairHint: text(env.CODEX_PET_LOOK_POC_REPAIR_HINT),
    approvalToken,
  };
}

/** Capture row-10 controls before dotenv is loaded, just like the row-9 POC. */
export function captureCodexPetLookBPocLaunch(env: NodeJS.ProcessEnv): CodexPetLookBPocLaunchConfig {
  const prepare = env.PREPARE_CODEX_PET_LOOK_B_POC === "1";
  const live = env.RUN_CODEX_PET_LOOK_B_POC === "1";
  if (prepare && live) throw new Error("look-b prepare and live POC modes cannot be enabled together");
  const mode: CodexPetLookPocMode = live ? "live" : prepare ? "prepare" : "disabled";
  const sourceRunId = text(env.CODEX_PET_LOOK_B_POC_RUN_ID);
  const approvalToken = text(env.CODEX_PET_LOOK_B_POC_APPROVAL_TOKEN);
  if (mode !== "disabled" && !sourceRunId) {
    throw new Error("CODEX_PET_LOOK_B_POC_RUN_ID is required when the look-b POC is enabled");
  }
  if (mode === "live" && approvalToken !== approvalTokenForCodexPetLookPoc(sourceRunId)) {
    throw new Error("live look-b POC requires the exact run-bound approval token");
  }
  return {
    mode,
    sourceRunId,
    sourceDir: text(env.CODEX_PET_LOOK_B_POC_SOURCE_DIR) || "/tmp/codex-pet-look-poc",
    outputDir: text(env.CODEX_PET_LOOK_B_POC_OUTPUT_DIR) || "/tmp/codex-pet-look-b-poc",
    extraRepairHint: text(env.CODEX_PET_LOOK_B_POC_REPAIR_HINT),
    approvalToken,
  };
}

export type CodexPetLookPocSingleCallGuard = {
  readonly maxAttempts: 1;
  readonly approvedImageCalls: 1;
  readonly onAttempt: (attempt: number) => void;
  readonly attemptCount: () => number;
};

/**
 * A synchronous, one-shot budget consumed before the provider request.
 * `generateCodexPetVisual` calls onAttempt immediately before each transport
 * call, so a retry cannot reach the provider even if its retry policy changes.
 */
export function createCodexPetLookPocSingleCallGuard(input: {
  readonly runId: string;
  readonly approvalToken: string;
}): CodexPetLookPocSingleCallGuard {
  const runId = text(input.runId);
  if (!runId) throw new Error("run ID is required for a live look POC");
  if (input.approvalToken !== approvalTokenForCodexPetLookPoc(runId)) {
    throw new Error("live look POC approval token does not match the source run");
  }
  let attempts = 0;
  return {
    maxAttempts: 1,
    approvedImageCalls: 1,
    onAttempt(attempt) {
      if (attempt !== 1 || attempts !== 0) {
        throw new Error("the approved look POC image-call budget has already been consumed");
      }
      attempts = 1;
    },
    attemptCount: () => attempts,
  };
}
