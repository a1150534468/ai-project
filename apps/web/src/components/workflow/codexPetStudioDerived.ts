/**
 * 桌宠工坊的派生选择器。全是纯函数,输入只有 `detail` / `latestRun`,
 * 所以既能在 hook 里被 `useMemo` 包住,也能被面板直接调用。
 *
 * 两条不能动的取值规则(原文件的注释一并搬来,因为它们记的都是真实事故):
 *  - **所有视觉一律按当前 run 过滤**。`detail.artifacts` 是跨 run 的有界历史,不过滤会让上一轮的
 *    候选/预览出现在本轮工作台里,甚至让一次失败的 run 看起来像可交付。
 *  - **姿势板等过程产物不是交付物**(7 天 TTL),只出现在诊断折叠区;那里为空是正常的。
 */
import {
  CODEX_PET_IMAGE_MODEL,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
} from "../../codexPetApi";
import type {
  CodexPetArtifact,
  CodexPetExtraCallBudget,
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
  readonly plannedCallLimit: number;
  readonly extraCallBudget: CodexPetExtraCallBudget | null;
  readonly extraCallBudgetExhausted: boolean;
}

export function deriveCodexPetRunGates(
  detail: CodexPetProjectDetail | null,
  latestRun: CodexPetRun | null,
): CodexPetRunGateView {
  const projectStatus = detail?.project.status ?? "draft";
  const runIsTerminal = runIsTerminalStatus(latestRun);
  const canContinueFailedBase = Boolean(latestRun
    && latestRun.status === "failed"
    && latestRun.requestedModel === CODEX_PET_IMAGE_MODEL
    && latestRun.qualityInspectionEnabled === false
    && latestRun.hasSuccessfulImage
    && !latestRun.selectedBaseArtifactId
    && latestRun.imageGenerationCallCount === 2
    && latestRun.plannedImageCallLimit === CODEX_PET_PLANNED_IMAGE_CALL_LIMIT);
  // 闸门在失败时把「该重做哪几组动作」写进了快照，后端据此原地重置那几个画板。
  const resumableGateRows = latestRun?.status === "failed" ? latestRun.resumableGateRows ?? [] : [];
  const extraCallBudget = detail?.extraCallBudget ?? null;

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
    // 计划内调用数是后端常量，启动时冻结在 run 行上；本地不许另写一份。
    plannedCallLimit: latestRun?.plannedImageCallLimit ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
    extraCallBudget,
    extraCallBudgetExhausted: Boolean(extraCallBudget?.exhausted),
  };
}
