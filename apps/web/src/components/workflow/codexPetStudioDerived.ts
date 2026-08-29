/**
 * 桌宠工坊的派生选择器。全是纯函数,输入只有 `detail` / `latestRun` / `pricing`,
 * 所以既能在 hook 里被 `useMemo` 包住,也能被面板直接调用。
 *
 * 三条不能动的取值规则(原文件的注释一并搬来,因为它们记的都是真实事故):
 *  - **所有视觉一律按当前 run 过滤**。`detail.artifacts` 是跨 run 的有界历史,不过滤会让上一轮的
 *    候选/预览出现在本轮工作台里,甚至让一次失败的 run 看起来像可交付。
 *  - **姿势板等过程产物不是交付物**(7 天 TTL),只出现在诊断折叠区;那里为空是正常的。
 *  - **「预计退回」必须按账本里真实发出的计划内调用数算**,不能用 `reserved - settled`:
 *    结算只在收尾发生一次,在那之前 `settled` 恒为 0,那个减法会把"全额退款"写在用户脸上。
 */
import {
  CODEX_PET_IMAGE_MODEL,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
} from "../../codexPetApi";
import type {
  CodexPetArtifact,
  CodexPetExtraCallBudget,
  CodexPetPricing,
  CodexPetProject,
  CodexPetProjectDetail,
  CodexPetProjectStatus,
  CodexPetProjectSummary,
  CodexPetRun,
} from "../../codexPetApi";
import {
  CODEX_PET_STANDARD_STATES,
  isCodexPetAnimationPreview,
  isCodexPetBaseCandidate,
  isCodexPetFinalContactSheet,
  isCodexPetProcessArtifact,
} from "./codexPetStudioModel";
import {
  GATE_ROW_LABELS,
  animationPreviewMatchesState,
  artifactTime,
  runIsTerminalStatus,
} from "./codexPetStudioFormat";

export function summaryFromProject(project: CodexPetProject): CodexPetProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    stylePreset: project.stylePreset,
    status: project.status,
    latestRunId: project.latestRunId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function upsertProjectSummary(
  projects: readonly CodexPetProjectSummary[],
  project: CodexPetProject,
): readonly CodexPetProjectSummary[] {
  return [summaryFromProject(project), ...projects.filter((item) => item.id !== project.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface CodexPetArtifactView {
  readonly artifacts: readonly CodexPetArtifact[];
  readonly baseCandidates: readonly CodexPetArtifact[];
  readonly processArtifacts: readonly CodexPetArtifact[];
  readonly standardAnimationPreviews: readonly {
    readonly state: (typeof CODEX_PET_STANDARD_STATES)[number];
    readonly artifact: CodexPetArtifact | null;
  }[];
  readonly readyStandardAnimationCount: number;
  readonly finalContactSheet: CodexPetArtifact | null;
  readonly spritesheetArtifact: CodexPetArtifact | null;
  readonly packageArtifact: CodexPetArtifact | null;
}

export function deriveCodexPetArtifacts(
  detail: CodexPetProjectDetail | null,
  latestRun: CodexPetRun | null,
): CodexPetArtifactView {
  const runId = latestRun?.id;
  const artifacts = runId ? (detail?.artifacts ?? []).filter((artifact) => artifact.runId === runId) : [];

  const baseCandidates = artifacts
    .filter(isCodexPetBaseCandidate)
    .slice()
    .sort((left, right) => artifactTime(left) - artifactTime(right));

  const processArtifacts = artifacts
    .filter(isCodexPetProcessArtifact)
    .slice()
    .sort((left, right) => artifactTime(right) - artifactTime(left));

  const animationPreviews = runId
    ? (detail?.artifacts ?? [])
      .filter((artifact) => artifact.runId === runId || artifact.runId === latestRun?.recoverySourceRunId)
      .filter(isCodexPetAnimationPreview)
      .slice()
      .sort((left, right) => {
        const currentRunPriority = Number(right.runId === runId) - Number(left.runId === runId);
        return currentRunPriority || artifactTime(right) - artifactTime(left);
      })
    : [];

  const standardAnimationPreviews = CODEX_PET_STANDARD_STATES.map((state) => ({
    state,
    artifact: animationPreviews.find((candidate) => animationPreviewMatchesState(candidate, state.id)) ?? null,
  }));

  const finalContactSheet = (() => {
    if (latestRun?.previewArtifactId) {
      const exact = artifacts.find((artifact) => (
        artifact.id === latestRun.previewArtifactId && isCodexPetFinalContactSheet(artifact)
      ));
      if (exact) return exact;
    }
    return artifacts
      .filter(isCodexPetFinalContactSheet)
      .slice()
      .sort((left, right) => artifactTime(right) - artifactTime(left))[0] ?? null;
  })();

  return {
    artifacts,
    baseCandidates,
    processArtifacts,
    standardAnimationPreviews,
    readyStandardAnimationCount: standardAnimationPreviews.filter((entry) => entry.artifact !== null).length,
    finalContactSheet,
    spritesheetArtifact: latestRun?.spritesheetArtifactId
      ? artifacts.find((artifact) => artifact.id === latestRun.spritesheetArtifactId) ?? null
      : null,
    packageArtifact: latestRun?.packageArtifactId
      ? artifacts.find((artifact) => artifact.id === latestRun.packageArtifactId) ?? null
      : null,
  };
}

export interface CodexPetBillingView {
  readonly settledPlannedUnits: number;
  readonly projectedRefundPoints: number | null;
  readonly plannedCallLimit: number;
  readonly reservedPointsQuote: number | null;
  readonly extraCallBudget: CodexPetExtraCallBudget | null;
  readonly extraCallBudgetExhausted: boolean;
}

export function deriveCodexPetBilling(
  detail: CodexPetProjectDetail | null,
  latestRun: CodexPetRun | null,
  pricing: CodexPetPricing | null,
): CodexPetBillingView {
  // Per-image billing settles the planned reservation by the number of calls that
  // actually reached the provider and did not fail — the same rule as the backend's
  // four settlement sites. Extra calls are charged separately and are never part of
  // this reservation, so they are excluded here too.
  const settledPlannedUnits = (detail?.imageCalls ?? []).filter((call) => (
    call.callKind === "planned" && call.sentAt !== null && call.status !== "failed"
  )).length;
  const extraCallBudget = detail?.extraCallBudget ?? null;
  // The reservation is `rate * plannedImageCallLimit`, and the limit is a backend
  // constant served with the price. Hard-coding 14 here meant a backend change to
  // the plan would quote the user a reservation the backend never charges.
  const plannedCallLimit = pricing?.plannedImageCallLimit
    ?? latestRun?.plannedImageCallLimit
    ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT;

  return {
    settledPlannedUnits,
    projectedRefundPoints: latestRun
      ? latestRun.billingSettlementStatus === "settled"
        ? Math.max(0, (latestRun.billingReservedPoints ?? 0) - (latestRun.billingSettledPoints ?? 0))
        : Math.max(0, ((latestRun.billingReservedUnits ?? 0) - settledPlannedUnits)) * (pricing?.rate ?? 0)
      : null,
    plannedCallLimit,
    reservedPointsQuote: pricing ? pricing.rate * plannedCallLimit : null,
    extraCallBudget,
    extraCallBudgetExhausted: Boolean(extraCallBudget?.exhausted),
  };
}

export interface CodexPetRunGateView {
  readonly projectStatus: CodexPetProjectStatus;
  readonly historicalImageModel: string | null;
  readonly readOnlyArchive: boolean;
  readonly runIsTerminal: boolean;
  readonly runAllowsInputEdit: boolean;
  readonly runIsCancellable: boolean;
  readonly canContinueFailedBase: boolean;
  readonly resumableGateRows: readonly string[];
  readonly canResumeGateFailure: boolean;
  readonly resumableGateRowLabels: string;
}

export function deriveCodexPetRunGates(
  detail: CodexPetProjectDetail | null,
  latestRun: CodexPetRun | null,
): CodexPetRunGateView {
  const projectStatus = detail?.project.status ?? "draft";
  const runIsTerminal = runIsTerminalStatus(latestRun);
  const canContinueFailedBase = Boolean(latestRun
    && latestRun.status === "failed"
    && latestRun.billingMode === "per_image_call_v1"
    && latestRun.requestedModel === CODEX_PET_IMAGE_MODEL
    && latestRun.qualityInspectionEnabled === false
    && latestRun.hasSuccessfulImage
    && !latestRun.selectedBaseArtifactId
    && latestRun.imageGenerationCallCount === 2
    && latestRun.plannedImageCallLimit === CODEX_PET_PLANNED_IMAGE_CALL_LIMIT);
  // 闸门在失败时把「该重做哪几组动作」写进了快照，后端据此原地重置那几个画板。
  const resumableGateRows = latestRun?.status === "failed" ? latestRun.resumableGateRows ?? [] : [];

  return {
    projectStatus,
    historicalImageModel: detail?.project.imageModel && detail.project.imageModel !== CODEX_PET_IMAGE_MODEL
      ? detail.project.imageModel
      : null,
    readOnlyArchive: projectStatus === "legacy_read_only",
    runIsTerminal,
    runAllowsInputEdit: !latestRun || runIsTerminal || latestRun.status === "awaiting_base_review",
    runIsCancellable: Boolean(latestRun && !runIsTerminal && !latestRun.cancelRequested),
    canContinueFailedBase,
    resumableGateRows,
    canResumeGateFailure: resumableGateRows.length > 0 && !canContinueFailedBase,
    resumableGateRowLabels: resumableGateRows.map((row) => GATE_ROW_LABELS[row] ?? row).join("、"),
  };
}
