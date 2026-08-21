/**
 * The durable row scope of a terminal deterministic/QA gate rejection.
 *
 * A gate that rejects the assembled atlas names the action groups it blames.
 * Recording that scope on the run makes an otherwise unreachable failure shape
 * continuable: every board row can be `completed` at the current prompt version
 * while the atlas still fails, and continuation admission that only asks "did
 * the prompt version move" has nothing to reset in that case.
 */
export const CODEX_PET_GATE_FAILURE_SCHEMA_VERSION = "codex-pet-gate-failure-v1";

/** Complete action groups a gate may blame. Single source of truth: the runner's
 * repair scopes and the continuation's resettable set must not drift apart. */
export const CODEX_PET_GATE_REPAIR_ROWS = [
  "idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review", "look-a", "look-b",
] as const;

export type CodexPetGateRepairRow = (typeof CODEX_PET_GATE_REPAIR_ROWS)[number];

export interface CodexPetGateFailureSnapshot {
  readonly gate: string;
  readonly rows: readonly CodexPetGateRepairRow[];
  readonly failures: readonly string[];
  readonly recordedAt: string;
}

function isGateRepairRow(value: unknown): value is CodexPetGateRepairRow {
  return typeof value === "string"
    && (CODEX_PET_GATE_REPAIR_ROWS as readonly string[]).includes(value);
}

/** Board job key that owns an action group. Standard rows are `row-<state>`;
 * the two direction rows are their own jobs. */
export function codexPetGateRowJobKey(row: CodexPetGateRepairRow): string {
  return row === "look-a" || row === "look-b" ? row : `row-${row}`;
}

export function codexPetGateFailureSnapshotValue(input: {
  readonly gate: string;
  readonly rows: readonly string[];
  readonly failures: readonly string[];
  readonly recordedAt?: Date;
}): Record<string, unknown> {
  return {
    schemaVersion: CODEX_PET_GATE_FAILURE_SCHEMA_VERSION,
    gate: input.gate,
    rows: input.rows.filter(isGateRepairRow),
    // Diagnostics are evidence for the user, not a replay contract; cap them so
    // a pathological gate cannot bloat the snapshot column.
    failures: input.failures.slice(0, 40).map((failure) => failure.slice(0, 400)),
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
  };
}

/**
 * Read a recorded gate scope. Returns null unless the snapshot is the current
 * schema and still names at least one action group, so an empty or legacy
 * record can never be mistaken for "everything is resettable".
 */
export function readCodexPetGateFailureSnapshot(inputSnapshot: unknown): CodexPetGateFailureSnapshot | null {
  if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot)) return null;
  const candidate = (inputSnapshot as Record<string, unknown>).gateFailure;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (record.schemaVersion !== CODEX_PET_GATE_FAILURE_SCHEMA_VERSION) return null;
  const rows = Array.isArray(record.rows) ? [...new Set(record.rows.filter(isGateRepairRow))] : [];
  if (rows.length === 0) return null;
  return {
    gate: typeof record.gate === "string" ? record.gate : "unknown",
    rows,
    failures: Array.isArray(record.failures)
      ? record.failures.filter((failure): failure is string => typeof failure === "string")
      : [],
    recordedAt: typeof record.recordedAt === "string" ? record.recordedAt : "",
  };
}
