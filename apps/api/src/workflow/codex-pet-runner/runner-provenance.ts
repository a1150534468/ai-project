// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，视觉 QA 溯源与修复行推导）。

import { LOOK_DIRECTIONS } from "@ai-assistant/codex-pet-pipeline";
import { CODEX_PET_GATE_REPAIR_ROWS } from "../codex-pet-gate-failure.js";
import {
  CodexPetModelContractError,
  codexPetVisualQaRouteForModel,
  isAllowedCodexPetVisualModel,
} from "../codex-pet-model-contract.js";
import { type FinalRepairRow, type RunnerContext, type StandardRepairRow } from "../codex-pet-runner/runner-types.js";
import { asRecord } from "../codex-pet-runner/runner-util.js";
import { type PetVisualQaVerdict } from "../codex-pet-visual.js";

export const FINAL_REPAIR_ROWS = CODEX_PET_GATE_REPAIR_ROWS;

export function codexPetCoupledStandardRepairRows(rows: readonly StandardRepairRow[]): StandardRepairRow[] {
  const coupled = new Set(rows);
  if (coupled.has("running-right")) coupled.add("running-left");
  if (coupled.has("running-left")) coupled.add("running-right");
  // Jump scale is derived from idle, so replacing idle invalidates the
  // previously normalized jumping row even when jumping itself passed QA.
  if (coupled.has("idle")) coupled.add("jumping");
  return [...coupled].sort((left, right) => Number(right === "idle") - Number(left === "idle"));
}

/** Normalize model-provided repairRows and retain a conservative fallback for
 * providers upgraded before the structured field was introduced. */
export function repairRowsFromFinalQa(verdict: PetVisualQaVerdict): FinalRepairRow[] {
  const source = [
    ...(verdict.repairRows ?? []),
    ...verdict.failures,
    verdict.repairPrompt,
  ].join(" ").toLowerCase();
  const explicit = new Set((verdict.repairRows ?? []).map((candidate) => candidate.trim().toLowerCase().replace(/^row[-_]/, "").replaceAll("_", "-")));
  const rows = FINAL_REPAIR_ROWS.filter((row) =>
    explicit.has(row)
    || source.includes(row),
  );
  if (rows.length > 0) return [...rows];
  // A final verdict without structured scope is still actionable: regenerate
  // every complete action group once, never attempt a single-frame patch.
  return [...FINAL_REPAIR_ROWS];
}

/**
 * Which complete action groups a deterministic atlas gate implicates.
 *
 * Both atlas validators return `cells[]` keyed by `state`, and continuity's only
 * hard error is `<direction>:empty-direction-cell`, so a structural rejection is
 * row-addressable evidence rather than an unexplained wall. Without this
 * mapping the gates could only throw after all fourteen paid calls, which is
 * exactly how a run reached `failed` holding nine good action groups.
 */
export function repairRowsFromAtlasValidation(
  validation: { readonly cells: readonly { readonly state: string; readonly errors: readonly string[] }[]; readonly errors: readonly string[] },
): FinalRepairRow[] {
  const rows = new Set<FinalRepairRow>();
  for (const cell of validation.cells) {
    if (cell.errors.length === 0) continue;
    const row = FINAL_REPAIR_ROWS.find((candidate) => candidate === cell.state);
    if (row) rows.add(row);
  }
  return [...rows];
}

/**
 * Atlas-wide errors (wrong dimensions, missing alpha, an unattributed chroma
 * pixel count) are assembly or despill defects that regenerating an action group
 * cannot fix. They must stay hard failures instead of burning the repair budget.
 */
export function atlasValidationErrorsWithoutCellScope(
  validation: { readonly cells: readonly { readonly state: string; readonly column: number; readonly errors: readonly string[] }[]; readonly errors: readonly string[] },
): string[] {
  const cellScoped = new Set(validation.cells.flatMap((cell) => (
    cell.errors.map((error) => `${cell.state}[${cell.column}]:${error}`)
  )));
  return validation.errors.filter((error) => !cellScoped.has(error));
}

export function repairRowsFromDirectionContinuity(continuity: { readonly errors: readonly string[] }): FinalRepairRow[] {
  const rows = new Set<FinalRepairRow>();
  for (const error of continuity.errors) {
    const direction = error.split(":")[0] ?? "";
    const index = LOOK_DIRECTIONS.indexOf(direction as (typeof LOOK_DIRECTIONS)[number]);
    if (index < 0) continue;
    rows.add(index < 8 ? "look-a" : "look-b");
  }
  return [...rows];
}

export async function summarizeProviderUsage(ctx: RunnerContext): Promise<{ actualModels: string[]; usage: Record<string, number> }> {
  const artifacts = await ctx.prisma.codexPetArtifact.findMany({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      kind: { in: ["base_candidate", "pose_board"] },
    },
    select: { metadata: true },
  });
  const actualModels = new Set<string>();
  const usage = { inputTokens: 0, imageInputTokens: 0, textInputTokens: 0, outputTokens: 0, imageOutputTokens: 0, totalTokens: 0 };
  for (const artifact of artifacts) {
    const metadata = asRecord(artifact.metadata);
    if (typeof metadata.actualModel === "string") actualModels.add(metadata.actualModel);
    const row = asRecord(metadata.usage);
    for (const key of Object.keys(usage) as Array<keyof typeof usage>) {
      if (typeof row[key] === "number") usage[key] += row[key] as number;
    }
  }
  return { actualModels: [...actualModels], usage };
}

export const REQUIRED_VISUAL_JOB_KEYS = [
  "identity-guide",
  "row-idle",
  "row-running-right",
  "row-running-left",
  "row-waving",
  "row-jumping",
  "row-failed",
  "row-waiting",
  "row-running",
  "row-review",
  "look-mechanics",
  "look-cardinals",
  "look-a",
  "look-b",
] as const;

export interface VisualQaProvenanceSummary {
  readonly requestedModel: string;
  readonly actualModels: readonly string[];
  readonly routes: readonly string[];
}

export function assertCodexPetVisualQaProvenance(value: unknown, expectedModel: string, label: string): VisualQaProvenanceSummary {
  const row = asRecord(value);
  const actualModels = [...new Set([
    ...(typeof row.actualModel === "string" ? [row.actualModel.trim()] : []),
    ...(Array.isArray(row.actualModels)
      ? row.actualModels.filter((model): model is string => typeof model === "string").map((model) => model.trim())
      : []),
  ].filter(Boolean))];
  const routes = [...new Set([
    ...(typeof row.route === "string" ? [row.route.trim()] : []),
    ...(Array.isArray(row.routes)
      ? row.routes.filter((route): route is string => typeof route === "string").map((route) => route.trim())
      : []),
  ].filter(Boolean))];
  const expectedRoute = codexPetVisualQaRouteForModel(expectedModel);
  if (row.requestedModel !== expectedModel
    || actualModels.length === 0
    || actualModels.some((model) => !isAllowedCodexPetVisualModel(model) || model !== expectedModel)
    || routes.length === 0
    || routes.some((route) => route !== expectedRoute)) {
    throw new CodexPetModelContractError(`${label} 缺少可信的 ${expectedModel} 模型来源证明`);
  }
  return { requestedModel: expectedModel, actualModels, routes };
}

export async function summarizeRequiredVisualJobProvenance(ctx: RunnerContext): Promise<VisualQaProvenanceSummary> {
  const jobs = await ctx.prisma.codexPetJob.findMany({
    where: {
      runId: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      key: { in: ["base-selection", ...REQUIRED_VISUAL_JOB_KEYS] },
    },
  });
  const requiredKeys: string[] = [...REQUIRED_VISUAL_JOB_KEYS];
  const baseSelection = jobs.find((job) => job.key === "base-selection");
  if (!baseSelection) throw new Error("主形象选择任务缺失，不能证明可选视觉模型合同");
  if (asRecord(baseSelection.output).selectionMode !== "manual") requiredKeys.push("base-selection");

  const actualModels = new Set<string>();
  const routes = new Set<string>();
  for (const key of requiredKeys) {
    const job = jobs.find((candidate) => candidate.key === key);
    if (!job || job.status !== "completed") throw new Error(`${key} 未完成，不能证明可选视觉模型合同`);
    const visualQa = asRecord(job.providerMetadata).visualQa;
    const provenance = assertCodexPetVisualQaProvenance(visualQa, ctx.visualQaModel, key);
    provenance.actualModels.forEach((model) => actualModels.add(model));
    provenance.routes.forEach((route) => routes.add(route));
  }
  return { requestedModel: ctx.visualQaModel, actualModels: [...actualModels], routes: [...routes] };
}
