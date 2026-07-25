export const CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION = "codex-pet-gpt-failed-continuation-v1";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export interface CodexPetGptFailedContinuationSnapshot {
  readonly sourceRunId: string;
  readonly sourceBaseArtifactId: string;
  readonly retryJobKey: "base-candidate-2";
  readonly sourcePlannedCallCount: number;
  readonly plannedCallsRemaining: number;
}

export function codexPetGptFailedContinuationSnapshot(
  inputSnapshot: unknown,
): CodexPetGptFailedContinuationSnapshot | null {
  const continuation = record(record(inputSnapshot).gptFailedContinuation);
  if (continuation.schemaVersion !== CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION
    || typeof continuation.sourceRunId !== "string"
    || typeof continuation.sourceBaseArtifactId !== "string"
    || continuation.retryJobKey !== "base-candidate-2"
    || !Number.isSafeInteger(continuation.sourcePlannedCallCount)
    || !Number.isSafeInteger(continuation.plannedCallsRemaining)) {
    return null;
  }
  return {
    sourceRunId: continuation.sourceRunId,
    sourceBaseArtifactId: continuation.sourceBaseArtifactId,
    retryJobKey: continuation.retryJobKey,
    sourcePlannedCallCount: Number(continuation.sourcePlannedCallCount),
    plannedCallsRemaining: Number(continuation.plannedCallsRemaining),
  };
}
