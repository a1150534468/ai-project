import { Icon } from "@iconify/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ApiError } from "../../apiError";
import * as codexPetApi from "../../codexPetApi";
import {
  CODEX_PET_IMAGE_MODEL,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
  CODEX_PET_VISUAL_QA_MODEL,
} from "../../codexPetApi";
import type {
  CodexPetActionPromptKey,
  CodexPetArtifact,
  CodexPetBaseSelection,
  CodexPetCreatePayload,
  CodexPetEvent,
  CodexPetInstallLink,
  CodexPetPricing,
  CodexPetModelOptions,
  CodexPetProject,
  CodexPetProjectDetail,
  CodexPetProjectSummary,
  CodexPetReferenceAsset,
  CodexPetRun,
  CodexPetStartResult,
  CodexPetUpdatePayload,
} from "../../codexPetApi";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import {
  CODEX_PET_ACTION_PROMPT_MAX_LENGTH,
  CODEX_PET_ACTION_PROMPT_OPTIONS,
  CODEX_PET_LOOK_DIRECTIONS,
  CODEX_PET_MAX_REFERENCES,
  CODEX_PET_POLL_MS,
  CODEX_PET_PROGRESS_STEPS,
  CODEX_PET_STANDARD_STATES,
  CODEX_PET_STREAM_RECONNECT_MS,
  CODEX_PET_STYLE_OPTIONS,
  EMPTY_CODEX_PET_DRAFT,
  canEditCodexPetProject,
  codexPetArtifactUrl,
  codexPetCurrentSubtask,
  codexPetDisplayProgress,
  codexPetDraftFromProject,
  codexPetFileError,
  codexPetModelContractState,
  codexPetPayloadFromDraft,
  codexPetStatusLabel,
  codexPetValidationPassed,
  codexPetProcessArtifactLabel,
  isCodexPetAnimationPreview,
  isCodexPetBaseCandidate,
  isCodexPetDeliveryReady,
  isCodexPetFinalContactSheet,
  isCodexPetProcessArtifact,
  makeCodexPetIdempotencyKey,
  mergeCodexPetEvents,
  validateCodexPetDraft,
  type CodexPetDraft,
} from "./codexPetStudioModel";

export interface CodexPetStudioClient {
  readonly getPricing: (token: string) => Promise<CodexPetPricing>;
  readonly getModelOptions?: (token: string) => Promise<CodexPetModelOptions>;
  readonly listProjects: (token: string) => Promise<readonly CodexPetProjectSummary[]>;
  readonly createProject: (token: string, payload: CodexPetCreatePayload) => Promise<CodexPetProject>;
  readonly getProject: (token: string, projectId: string, signal?: AbortSignal) => Promise<CodexPetProjectDetail>;
  readonly updateProject: (token: string, projectId: string, payload: CodexPetUpdatePayload) => Promise<CodexPetProject>;
  readonly deleteProject: (token: string, projectId: string) => Promise<void>;
  readonly startRun: (token: string, projectId: string, idempotencyKey: string) => Promise<CodexPetStartResult>;
  readonly continueFailedRun: (token: string, projectId: string, runId: string, idempotencyKey: string) => Promise<CodexPetStartResult>;
  readonly resumeGateFailure: (token: string, projectId: string, runId: string, reason?: string) => Promise<CodexPetStartResult>;
  readonly selectBase: (
    token: string,
    projectId: string,
    runId: string,
    selection: CodexPetBaseSelection,
  ) => Promise<CodexPetRun>;
  readonly approveNextImage: (token: string, projectId: string, runId: string, idempotencyKey: string) => Promise<CodexPetRun>;
  readonly cancelRun: (token: string, projectId: string, runId: string) => Promise<CodexPetRun>;
  readonly listEvents: (
    token: string,
    projectId: string,
    runId: string,
    after?: number,
    signal?: AbortSignal,
  ) => Promise<{ readonly events: readonly CodexPetEvent[]; readonly cursor: number }>;
  readonly streamEvents: typeof codexPetApi.streamCodexPetEvents;
  readonly createInstallLink: (token: string, projectId: string) => Promise<CodexPetInstallLink>;
  readonly downloadPackage: typeof codexPetApi.downloadCodexPetPackage;
  readonly uploadReference: typeof codexPetApi.uploadCodexPetReferenceAsset;
}

const DEFAULT_CLIENT: CodexPetStudioClient = {
  getPricing: codexPetApi.getCodexPetPricing,
  getModelOptions: codexPetApi.getCodexPetModelOptions,
  listProjects: codexPetApi.listCodexPetProjects,
  createProject: codexPetApi.createCodexPetProject,
  getProject: codexPetApi.getCodexPetProject,
  updateProject: codexPetApi.updateCodexPetProject,
  deleteProject: codexPetApi.deleteCodexPetProject,
  startRun: codexPetApi.startCodexPetRun,
  continueFailedRun: codexPetApi.continueFailedCodexPetRun,
  resumeGateFailure: codexPetApi.resumeCodexPetGateFailure,
  selectBase: codexPetApi.selectCodexPetBase,
  approveNextImage: codexPetApi.approveCodexPetNextImage,
  cancelRun: codexPetApi.cancelCodexPetRun,
  listEvents: codexPetApi.listCodexPetEvents,
  streamEvents: codexPetApi.streamCodexPetEvents,
  createInstallLink: codexPetApi.createCodexPetInstallLink,
  downloadPackage: codexPetApi.downloadCodexPetPackage,
  uploadReference: codexPetApi.uploadCodexPetReferenceAsset,
};

export interface CodexPetStudioProps {
  readonly token: string;
  readonly initialProjectId?: string | null;
  readonly onBalanceRefresh?: () => void;
  readonly onOpenKnowledgeDocument?: (documentId: string) => void;
  readonly onInstallUrl?: (url: string) => void;
  readonly client?: CodexPetStudioClient;
}

type BusyAction =
  | "saving"
  | "starting"
  | "continuing"
  | "resuming-gate"
  | "uploading"
  | "deleting"
  | "cancelling"
  | "selecting-base"
  | "regenerating-base"
  | "approving-image"
  | "installing"
  | "downloading"
  | null;

/** 闸门失败范围里的动作组名 → 中文展示名。 */
const GATE_ROW_LABELS: Record<string, string> = {
  ...Object.fromEntries(CODEX_PET_STANDARD_STATES.map((state) => [state.id, state.label])),
  "look-a": "环视 A（0°–157.5°）",
  "look-b": "环视 B（180°–337.5°）",
};

type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "polling" | "ended";

const TERMINAL_RUN_STATUSES = new Set(["ready", "failed", "cancelled", "legacy_read_only"]);
const DETAIL_REFRESH_EVENTS = new Set([
  "preview.ready",
  "base.review_required",
  "image.approval_required",
  "image.call.started",
  "job.completed",
  "validation.failed",
  "package.ready",
  "knowledge.archive_completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "billing.refunded",
]);

const EVENT_LABELS: Record<string, string> = {
  "run.queued": "任务已进入队列",
  "run.continuation_prepared": "失败项目续跑已准备",
  "stage.started": "阶段开始",
  "stage.completed": "阶段完成",
  "job.started": "视觉任务开始",
  "job.retrying": "视觉任务重试",
  "job.completed": "视觉任务完成",
  "preview.ready": "新预览可用",
  "base.review_required": "请确认主形象",
  "image.call.started": "已发起真实生图调用",
  "image.call.approved": "已批准一次真实生图",
  "image.approval_required": "等待批准下一次真实生图",
  "validation.warning": "质量检查警告",
  "validation.failed": "质量检查未通过",
  "run.repairing": "正在自动修复",
  "package.ready": "兼容包已生成",
  "knowledge.archive_started": "开始归档知识库",
  "knowledge.archive_completed": "知识库归档完成",
  "knowledge.archive_retrying": "知识库归档重试",
  "run.completed": "桌宠制作完成",
  "run.failed": "桌宠制作失败",
  "run.cancellation_requested": "已请求取消桌宠制作",
  "run.cancelled": "桌宠制作已取消",
  "billing.refunded": "积分已退款",
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 402) return "积分不足，请充值后再开始制作";
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function summaryFromProject(project: CodexPetProject): CodexPetProjectSummary {
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

function upsertProjectSummary(
  projects: readonly CodexPetProjectSummary[],
  project: CodexPetProject,
): readonly CodexPetProjectSummary[] {
  return [summaryFromProject(project), ...projects.filter((item) => item.id !== project.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactTime(artifact: CodexPetArtifact): number {
  const value = new Date(artifact.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function artifactJobKey(artifact: CodexPetArtifact): string {
  const value = artifact.metadata?.jobKey;
  return typeof value === "string" ? value : "";
}

function animationPreviewMatchesState(artifact: CodexPetArtifact, stateId: string): boolean {
  const jobKey = `row-${stateId}`;
  if (artifactJobKey(artifact) === jobKey) return true;
  // The derived running-left preview predates the row job metadata and keeps
  // its state in the human-readable artifact name.  Keep this fallback for
  // old runs while preferring the structured jobKey for normal rows.
  return stateId === "running-left"
    && artifact.name.toLowerCase().startsWith("running-left ");
}

function validationSummary(report: unknown): string {
  if (!report || typeof report !== "object") return "尚无质量报告";
  const value = report as Record<string, unknown>;
  const errors = Array.isArray(value.errors) ? value.errors.length : 0;
  const warnings = Array.isArray(value.warnings) ? value.warnings.length : 0;
  const status = codexPetValidationPassed(report) ? "已通过" : "未通过";
  return `${status} · ${errors} 个错误 · ${warnings} 个可接受警告`;
}

function refundStatusLabel(run: CodexPetRun | null | undefined): string {
  if (run?.billingRefundedAt || run?.billingRefundStatus === "refunded") return "已全额退款";
  if (run?.billingRefundStatus === "pending") return "退款处理中";
  if (run?.billingRefundStatus === "failed") return "退款待重试";
  return "未退款";
}

function eventTitle(event: CodexPetEvent): string {
  return event.message || EVENT_LABELS[event.type] || event.type;
}

function openDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function launchInstallUrl(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function Card({ children, className = "", ariaLabel }: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly ariaLabel?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={`rounded-[16px] border border-[#e6e7eb] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)] ${className}`}
    >
      {children}
    </section>
  );
}

function CardTitle({ icon, title, aside }: { readonly icon: string; readonly title: string; readonly aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-[#eef0f3] px-4 py-3">
      <span className="grid size-7 place-items-center rounded-[8px] bg-brand-soft text-brand-ink">
        <Icon icon={icon} className="text-base" aria-hidden />
      </span>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
  );
}

function StatusPill({ status }: { readonly status: string }) {
  const complete = status === "ready";
  const failed = status === "failed" || status === "cancelled";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
      complete ? "bg-brand-soft text-brand-ink" : failed ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-ink"
    }`}>
      {codexPetStatusLabel(status)}
    </span>
  );
}

function PrimaryButton(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly kind?: "primary" | "secondary" | "danger";
  readonly icon?: string;
  readonly ariaLabel?: string;
}) {
  const kind = props.kind ?? "primary";
  const colors = kind === "primary"
    ? "bg-brand text-white "
    : kind === "danger"
      ? "border border-red-200 bg-white text-red-600 "
      : "border border-[#dfe1e6] bg-white text-ink ";
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[10px] px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-45 ${colors}`}
    >
      {props.icon && <Icon icon={props.icon} className="text-base" aria-hidden />}
      {props.children}
    </button>
  );
}

function ImagePlaceholder({ text }: { readonly text: string }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-[12px] border border-dashed border-[#d9dce3] bg-[#fafafd] px-5 text-center text-xs leading-5 text-[#888891]">
      {text}
    </div>
  );
}

export function CodexPetStudio({
  token,
  initialProjectId,
  onBalanceRefresh,
  onOpenKnowledgeDocument,
  onInstallUrl,
  client = DEFAULT_CLIENT,
}: CodexPetStudioProps) {
  const [projects, setProjects] = useState<readonly CodexPetProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null | undefined>(initialProjectId ?? undefined);
  const [detail, setDetail] = useState<CodexPetProjectDetail | null>(null);
  const [draft, setDraft] = useState<CodexPetDraft>(EMPTY_CODEX_PET_DRAFT);
  const [selectedActionPrompt, setSelectedActionPrompt] = useState<CodexPetActionPromptKey>("idle");
  const [pricing, setPricing] = useState<CodexPetPricing | null>(null);
  const [modelOptions, setModelOptions] = useState<CodexPetModelOptions>({
    visualModels: [{ model: CODEX_PET_VISUAL_QA_MODEL, displayName: "GPT-5.6 Sol" }],
    imageModels: [{ model: CODEX_PET_IMAGE_MODEL, displayName: "GPT Image 2" }],
  });
  const [events, setEvents] = useState<readonly CodexPetEvent[]>([]);
  const [selectedBaseArtifactId, setSelectedBaseArtifactId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showActualSize, setShowActualSize] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedProjectIdRef = useRef<string | null | undefined>(undefined);
  const draftProjectIdRef = useRef<string | null>(null);
  const eventCursorRef = useRef(0);
  const detailRevisionRef = useRef(0);
  const createIdempotencyKeyRef = useRef(makeCodexPetIdempotencyKey("project"));
  const runIdempotencyKeyRef = useRef<{ readonly projectId: string; readonly key: string } | null>(null);
  const continuationIdempotencyKeyRef = useRef<{ readonly runId: string; readonly key: string } | null>(null);
  const terminalBalanceRefreshRef = useRef<{ readonly runId: string; readonly status: string } | null>(null);

  selectedProjectIdRef.current = selectedProjectId;

  const latestRun = detail?.latestRun ?? null;
  // Project details include a bounded history of artifacts from every run.
  // Rendering that unfiltered list lets a previous run's candidate/preview
  // appear in the current run's workbench (and can even make a failed run
  // look deliverable).  Every visual shown here is scoped to the run currently
  // represented by `latestRun`.
  const artifacts = useMemo<readonly CodexPetArtifact[]>(() => {
    const runId = latestRun?.id;
    if (!runId) return [];
    return (detail?.artifacts ?? []).filter((artifact) => artifact.runId === runId);
  }, [detail?.artifacts, latestRun?.id]);
  const baseCandidates = useMemo(
    () => artifacts.filter(isCodexPetBaseCandidate).slice().sort((left, right) => artifactTime(left) - artifactTime(right)),
    [artifacts],
  );
  // Pose boards and direction QA sheets are pipeline intermediates with a 7-day
  // TTL, not deliverables.  They stay reachable in the diagnostics panel below
  // the workbench, where an expired/empty list reads as expected rather than as
  // a broken deliverable slot.
  const processArtifacts = useMemo(
    () => artifacts
      .filter(isCodexPetProcessArtifact)
      .slice()
      .sort((left, right) => artifactTime(right) - artifactTime(left)),
    [artifacts],
  );
  const animationPreviews = useMemo(
    () => {
      const currentRunId = latestRun?.id;
      if (!currentRunId) return [];
      const sourceRunId = latestRun.recoverySourceRunId;
      return (detail?.artifacts ?? [])
        .filter((artifact) => artifact.runId === currentRunId || artifact.runId === sourceRunId)
        .filter(isCodexPetAnimationPreview)
        .slice()
        .sort((left, right) => {
          const currentRunPriority = Number(right.runId === currentRunId) - Number(left.runId === currentRunId);
          return currentRunPriority || artifactTime(right) - artifactTime(left);
        });
    },
    [detail?.artifacts, latestRun?.id, latestRun?.recoverySourceRunId],
  );
  const standardAnimationPreviews = useMemo(
    () => CODEX_PET_STANDARD_STATES.map((state) => ({
      state,
      artifact: animationPreviews
        .find((candidate) => animationPreviewMatchesState(candidate, state.id)) ?? null,
    })),
    [animationPreviews],
  );
  const readyStandardAnimationCount = standardAnimationPreviews
    .filter((entry) => entry.artifact !== null).length;
  const finalContactSheet = useMemo(() => {
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
  }, [artifacts, latestRun?.previewArtifactId]);
  const spritesheetArtifact = latestRun?.spritesheetArtifactId
    ? artifacts.find((artifact) => artifact.id === latestRun.spritesheetArtifactId) ?? null
    : null;
  const packageArtifact = latestRun?.packageArtifactId
    ? artifacts.find((artifact) => artifact.id === latestRun.packageArtifactId) ?? null
    : null;
  const deliveryReady = isCodexPetDeliveryReady(latestRun);
  const modelContractState = codexPetModelContractState(latestRun);
  const lastEvent = events.at(-1);
  const currentSubtask = codexPetCurrentSubtask(
    detail?.jobs ?? [],
    lastEvent?.jobKey,
    latestRun?.progressStage,
  );
  const progress = codexPetDisplayProgress(latestRun, lastEvent?.progress ?? 0);
  const projectStatus = detail?.project.status ?? "draft";
  const historicalImageModel = detail?.project.imageModel
    && detail.project.imageModel !== CODEX_PET_IMAGE_MODEL
    ? detail.project.imageModel
    : null;
  const readOnlyArchive = projectStatus === "legacy_read_only";
  const runIsTerminal = latestRun ? TERMINAL_RUN_STATUSES.has(latestRun.status) : false;
  const runAllowsInputEdit = !latestRun || runIsTerminal || latestRun.status === "awaiting_base_review";
  // Keep the previous detail visible while a project switch is loading, but
  // never let actions use it with the newly selected project id. Without this
  // gate a fast click on “保存草稿” could PATCH the new project with the old
  // project's still-rendered inputs before its detail request completed.
  const detailMatchesSelection = selectedProjectId === null
    || selectedProjectId === undefined
    || detail?.project.id === selectedProjectId;
  const selectionIsPending = Boolean(loadingDetail && selectedProjectId && !detailMatchesSelection);
  const interactionLocked = busyAction !== null || bootstrapping || loadingDetail || selectionIsPending;
  const canEdit = !historicalImageModel && !readOnlyArchive && !interactionLocked && (
    selectedProjectId === null
    || selectedProjectId === undefined
    || (detailMatchesSelection && canEditCodexPetProject(projectStatus) && runAllowsInputEdit)
  );
  const canStart = !historicalImageModel && !readOnlyArchive && !interactionLocked
    && (!selectedProjectId || (detailMatchesSelection && projectStatus === "draft" && (!latestRun || runIsTerminal)));
  const runIsCancellable = Boolean(latestRun && !runIsTerminal && !latestRun.cancelRequested);
  const extraCallBudget = detail?.extraCallBudget ?? null;
  const extraCallBudgetExhausted = Boolean(extraCallBudget?.exhausted);
  // Per-image billing settles the planned reservation by the number of calls that
  // actually reached the provider and did not fail — the same rule as the backend's
  // four settlement sites. Extra calls are charged separately and are never part of
  // this reservation, so they are excluded here too.
  const settledPlannedUnits = (detail?.imageCalls ?? []).filter((call) => (
    call.callKind === "planned" && call.sentAt !== null && call.status !== "failed"
  )).length;
  const projectedRefundPoints = latestRun
    ? latestRun.billingSettlementStatus === "settled"
      ? Math.max(0, (latestRun.billingReservedPoints ?? 0) - (latestRun.billingSettledPoints ?? 0))
      : Math.max(0, ((latestRun.billingReservedUnits ?? 0) - settledPlannedUnits)) * (pricing?.rate ?? 0)
    : null;
  // The reservation is `rate * plannedImageCallLimit`, and the limit is a backend
  // constant served with the price. Hard-coding 14 here meant a backend change to
  // the plan would quote the user a reservation the backend never charges.
  const plannedCallLimit = pricing?.plannedImageCallLimit
    ?? latestRun?.plannedImageCallLimit
    ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT;
  const reservedPointsQuote = pricing ? pricing.rate * plannedCallLimit : null;
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
  const canResumeGateFailure = resumableGateRows.length > 0 && !canContinueFailedBase;
  const resumableGateRowLabels = resumableGateRows
    .map((row) => GATE_ROW_LABELS[row] ?? row)
    .join("、");

  const applyDetail = useCallback((next: CodexPetProjectDetail, hydrateDraft: boolean) => {
    detailRevisionRef.current += 1;
    setDetail(next);
    setProjects((current) => upsertProjectSummary(current, next.project));
    if (hydrateDraft || draftProjectIdRef.current !== next.project.id) {
      draftProjectIdRef.current = next.project.id;
      setDraft(codexPetDraftFromProject(next.project));
    }
  }, []);

  const refreshSelectedProject = useCallback(async (silent = true): Promise<CodexPetProjectDetail | null> => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return null;
    const revision = detailRevisionRef.current;
    try {
      const next = await client.getProject(token, projectId);
      if (selectedProjectIdRef.current !== projectId || detailRevisionRef.current !== revision) return null;
      applyDetail(next, false);
      return next;
    } catch (refreshError) {
      if (!silent) setError(errorMessage(refreshError, "刷新桌宠项目失败"));
      return null;
    }
  }, [applyDetail, client, token]);

  useEffect(() => {
    if (!initialProjectId || initialProjectId === selectedProjectIdRef.current) return;
    setSelectedProjectId(initialProjectId);
    selectedProjectIdRef.current = initialProjectId;
    detailRevisionRef.current += 1;
    setDetail(null);
    setDraft(EMPTY_CODEX_PET_DRAFT);
    setLoadingDetail(true);
    setEvents([]);
    eventCursorRef.current = 0;
    clearFeedback();
  }, [initialProjectId]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const [pricingResult, projectsResult, modelOptionsResult] = await Promise.allSettled([
        client.getPricing(token),
        client.listProjects(token),
        (client.getModelOptions ?? codexPetApi.getCodexPetModelOptions)(token),
      ]);
      if (disposed) return;
      if (pricingResult.status === "fulfilled") setPricing(pricingResult.value);
      else setNotice("套餐价格暂时无法加载，开始制作前请稍后重试");
      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value);
        if (selectedProjectIdRef.current === undefined) {
          setSelectedProjectId(projectsResult.value[0]?.id ?? null);
        }
      } else {
        setError(errorMessage(projectsResult.reason, "加载桌宠项目失败"));
        if (selectedProjectIdRef.current === undefined) setSelectedProjectId(null);
      }
      if (modelOptionsResult.status === "fulfilled") setModelOptions(modelOptionsResult.value);
      else setNotice("模型目录暂时无法加载，已保留 GPT 默认选项");
      setBootstrapping(false);
    })();
    return () => { disposed = true; };
  }, [client, token]);

  useEffect(() => {
    if (!selectedProjectId) {
      setLoadingDetail(false);
      if (selectedProjectId === null) {
        setDetail(null);
        draftProjectIdRef.current = null;
      }
      return undefined;
    }
    const projectId = selectedProjectId;
    const revision = detailRevisionRef.current;
    const controller = new AbortController();
    setLoadingDetail(true);
    setEvents([]);
    eventCursorRef.current = 0;
    void client.getProject(token, projectId, controller.signal)
      .then((next) => {
        if (selectedProjectIdRef.current !== projectId || detailRevisionRef.current !== revision) return;
        applyDetail(next, true);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) setError(errorMessage(loadError, "加载桌宠项目详情失败"));
      })
      .finally(() => {
        if (selectedProjectIdRef.current === projectId) setLoadingDetail(false);
      });
    return () => controller.abort();
  }, [applyDetail, client, selectedProjectId, token]);

  useEffect(() => {
    if (baseCandidates.length === 0) {
      setSelectedBaseArtifactId(null);
      return;
    }
    setSelectedBaseArtifactId((current) => {
      if (current && baseCandidates.some((candidate) => candidate.id === current)) return current;
      if (latestRun?.selectedBaseArtifactId && baseCandidates.some((candidate) => candidate.id === latestRun.selectedBaseArtifactId)) {
        return latestRun.selectedBaseArtifactId;
      }
      return baseCandidates[0]?.id ?? null;
    });
  }, [baseCandidates, latestRun?.selectedBaseArtifactId]);

  useEffect(() => {
    const projectId = detail?.project.id;
    const run = detail?.latestRun;
    if (!projectId || !run) {
      setEvents([]);
      eventCursorRef.current = 0;
      setStreamState("idle");
      return undefined;
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    let detailRefreshTimer: number | undefined;
    const controller = new AbortController();
    eventCursorRef.current = 0;
    setEvents([]);

    const acceptEvents = (incoming: readonly CodexPetEvent[]) => {
      if (disposed || incoming.length === 0) return;
      eventCursorRef.current = Math.max(eventCursorRef.current, ...incoming.map((event) => event.sequence));
      setEvents((current) => mergeCodexPetEvents(current, incoming));
      if (incoming.some((event) => DETAIL_REFRESH_EVENTS.has(event.type))) {
        if (detailRefreshTimer !== undefined) window.clearTimeout(detailRefreshTimer);
        detailRefreshTimer = window.setTimeout(() => { void refreshSelectedProject(true); }, 160);
      }
    };

    const replayPersisted = async () => {
      const replay = await client.listEvents(token, projectId, run.id, eventCursorRef.current, controller.signal);
      acceptEvents(replay.events);
      eventCursorRef.current = Math.max(eventCursorRef.current, replay.cursor);
    };

    let reconnecting = false;
    const connect = async () => {
      if (disposed) return;
      setStreamState(reconnecting ? "reconnecting" : "connecting");
      try {
        await replayPersisted();
        if (disposed || TERMINAL_RUN_STATUSES.has(run.status)) {
          if (!disposed) setStreamState("ended");
          return;
        }
        setStreamState("live");
        await client.streamEvents({
          token,
          projectId,
          runId: run.id,
          after: eventCursorRef.current,
          signal: controller.signal,
          onEvent: (event) => acceptEvents([event]),
        });
        if (disposed) return;
      } catch (streamError) {
        if (disposed || isAbortError(streamError)) return;
        setStreamState("polling");
      }
      reconnecting = true;
      reconnectTimer = window.setTimeout(() => { void connect(); }, CODEX_PET_STREAM_RECONNECT_MS);
    };

    void connect();
    return () => {
      disposed = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (detailRefreshTimer !== undefined) window.clearTimeout(detailRefreshTimer);
    };
  }, [client, detail?.latestRun?.id, detail?.latestRun?.status, detail?.project.id, refreshSelectedProject, token]);

  useEffect(() => {
    const projectId = detail?.project.id;
    const run = detail?.latestRun;
    if (!projectId || !run || TERMINAL_RUN_STATUSES.has(run.status)) return undefined;
    let disposed = false;
    const poll = async () => {
      const revision = detailRevisionRef.current;
      const [nextDetail, replay] = await Promise.allSettled([
        client.getProject(token, projectId),
        client.listEvents(token, projectId, run.id, eventCursorRef.current),
      ]);
      if (disposed || selectedProjectIdRef.current !== projectId) return;
      if (nextDetail.status === "fulfilled" && detailRevisionRef.current === revision) applyDetail(nextDetail.value, false);
      if (replay.status === "fulfilled") {
        eventCursorRef.current = Math.max(eventCursorRef.current, replay.value.cursor);
        setEvents((current) => mergeCodexPetEvents(current, replay.value.events));
      }
    };
    const timer = window.setInterval(() => { void poll(); }, CODEX_PET_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [applyDetail, client, detail?.latestRun?.id, detail?.latestRun?.status, detail?.project.id, token]);

  useEffect(() => {
    if (!latestRun || !TERMINAL_RUN_STATUSES.has(latestRun.status)) return;
    const last = terminalBalanceRefreshRef.current;
    if (last?.runId === latestRun.id && last.status === latestRun.status) return;
    terminalBalanceRefreshRef.current = { runId: latestRun.id, status: latestRun.status };
    onBalanceRefresh?.();
  }, [latestRun?.id, latestRun?.status, onBalanceRefresh]);

  const clearFeedback = () => {
    setError("");
    setNotice("");
  };

  const updateDraft = <K extends keyof CodexPetDraft>(key: K, value: CodexPetDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearFeedback();
  };

  const updateActionPrompt = (value: string) => {
    setDraft((current) => ({
      ...current,
      actionPrompts: { ...current.actionPrompts, [selectedActionPrompt]: value },
    }));
    clearFeedback();
  };

  const startNewProject = () => {
    if (interactionLocked) return;
    setSelectedProjectId(null);
    selectedProjectIdRef.current = null;
    detailRevisionRef.current += 1;
    setDetail(null);
    setDraft(EMPTY_CODEX_PET_DRAFT);
    setEvents([]);
    setSelectedBaseArtifactId(null);
    draftProjectIdRef.current = null;
    eventCursorRef.current = 0;
    createIdempotencyKeyRef.current = makeCodexPetIdempotencyKey("project");
    runIdempotencyKeyRef.current = null;
    clearFeedback();
  };

  const persistDraft = async (): Promise<CodexPetProject> => {
    // Saving a draft is deliberately less strict than starting a billable
    // run.  This allows a user to save the name/style first and add visual
    // input in a later edit; handleStart performs the required-input gate.
    const validationError = validateCodexPetDraft(draft, { requireVisualInput: false });
    if (validationError) throw new Error(validationError);
    const currentProjectId = selectedProjectIdRef.current;
    const project = currentProjectId
      ? await client.updateProject(token, currentProjectId, codexPetPayloadFromDraft(draft))
      : await client.createProject(token, codexPetPayloadFromDraft(draft, createIdempotencyKeyRef.current));
    setProjects((current) => upsertProjectSummary(current, project));
    setSelectedProjectId(project.id);
    selectedProjectIdRef.current = project.id;
    draftProjectIdRef.current = project.id;
    setDraft(codexPetDraftFromProject(project));
    detailRevisionRef.current += 1;
    setDetail((current) => current?.project.id === project.id
      ? { ...current, project }
      : { project, latestRun: null, runs: [], artifacts: [], jobs: [] });
    if (!currentProjectId) createIdempotencyKeyRef.current = makeCodexPetIdempotencyKey("project");
    return project;
  };

  const handleSaveDraft = () => {
    if (interactionLocked || !canEdit) return;
    clearFeedback();
    setBusyAction("saving");
    const regeneratesCandidates = projectStatus === "awaiting_base_review";
    void persistDraft()
      .then(async () => {
        setNotice(regeneratesCandidates ? "输入已保存，正在重新生成主形象候选" : "草稿已保存，尚未扣费");
        // The PATCH response includes the project while the run is reset by
        // the server. Refresh immediately so stale candidates cannot remain
        // selectable until the next 2.5-second fallback poll.
        if (regeneratesCandidates) await refreshSelectedProject(true);
      })
      .catch((saveError: unknown) => setError(errorMessage(saveError, "保存桌宠草稿失败")))
      .finally(() => setBusyAction(null));
  };

  const handleStart = () => {
    if (interactionLocked || !canStart) return;
    const validationError = validateCodexPetDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!pricing?.enabled) {
      setError("桌宠套餐当前不可用，请等待管理员开启后再试");
      return;
    }
    clearFeedback();
    setBusyAction("starting");
    void (async () => {
      try {
        const project = await persistDraft();
        const currentKey = runIdempotencyKeyRef.current?.projectId === project.id
          ? runIdempotencyKeyRef.current.key
          : makeCodexPetIdempotencyKey("run");
        runIdempotencyKeyRef.current = { projectId: project.id, key: currentKey };
        const started = await client.startRun(token, project.id, currentKey);
        runIdempotencyKeyRef.current = null;
        applyDetail({ project: started.project, latestRun: started.run, runs: [started.run], artifacts: [], jobs: [] }, false);
        setNotice("制作任务已提交，实时进度已连接");
        onBalanceRefresh?.();
        void refreshSelectedProject(true);
      } catch (startError) {
        setError(errorMessage(startError, "启动桌宠制作失败"));
      } finally {
        setBusyAction(null);
      }
    })();
  };

  const handleReferenceFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const available = Math.max(0, CODEX_PET_MAX_REFERENCES - draft.referenceAssets.length);
    const files = Array.from(input.files ?? []).slice(0, available);
    input.value = "";
    if (files.length === 0 || interactionLocked || !canEdit) return;
    for (const file of files) {
      const fileError = codexPetFileError(file);
      if (fileError) {
        setError(`${file.name}：${fileError}`);
        return;
      }
    }
    clearFeedback();
    setBusyAction("uploading");
    void (async () => {
      try {
        const uploaded: CodexPetReferenceAsset[] = [];
        for (const file of files) {
          const inline = await readFileAsInlineImage(file);
          const asset = await client.uploadReference(token, inline);
          uploaded.push({ ...asset, name: asset.name || file.name });
        }
        setDraft((current) => ({
          ...current,
          referenceAssets: [...current.referenceAssets, ...uploaded]
            .filter((asset, index, all) => all.findIndex((item) => item.id === asset.id) === index)
            .slice(0, CODEX_PET_MAX_REFERENCES),
        }));
        setNotice(`已上传 ${uploaded.length} 张参考图`);
      } catch (uploadError) {
        setError(errorMessage(uploadError, "上传参考图失败"));
      } finally {
        setBusyAction(null);
      }
    })();
  };

  const handleContinueFailedRun = () => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || !canContinueFailedBase || interactionLocked) return;
    clearFeedback();
    setBusyAction("continuing");
    const currentKey = continuationIdempotencyKeyRef.current?.runId === run.id
      ? continuationIdempotencyKeyRef.current.key
      : makeCodexPetIdempotencyKey("continue");
    continuationIdempotencyKeyRef.current = { runId: run.id, key: currentKey };
    void client.continueFailedRun(token, project.id, run.id, currentKey)
      .then((continued) => {
        continuationIdempotencyKeyRef.current = null;
        applyDetail({ project: continued.project, latestRun: continued.run, runs: [continued.run, run], artifacts: detail?.artifacts ?? [], jobs: [] }, false);
        setNotice("候选 1 已保留；候选 2 的 429 重试等待单次额外调用授权");
        onBalanceRefresh?.();
        void refreshSelectedProject(true);
      })
      .catch((continuationError: unknown) => setError(errorMessage(continuationError, "续跑失败的 GPT 桌宠项目失败")))
      .finally(() => setBusyAction(null));
  };

  const handleResumeGateFailure = () => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || !canResumeGateFailure || interactionLocked) return;
    const confirmed = typeof window === "undefined" || window.confirm(
      `将只重做闸门指认的动作组：${resumableGateRowLabels}。`
      + "\n这些动作组的旧画面会作废，重做仍在本次预留额度内，但每次重出图都要单独授权一次付费调用。确认继续？",
    );
    if (!confirmed) return;
    clearFeedback();
    setBusyAction("resuming-gate");
    void client.resumeGateFailure(token, project.id, run.id)
      .then((resumed) => {
        applyDetail({ project: resumed.project, latestRun: resumed.run, runs: [resumed.run], artifacts: detail?.artifacts ?? [], jobs: [] }, false);
        setNotice(`已排队重做：${resumableGateRowLabels}；每次重出图仍需单独授权`);
        onBalanceRefresh?.();
        void refreshSelectedProject(true);
      })
      .catch((resumeError: unknown) => setError(errorMessage(resumeError, "重做闸门指认的动作组失败")))
      .finally(() => setBusyAction(null));
  };

  const handleDeleteProject = (project: CodexPetProjectSummary) => {
    if (interactionLocked) return;
    const projectId = project.id;
    const selectedRunIsActive = detail?.project.id === projectId && latestRun && !runIsTerminal;
    const projectMayBeRunning = Boolean(selectedRunIsActive)
      || (project.status !== "draft"
        && project.status !== "deleting"
        && !TERMINAL_RUN_STATUSES.has(project.status));
    const confirmed = typeof window === "undefined" || window.confirm(
      projectMayBeRunning
        ? "项目仍可能在运行。删除后会停止制作并处理退款；项目数据和产物会保留，但不再显示在历史中。确认删除？"
        : "删除后项目将从历史中隐藏，项目数据和产物仍会保留。确认删除？",
    );
    if (!confirmed) return;
    clearFeedback();
    setBusyAction("deleting");
    setDeletingProjectId(projectId);

    const applyDeletedProject = (remaining: readonly CodexPetProjectSummary[]) => {
      setProjects(remaining);
      if (selectedProjectIdRef.current === projectId) {
        const nextProjectId = remaining[0]?.id ?? null;
        setSelectedProjectId(nextProjectId);
        selectedProjectIdRef.current = nextProjectId;
        detailRevisionRef.current += 1;
        setDetail(null);
        setDraft(EMPTY_CODEX_PET_DRAFT);
        setEvents([]);
        setSelectedBaseArtifactId(null);
        draftProjectIdRef.current = null;
        eventCursorRef.current = 0;
      }
      setNotice("项目已从历史中删除，数据和产物仍保留");
    };

    void client.deleteProject(token, projectId)
      .then(() => {
        const remaining = projects.filter((project) => project.id !== projectId);
        applyDeletedProject(remaining);
      })
      .catch(async (deleteError: unknown) => {
        // The marker is committed atomically, but the response can still be
        // lost in transit. Reconcile the history before reporting failure so
        // a successfully hidden project does not remain as a stale item.
        try {
          const currentProjects = await client.listProjects(token);
          if (!currentProjects.some((item) => item.id === projectId)) {
            applyDeletedProject(currentProjects);
            return;
          }
          setProjects(currentProjects);
        } catch {
          // Preserve the local list and surface the original delete error.
        }
        setError(errorMessage(deleteError, "删除桌宠项目失败"));
      })
      .finally(() => {
        setBusyAction(null);
        setDeletingProjectId(null);
      });
  };

  const handleCancelRun = () => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || !runIsCancellable || interactionLocked) return;
    // Per-image billing does not settle all-or-nothing: cancelling charges the
    // planned calls that already reached the provider and refunds the rest of the
    // reservation. The old "全额退款 / 不退款" wording was wrong in both directions.
    const refundText = `按次计费：已发出的 ${settledPlannedUnits} 次计划内生图会照常结算，`
      + `未发出的部分预计退回 ${projectedRefundPoints ?? 0} 积分。`;
    if (typeof window !== "undefined" && !window.confirm(`${refundText}确认取消本次制作？`)) return;
    clearFeedback();
    setBusyAction("cancelling");
    void client.cancelRun(token, project.id, run.id)
      .then((cancelled) => {
        setDetail((current) => current ? { ...current, latestRun: cancelled } : current);
        setNotice("已提交取消请求，Worker 会在安全检查点停止");
        onBalanceRefresh?.();
        // The cancel response is an acknowledgement, not necessarily the
        // terminal run/project state.  Refresh immediately so project history,
        // billing/refund fields, and the latest-run pointer cannot remain stale
        // after the worker finishes the cancellation handshake.
        void refreshSelectedProject(true);
      })
      .catch((cancelError: unknown) => setError(errorMessage(cancelError, "取消桌宠制作失败")))
      .finally(() => setBusyAction(null));
  };

  const mutateBaseSelection = (selection: CodexPetBaseSelection, action: Exclude<BusyAction, null>, success: string) => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || run.status !== "awaiting_base_review" || interactionLocked) return;
    clearFeedback();
    setBusyAction(action);
    void client.selectBase(token, project.id, run.id, selection)
      .then((nextRun) => {
        setDetail((current) => current ? { ...current, latestRun: nextRun } : current);
        setNotice(success);
        void refreshSelectedProject(true);
      })
      .catch((selectionError: unknown) => setError(errorMessage(selectionError, "处理主形象失败")))
      .finally(() => setBusyAction(null));
  };

  const handleApproveNextImage = () => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || !["awaiting_direction_review", "awaiting_regeneration_approval"].includes(run.status) || interactionLocked) return;
    clearFeedback();
    setBusyAction("approving-image");
    void client.approveNextImage(token, project.id, run.id, makeCodexPetIdempotencyKey("extra"))
      .then((nextRun) => {
        setDetail((current) => current ? { ...current, latestRun: nextRun } : current);
        setNotice(`已批准 ${run.pendingImageJobKey || "当前方向任务"} 的 1 次真实生图调用；失败后会立即停下`);
        void refreshSelectedProject(true);
      })
      .catch((approvalError: unknown) => setError(errorMessage(approvalError, "批准下一次真实生图失败")))
      .finally(() => setBusyAction(null));
  };

  const handleInstall = () => {
    const projectId = detail?.project.id;
    if (!projectId || !deliveryReady || interactionLocked) return;
    clearFeedback();
    setBusyAction("installing");
    void client.createInstallLink(token, projectId)
      .then((result) => {
        if (onInstallUrl) onInstallUrl(result.installUrl);
        else launchInstallUrl(result.installUrl);
        setNotice("已唤起 Codex 安装确认；签名图片链接 30 分钟内有效");
      })
      .catch((installError: unknown) => setError(errorMessage(installError, "安装到 Codex 失败")))
      .finally(() => setBusyAction(null));
  };

  const handleDownload = () => {
    const projectId = detail?.project.id;
    if (!projectId || !deliveryReady || interactionLocked) return;
    clearFeedback();
    setBusyAction("downloading");
    void client.downloadPackage(token, projectId)
      .then((result) => {
        openDownload(result.blob, result.filename);
        setNotice("兼容包已开始下载");
      })
      .catch((downloadError: unknown) => setError(errorMessage(downloadError, "下载兼容包失败")))
      .finally(() => setBusyAction(null));
  };

  const handleOpenKnowledge = () => {
    const documentId = latestRun?.knowledgeDocumentId;
    if (!documentId || !deliveryReady || interactionLocked) return;
    if (onOpenKnowledgeDocument) {
      onOpenKnowledgeDocument(documentId);
      return;
    }
    window.dispatchEvent(new CustomEvent("ai-assistant:open-knowledge-document", {
      detail: { documentId, systemKey: "AI_ARTIFACTS" },
    }));
    setNotice("已请求打开「AI 产物」知识库中的桌宠文档");
  };

  const handleCopyProject = () => {
    const project = detail?.project;
    if (!project || interactionLocked) return;
    const copied = codexPetDraftFromProject(project);
    const suffix = " 副本";
    const copiedName = Array.from(`${copied.name}${suffix}`).slice(0, 30).join("");
    startNewProject();
    setDraft({ ...copied, name: copiedName });
    setNotice("已复制输入信息为新草稿，保存前不会扣费");
  };

  const streamLabel = streamState === "live"
    ? "SSE 实时"
    : streamState === "polling"
      ? "轮询兜底"
      : streamState === "reconnecting"
        ? "正在重连"
        : streamState === "connecting"
          ? "正在连接"
          : streamState === "ended"
            ? "事件已同步"
            : "等待运行";

  return (
    <section className="flex xl:h-full min-h-0 flex-col gap-3" data-testid="codex-pet-studio">
      <div className="flex flex-none flex-wrap items-start justify-between gap-3 rounded-[16px] border border-[#e6e7eb] bg-white px-5 py-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-[12px] bg-brand text-white shadow-sm">
              <Icon icon="mdi:egg-easter" className="text-xl" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-ink">Codex 桌宠工坊</h1>
              <p className="text-xs text-[#71717a]">参考图或文字生成，可直接安装到 Codex</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-brand/30 bg-white px-3 py-1.5 text-brand-ink">
            GPT Image 2 · Pixel · AI 质检{draft.qualityInspectionEnabled ? "已开启" : "关闭"}
          </span>
          <span className="rounded-full bg-[#1d1d1f] px-3 py-1.5 font-semibold text-white">
            {pricing ? `最多 ${plannedCallLimit} 次计划内调用 · ${pricing.rate} 积分/次 · 预留 ${reservedPointsQuote}` : "调用价格加载中"}
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-[12px] border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          <Icon icon="mdi:alert-circle-outline" className="mt-0.5 flex-none text-base" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div aria-live="polite" className="flex items-start gap-2 rounded-[12px] border border-brand/30 bg-brand-soft px-3 py-2.5 text-sm text-brand-ink">
          <Icon icon="mdi:check-circle-outline" className="mt-0.5 flex-none text-base" aria-hidden />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid xl:h-full min-h-0 min-w-0 flex-1 gap-3 xl:grid-cols-[1fr_3fr_1fr]">
        <aside className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
          <Card ariaLabel="桌宠项目历史">
            <CardTitle
              icon="mdi:history"
              title="项目历史"
              aside={(
                <button
                  type="button"
                  disabled={interactionLocked}
                  onClick={startNewProject}
                  className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11px] font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Icon icon="mdi:plus" aria-hidden /> 新建
                </button>
              )}
            />
            <div className="max-h-56 space-y-1 overflow-y-auto p-2" aria-label="桌宠项目列表">
              {bootstrapping && <p className="px-2 py-4 text-center text-xs text-[#6e6e73]">正在加载项目...</p>}
              {!bootstrapping && projects.length === 0 && (
                <p className="px-3 py-5 text-center text-xs leading-5 text-[#6e6e73]">还没有桌宠项目，从文字或参考图开始吧。</p>
              )}
              {projects.map((project) => (
                <div
                  key={project.id}
                  className={`group flex w-full items-center rounded-[10px] border pr-1 transition ${
                    project.id === selectedProjectId
                      ? "border-brand/30 bg-brand-soft"
                      : "border-transparent "
                  }`}
                >
                  <button
                    type="button"
                    disabled={interactionLocked}
                    onClick={() => {
                      if (interactionLocked) return;
                      setSelectedProjectId(project.id);
                      selectedProjectIdRef.current = project.id;
                      detailRevisionRef.current += 1;
                      // Clear the old detail synchronously. The effect below
                      // also sets this state, but doing it here closes the
                      // one-render window in which destructive actions could
                      // still target the previously selected project.
                      setDetail(null);
                      setDraft(EMPTY_CODEX_PET_DRAFT);
                      setLoadingDetail(true);
                      setEvents([]);
                      eventCursorRef.current = 0;
                      clearFeedback();
                    }}
                    className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{project.name}</span>
                      <StatusPill status={project.status} />
                    </div>
                    <p className="mt-1 truncate text-[10px] text-[#6e6e73]">{shortDate(project.updatedAt)} · {CODEX_PET_STYLE_OPTIONS.find((item) => item.value === project.stylePreset)?.label}</p>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除项目 ${project.name}`}
                    title="从历史中删除"
                    disabled={interactionLocked}
                    onClick={() => handleDeleteProject(project)}
                    className="grid size-8 shrink-0 place-items-center rounded-[8px] text-[#86868b] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Icon
                      icon={deletingProjectId === project.id ? "mdi:loading" : "mdi:trash-can-outline"}
                      className={deletingProjectId === project.id ? "animate-spin text-base" : "text-base"}
                      aria-hidden
                    />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <Card ariaLabel="桌宠输入信息">
            <CardTitle
              icon="mdi:creation-outline"
              title="输入信息"
              aside={detail && <StatusPill status={detail.project.status} />}
            />
            <div className="space-y-3 p-4">
              {loadingDetail && <p className="text-xs text-[#8b8b94]">正在恢复项目输入...</p>}
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">桌宠名称 <span className="text-red-500">*</span></span>
                <input
                  value={draft.name}
                  disabled={!canEdit || interactionLocked}
                  maxLength={30}
                  onChange={(event) => updateDraft("name", event.target.value)}
                  placeholder="例如：码仔"
                  className="w-full rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                />
                <span className="mt-1 block text-right text-[10px] text-[#9a9aa2]">{Array.from(draft.name).length}/30</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">一句话描述</span>
                <input
                  value={draft.description}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => updateDraft("description", event.target.value)}
                  placeholder="它是谁、有什么性格"
                  className="w-full rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">角色提示词</span>
                <textarea
                  value={draft.prompt}
                  disabled={!canEdit || interactionLocked}
                  maxLength={4_000}
                  onChange={(event) => updateDraft("prompt", event.target.value)}
                  placeholder="描述角色外形、配色、材质、标志性配件和气质；也可以只上传参考图。"
                  rows={5}
                  className="w-full resize-y rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm leading-5 outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                />
                <span className="mt-1 block text-right text-[10px] text-[#9a9aa2]">{Array.from(draft.prompt).length}/4000</span>
              </label>

              <div className="grid gap-2 sm:grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)]">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">定制动作</span>
                  <select
                    aria-label="定制动作"
                    value={selectedActionPrompt}
                    disabled={!canEdit || interactionLocked}
                    onChange={(event) => setSelectedActionPrompt(event.currentTarget.value as CodexPetActionPromptKey)}
                    className="w-full rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                  >
                    {CODEX_PET_ACTION_PROMPT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">动作提示词</span>
                  <textarea
                    value={draft.actionPrompts[selectedActionPrompt] ?? ""}
                    disabled={!canEdit || interactionLocked}
                    maxLength={CODEX_PET_ACTION_PROMPT_MAX_LENGTH}
                    onChange={(event) => updateActionPrompt(event.currentTarget.value)}
                    placeholder="可选：描述这个动作的表情、幅度、节奏或已有肢体和配件如何运动。"
                    rows={3}
                    className="w-full resize-y rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm leading-5 outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                  />
                  <span className="mt-1 block text-right text-[10px] text-[#9a9aa2]">{Array.from(draft.actionPrompts[selectedActionPrompt] ?? "").length}/{CODEX_PET_ACTION_PROMPT_MAX_LENGTH}</span>
                </label>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#4b4b52]">参考图</span>
                  <span className="text-[10px] text-[#9a9aa2]">{draft.referenceAssets.length}/3 · 每张 10MB</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {draft.referenceAssets.map((asset) => {
                    const url = asset.thumbnailUrl || asset.originalUrl;
                    return (
                      <div key={asset.id} className="group relative aspect-square overflow-hidden rounded-[9px] border border-[#e1e3e8] bg-[#f6f6f8]">
                        {url ? <img src={url} alt={asset.name || "桌宠参考图"} className="size-full object-cover" /> : (
                          <span className="grid size-full place-items-center text-[10px] text-[#9a9aa2]">已上传</span>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={`移除参考图 ${asset.name ?? asset.id}`}
                            disabled={interactionLocked}
                            onClick={() => updateDraft("referenceAssets", draft.referenceAssets.filter((item) => item.id !== asset.id))}
                            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/65 text-white opacity-90 transition "
                          >
                            <Icon icon="mdi:close" aria-hidden />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {draft.referenceAssets.length < CODEX_PET_MAX_REFERENCES && (
                    <label className={`grid aspect-square cursor-pointer place-items-center rounded-[9px] border border-dashed border-[#cfd3da] bg-[#fafafd] text-center text-[10px] text-[#7d7d86] transition ${!canEdit || interactionLocked ? "pointer-events-none opacity-50" : ""}`}>
                      <span><Icon icon={busyAction === "uploading" ? "mdi:loading" : "mdi:image-plus-outline"} className={`mx-auto mb-1 text-lg ${busyAction === "uploading" ? "animate-spin" : ""}`} aria-hidden />上传参考图</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif"
                        multiple
                        disabled={!canEdit || interactionLocked}
                        onChange={handleReferenceFiles}
                        className="sr-only"
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">生图模型</span>
                  <div className="rounded-[10px] border border-[#dfe1e6] bg-[#f7f7f9] px-3 py-2 text-sm text-[#424249]">
                    {readOnlyArchive
                      ? "历史项目，已归档为只读"
                      : historicalImageModel ? `历史模型 ${historicalImageModel}，已停止新运行` : "GPT Image 2 · Pixel"}
                  </div>
                </div>
                <label className="flex min-h-10 items-center justify-between gap-3 rounded-[10px] border border-[#dfe1e6] px-3 py-2 text-sm text-[#424249]">
                  <span>AI 质检</span>
                  <input
                    aria-label="AI 质检"
                    type="checkbox"
                    checked={draft.qualityInspectionEnabled}
                    disabled={!canEdit || interactionLocked}
                    onChange={(event) => updateDraft("qualityInspectionEnabled", event.currentTarget.checked)}
                    className="size-4 accent-brand"
                  />
                </label>
                {draft.qualityInspectionEnabled && (
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">视觉理解 / 质检模型</span>
                    <select
                      aria-label="视觉理解 / 质检模型"
                      value={draft.visualQaModel}
                      disabled={!canEdit || interactionLocked}
                      onChange={(event) => updateDraft("visualQaModel", event.currentTarget.value)}
                      className="w-full rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                    >
                      {modelOptions.visualModels.map((option) => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                    </select>
                  </label>
                )}
              </div>

              <fieldset disabled={!canEdit || interactionLocked}>
                <legend className="mb-1.5 text-[11px] font-semibold text-[#4b4b52]">风格预设</legend>
                <div className="grid grid-cols-2 gap-1.5">
                  {CODEX_PET_STYLE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      title={option.description}
                      aria-pressed={draft.stylePreset === option.value}
                      onClick={() => updateDraft("stylePreset", option.value)}
                      className={`rounded-[9px] border px-2 py-1.5 text-left text-[11px] transition ${
                        draft.stylePreset === option.value
                          ? "border-brand/40 bg-brand-soft font-semibold text-brand-ink"
                          : "border-[#e2e3e8] bg-white text-[#66666e] "
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-[#4b4b52]">风格补充</span>
                <input
                  value={draft.styleNotes}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => updateDraft("styleNotes", event.target.value)}
                  placeholder="可选，例如：圆润、低饱和、不要文字"
                  className="w-full rounded-[10px] border border-[#dfe1e6] bg-white px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-[#f7f7f9]"
                />
              </label>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-[#e5e7eb] bg-[#fafafa] p-3">
                <input
                  type="checkbox"
                  checked={draft.autoContinue}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => updateDraft("autoContinue", event.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--accent-primary)]"
                />
                <span>
                  <span className="block text-xs font-semibold text-ink">主形象生成后自动继续</span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-[#85858d]">关闭时会停下来让你从 2 个候选中选择；开启后由视觉质检自动选优。</span>
                </span>
              </label>

              <div className="rounded-[10px] bg-[#f7f8fa] px-3 py-2.5 text-[10px] leading-4 text-[#6f7078]">
                正常路径最多 {plannedCallLimit} 次计划内 GPT Image 2 调用；AI 质检默认关闭，任何额外调用都需要单独批准与计费。上传即表示你拥有参考图与角色的使用权。
              </div>

              <div className="grid grid-cols-2 gap-2">
                <PrimaryButton
                  kind="secondary"
                  icon={busyAction === "saving" ? "mdi:loading" : "mdi:content-save-outline"}
                  disabled={!canEdit || interactionLocked}
                  onClick={handleSaveDraft}
                >
                  {selectedProjectId ? "保存草稿" : "创建草稿"}
                </PrimaryButton>
                <PrimaryButton
                  icon={busyAction === "starting" ? "mdi:loading" : "mdi:creation"}
                  disabled={interactionLocked || !canStart || pricing?.enabled !== true}
                  onClick={handleStart}
                >
                  开始制作{reservedPointsQuote === null ? "" : ` · 预留 ${reservedPointsQuote}`}
                </PrimaryButton>
              </div>

              {detail && (
                <div className="flex gap-2 border-t border-[#eceef1] pt-3">
                  {runIsCancellable && (
                    <PrimaryButton kind="secondary" icon="mdi:stop-circle-outline" disabled={interactionLocked} onClick={handleCancelRun}>
                      取消运行
                    </PrimaryButton>
                  )}
                  <PrimaryButton
                    kind="danger"
                    icon={deletingProjectId === detail.project.id ? "mdi:loading" : "mdi:trash-can-outline"}
                    disabled={interactionLocked}
                    onClick={() => handleDeleteProject(summaryFromProject(detail.project))}
                  >
                    从历史中删除
                  </PrimaryButton>
                </div>
              )}
            </div>
          </Card>
        </aside>

        <main className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
          <Card ariaLabel="桌宠视觉工作台">
            <CardTitle
              icon="mdi:monitor-dashboard"
              title="视觉工作台"
              aside={latestRun && <span className="text-[11px] font-semibold text-brand-ink">{progress}%</span>}
            />
            <div className="space-y-4 p-4">
              {!latestRun && (
                <ImagePlaceholder text="保存草稿后点击“开始制作”。这里会依次显示 2 个主形象候选、9 组标准动画和最终 v2 精灵图。" />
              )}

              {latestRun && baseCandidates.length > 0 && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-ink">主形象候选</h3>
                      <p className="mt-0.5 text-[10px] text-[#898991]">选中的形象会成为所有动作与方向的身份基准。</p>
                    </div>
                    {latestRun.status === "awaiting_base_review" && (
                      <div className="flex flex-wrap gap-1.5">
                        <PrimaryButton
                          kind="secondary"
                          icon="mdi:robot-happy-outline"
                          disabled={interactionLocked}
                          onClick={() => mutateBaseSelection({ autoSelect: true }, "selecting-base", "视觉质检已选出更稳定的主形象，继续制作")}
                        >
                          QA 自动选优
                        </PrimaryButton>
                        <PrimaryButton
                          kind="secondary"
                          icon="mdi:refresh"
                          disabled={interactionLocked}
                          onClick={() => mutateBaseSelection({ regenerate: true }, "regenerating-base", "已提交主形象重生，将生成两个新候选")}
                        >
                          重生候选
                        </PrimaryButton>
                      </div>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {baseCandidates.map((candidate, index) => {
                      const url = codexPetArtifactUrl(candidate);
                      const selected = candidate.id === selectedBaseArtifactId;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={latestRun.status !== "awaiting_base_review" || interactionLocked}
                          aria-pressed={selected}
                          onClick={() => setSelectedBaseArtifactId(candidate.id)}
                          className={`overflow-hidden rounded-[13px] border-2 text-left transition ${selected ? "border-brand bg-brand-soft" : "border-[#e2e4e9] bg-white "}`}
                        >
                          <div className="aspect-[3/2] bg-[#f5f5f7]">
                            {url ? <img src={url} alt={`主形象候选 ${index + 1}`} className="size-full object-contain" /> : (
                              <span className="grid size-full place-items-center text-xs text-[#92929a]">候选 {index + 1} 已生成</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <span className="text-xs font-semibold text-ink">候选 {index + 1}</span>
                            {selected && <span className="ml-auto text-[10px] font-semibold text-brand-ink">已选择</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {latestRun.status === "awaiting_base_review" && (
                    <div className="mt-3 flex justify-end">
                      <PrimaryButton
                        icon="mdi:arrow-right"
                        disabled={!selectedBaseArtifactId || interactionLocked}
                        onClick={() => selectedBaseArtifactId && mutateBaseSelection(
                          { artifactId: selectedBaseArtifactId },
                          "selecting-base",
                          "主形象已确认，开始制作标准动作",
                        )}
                      >
                        使用所选形象并继续
                      </PrimaryButton>
                    </div>
                  )}
                </div>
              )}

              {latestRun && baseCandidates.length === 0 && latestRun.status === "base_generating" && (
                <ImagePlaceholder text="正在并行生成 2 个主形象候选；完成后会实时出现在这里。" />
              )}

              {latestRun && ["awaiting_direction_review", "awaiting_regeneration_approval"].includes(latestRun.status) && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-amber-900">{latestRun.status === "awaiting_regeneration_approval" ? "额外真实生图等待批准" : "下一张真实生图已暂停"}</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-amber-800">待生成：{latestRun.pendingImageJobKey || "方向任务"}。每次批准只允许 1 次调用，额外调用单独计费，失败后不会自动重画。</p>
                    {/* Show the cap before the click. Users used to learn it only
                        from a refusal, which is the moment it helps least. */}
                    {extraCallBudget && (
                      <p className="mt-0.5 text-[10px] font-semibold leading-4 text-amber-900" data-testid="codex-pet-extra-call-budget">
                        {extraCallBudgetExhausted
                          ? `付费重画次数已用尽（本动作 ${extraCallBudget.jobUsed}/${extraCallBudget.jobLimit} · 本次运行 ${extraCallBudget.runUsed}/${extraCallBudget.runLimit}），请先取消本次运行，再复制为新项目重跑。`
                          : `付费重画次数：本动作 ${extraCallBudget.jobUsed}/${extraCallBudget.jobLimit} · 本次运行 ${extraCallBudget.runUsed}/${extraCallBudget.runLimit}`}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {!extraCallBudgetExhausted && (
                      <PrimaryButton icon={busyAction === "approving-image" ? "mdi:loading" : "mdi:check-circle-outline"} disabled={interactionLocked} onClick={handleApproveNextImage}>
                        批准 1 次生图
                      </PrimaryButton>
                    )}
                    {/* The parked state is not terminal, so neither 失败续跑 nor the
                        terminal-only copy button below is reachable from here. Offer
                        the two steps that actually work: cancel, then copy. */}
                    {latestRun.status === "awaiting_regeneration_approval" && (
                      <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={handleCopyProject}>
                        复制为新项目
                      </PrimaryButton>
                    )}
                  </div>
                </div>
              )}

              {/* Rendered from `latestRun` rather than the delivery panel so the
                  nine labelled cells fill in progressively during the run.  A
                  single newest-first `animation_preview` slot used to live here,
                  but `animation_preview` also covers the two look-* direction
                  rows produced after the standard rows, so it showed an
                  unlabelled direction animation on 294 of 324 recorded runs. */}
              {latestRun && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-ink">9 组标准动画</h3>
                      <p className="mt-0.5 text-[10px] text-[#898991]">透明背景 · 192×208 单格 · 生成过程中逐个亮起</p>
                    </div>
                    <span className="text-[10px] font-semibold text-[#8b8b94]" data-testid="codex-pet-animation-progress">
                      已完成 {readyStandardAnimationCount}/{CODEX_PET_STANDARD_STATES.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="codex-pet-standard-animations">
                    {standardAnimationPreviews.map(({ state, artifact }) => {
                      const url = artifact ? codexPetArtifactUrl(artifact) : "";
                      return (
                        <figure
                          key={state.id}
                          data-testid={`codex-pet-animation-${state.id}`}
                          className="overflow-hidden rounded-[10px] border border-[#e7e8ec] bg-white"
                        >
                          <div className="aspect-[3/2] bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:12px_12px]">
                            {url ? (
                              <img src={url} alt={`${state.label}动画预览`} className="size-full object-contain" />
                            ) : (
                              <span className="grid size-full place-items-center px-2 text-center text-[10px] text-[#9a9aa2]">{state.label}预览处理中</span>
                            )}
                          </div>
                          <figcaption className="px-2 py-1.5 text-[10px] font-semibold text-[#55555d]">{state.label}</figcaption>
                        </figure>
                      );
                    })}
                  </div>
                </div>
              )}

              {latestRun && spritesheetArtifact && (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-ink">最终 Codex v2 精灵图</h3>
                      <p className="mt-0.5 text-[10px] text-[#898991]">1536×2288 · 8 列 × 11 行 · 透明背景 · spriteVersionNumber 2</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowActualSize((current) => !current)}
                      className="rounded-[8px] border border-[#dfe1e6] px-2 py-1 text-[10px] font-semibold text-[#55555d] "
                    >
                      {showActualSize ? "适应窗口" : "1:1 实际尺寸"}
                    </button>
                  </div>
                  <div className={`overflow-auto rounded-[12px] border border-[#dfe1e6] bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px] ${showActualSize ? "max-h-[560px]" : "p-3"}`}>
                    {codexPetArtifactUrl(spritesheetArtifact) ? (
                      <img
                        src={codexPetArtifactUrl(spritesheetArtifact)}
                        alt="最终 Codex v2 桌宠精灵图"
                        width={showActualSize ? (spritesheetArtifact.width ?? 1536) : undefined}
                        height={showActualSize ? (spritesheetArtifact.height ?? 2288) : undefined}
                        className={showActualSize ? "max-w-none" : "mx-auto max-h-[520px] w-auto max-w-full object-contain"}
                      />
                    ) : <ImagePlaceholder text="最终精灵图已生成，正在刷新签名预览地址" />}
                  </div>
                </div>
              )}

              {latestRun && deliveryReady && (
                <div className="space-y-3 rounded-[14px] border border-brand/30 bg-brand-soft/50 p-4">
                  <div className="flex items-start gap-2">
                    <Icon icon="mdi:check-decagram" className="mt-0.5 text-xl text-brand-ink" aria-hidden />
                    <div>
                      <h3 className="text-sm font-semibold text-brand-ink">桌宠已生成，可安装</h3>
                      <p className="mt-0.5 text-[11px] text-brand-ink">
                        最终精灵图与 ZIP 兼容包已就绪。{latestRun.knowledgeDocumentId ? "AI 产物已完成归档。" : "AI 产物正在后台归档，不影响安装和下载。"}
                      </p>
                    </div>
                  </div>
                  {finalContactSheet && (
                    <div className="rounded-[10px] border border-brand/30 bg-white p-2.5" data-testid="codex-pet-final-contact-sheet">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <h4 className="text-[11px] font-semibold text-[#52525a]">最终 Contact Sheet</h4>
                        <span className="text-[9px] text-[#8b8b94]">完整 v2 预览 · 非单组动画</span>
                      </div>
                      {codexPetArtifactUrl(finalContactSheet) ? (
                        <img
                          src={codexPetArtifactUrl(finalContactSheet)}
                          alt="最终 Codex v2 Contact Sheet"
                          className="max-h-72 w-full rounded-[8px] border border-[#e7e8ec] bg-[#f7f8fa] object-contain"
                        />
                      ) : (
                        <ImagePlaceholder text="最终 Contact Sheet 已生成，正在刷新预览地址" />
                      )}
                    </div>
                  )}
                  <div>
                    <h4 className="mb-1.5 text-[11px] font-semibold text-[#52525a]">16 个观察方向（顺时针）</h4>
                    <div className="grid grid-cols-8 gap-1">
                      {CODEX_PET_LOOK_DIRECTIONS.map((direction) => <span key={direction} className="rounded-[6px] bg-white px-1 py-1 text-center text-[9px] text-[#6f7078] shadow-sm">{direction}°</span>)}
                    </div>
                  </div>
                  <div className="rounded-[10px] bg-white px-3 py-2 text-[11px] text-[#5f6068]">
                    质量报告：{validationSummary(latestRun.validationReport)}
                  </div>
                  <details className="rounded-[10px] border border-brand/30 bg-white px-3 py-2 text-[10px] text-[#64646c]">
                    <summary className="cursor-pointer font-semibold text-[#4f5057]">查看完整质量报告</summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[#f7f8fa] p-2 font-mono text-[9px] leading-4">
                      {JSON.stringify(latestRun.validationReport, null, 2)}
                    </pre>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton icon="mdi:download-circle-outline" disabled={interactionLocked} onClick={handleInstall}>安装到 Codex</PrimaryButton>
                    <PrimaryButton kind="secondary" icon="mdi:folder-zip-outline" disabled={interactionLocked} onClick={handleDownload}>下载兼容包</PrimaryButton>
                    {latestRun.knowledgeDocumentId && (
                      <PrimaryButton kind="secondary" icon="mdi:database-eye-outline" disabled={interactionLocked} onClick={handleOpenKnowledge}>在 AI 产物中查看</PrimaryButton>
                    )}
                    <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={handleCopyProject}>复制为新项目</PrimaryButton>
                  </div>
                </div>
              )}

              {latestRun && runIsTerminal && !deliveryReady && (
                <div className="flex items-center justify-between gap-3 rounded-[12px] border border-[#e2e4e9] bg-[#f8f9fb] px-3 py-2.5">
                  <p className="text-[10px] leading-4 text-[#6f7078]">
                    {canContinueFailedBase
                      ? "候选 1 已成功保存；可在本项目中只重试因 429 失败的候选 2。"
                      : canResumeGateFailure
                        ? `质检闸门指认这几组动作需要重做：${resumableGateRowLabels}。已通过的其他动作会原样保留。`
                        : "本次运行已结束；保留原项目记录，复制输入后可用新的幂等键重新制作。"}
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    {canContinueFailedBase && (
                      <PrimaryButton icon={busyAction === "continuing" ? "mdi:loading" : "mdi:restart"} disabled={interactionLocked} onClick={handleContinueFailedRun}>
                        复用候选 1，重试候选 2
                      </PrimaryButton>
                    )}
                    {canResumeGateFailure && (
                      <PrimaryButton icon={busyAction === "resuming-gate" ? "mdi:loading" : "mdi:auto-fix"} disabled={interactionLocked} onClick={handleResumeGateFailure}>
                        只重做这 {resumableGateRows.length} 组动作
                      </PrimaryButton>
                    )}
                    <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={handleCopyProject}>复制为新项目</PrimaryButton>
                  </div>
                </div>
              )}

              {latestRun && (
                <details
                  className="rounded-[12px] border border-[#e2e4e9] bg-[#f8f9fb] px-3 py-2"
                  data-testid="codex-pet-process-artifacts"
                >
                  <summary className="cursor-pointer text-[10px] font-semibold text-[#6f7078]">
                    过程产物（内部诊断 · {processArtifacts.length} 项）
                  </summary>
                  <p className="mt-1.5 text-[9px] leading-4 text-[#8d8d95]">
                    姿势板、方向盲测图等中间产物仅保留 7 天，用于排查与定向续跑，不是交付内容。过期后此处为空属正常。
                  </p>
                  {processArtifacts.length === 0 ? (
                    <p className="mt-2 text-[10px] text-[#97979f]">本次运行没有仍在保留期内的过程产物。</p>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {processArtifacts.map((artifact) => {
                        const url = codexPetArtifactUrl(artifact);
                        return (
                          <figure
                            key={artifact.id}
                            data-testid={`codex-pet-process-artifact-${artifact.kind}`}
                            className="overflow-hidden rounded-[10px] border border-[#e7e8ec] bg-white"
                          >
                            {url ? (
                              <img src={url} alt={codexPetProcessArtifactLabel(artifact)} className="max-h-40 w-full bg-[#f4f4f6] object-contain" />
                            ) : (
                              <span className="grid h-20 w-full place-items-center bg-[#f4f4f6] px-2 text-center text-[9px] text-[#9a9aa2]">无可预览图像</span>
                            )}
                            <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-[9px] text-[#6f7078]">
                              <span className="min-w-0 truncate font-semibold text-[#55555d]">{codexPetProcessArtifactLabel(artifact)}</span>
                              <span className="flex-none">{artifact.width ?? "?"}×{artifact.height ?? "?"}</span>
                            </figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  )}
                </details>
              )}
            </div>
          </Card>
        </main>

        <aside className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
          <Card ariaLabel="桌宠运行进度">
            <CardTitle
              icon="mdi:progress-clock"
              title="阶段进度"
              aside={<span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${streamState === "live" ? "text-brand-ink" : "text-[#85858d]"}`}><span className={`size-1.5 rounded-full ${streamState === "live" ? "animate-pulse bg-brand" : "bg-[#a8a8af]"}`} />{streamLabel}</span>}
            />
            <div className="space-y-3 p-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">{latestRun ? codexPetStatusLabel(latestRun.status) : "等待开始"}</span>
                  <span className="font-semibold text-brand-ink">{progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#eceef1]">
                  <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${progress}%` }} />
                </div>
                <p className="mt-1.5 text-[10px] leading-4 text-[#7f7f87]">{latestRun?.progressMessage || lastEvent?.message || "提交后会显示当前子任务"}</p>
              </div>
              <ol className="space-y-2">
                {CODEX_PET_PROGRESS_STEPS.map((step) => {
                  const complete = progress >= step.end;
                  const active = progress >= step.start && progress < step.end;
                  return (
                    <li key={step.id} className="flex items-center gap-2">
                      <span className={`grid size-5 flex-none place-items-center rounded-full text-[10px] font-bold ${complete ? "bg-brand text-white" : active ? "border-2 border-brand bg-white text-brand-ink" : "bg-[#eceef1] text-[#9898a0]"}`}>
                        {complete ? <Icon icon="mdi:check" aria-hidden /> : CODEX_PET_PROGRESS_STEPS.findIndex((item) => item.id === step.id) + 1}
                      </span>
                      <span className={`min-w-0 flex-1 text-[11px] ${active ? "font-semibold text-ink" : "text-[#74747c]"}`}>{step.label}</span>
                      <span className="text-[9px] text-[#a0a0a7]">{step.range}</span>
                    </li>
                  );
                })}
              </ol>
              {latestRun && (
                <div className="grid grid-cols-3 gap-2 border-t border-[#eceef1] pt-3 text-[10px]">
                  <div className="rounded-[9px] bg-[#f7f8fa] p-2">
                    <span className="block text-[#919198]">当前子任务</span>
                    <span data-testid="codex-pet-current-subtask" className="mt-0.5 block truncate font-semibold text-[#52525a]">{currentSubtask}</span>
                  </div>
                  <div className="rounded-[9px] bg-[#f7f8fa] p-2">
                    <span className="block text-[#919198]">成功图片</span>
                    <span className="mt-0.5 block font-semibold text-[#52525a]">{latestRun.hasSuccessfulImage ? "已有" : "暂无"}</span>
                  </div>
                  <div className="rounded-[9px] bg-[#f7f8fa] p-2">
                    <span className="block text-[#919198]">真实生图调用</span>
                    <span data-testid="codex-pet-image-call-count" className="mt-0.5 block font-semibold text-[#52525a]">{latestRun.imageGenerationCallCount ?? 0}/{latestRun.plannedImageCallLimit ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT}</span>
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card ariaLabel="运行任务与重试">
            <CardTitle icon="mdi:graph-outline" title="视觉任务" aside={<span className="text-[10px] text-[#8d8d95]">并行上限 3</span>} />
            <div className="max-h-44 space-y-1.5 overflow-y-auto p-3">
              {(detail?.jobs.length ?? 0) === 0 && <p className="py-3 text-center text-[10px] text-[#97979f]">运行后显示动作组与重试次数</p>}
              {detail?.jobs.slice().reverse().slice(0, 12).map((job) => (
                <div key={job.id} className="rounded-[9px] border border-[#eceef1] px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-[#505057]">{job.key}</span>
                    <span className="text-[9px] text-[#85858d]">{job.attempt}/{job.maxAttempts}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[9px] text-[#96969d]">
                    <span className={`size-1.5 rounded-full ${job.status === "completed" ? "bg-brand" : job.status === "failed" ? "bg-red-500" : "bg-brand"}`} />
                    {job.status}{job.error ? ` · ${job.error}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card ariaLabel="计费与知识库归档">
            <CardTitle icon="mdi:database-check-outline" title="计费与归档" />
            <div className="space-y-2.5 p-4 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-[#777780]">已预留积分</span>
                <span className="font-semibold text-ink">
                  {/* Never restate the planned-call count locally: it is a backend
                      constant served with the price, and a stale copy here would
                      quote a reservation the user is not actually charged. */}
                  {latestRun ? `${latestRun.billingReservedPoints ?? 0} 积分` : pricing ? `${pricing.rate * (pricing.plannedImageCallLimit ?? 0)} 积分` : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777780]">已结算积分</span>
                <span className="font-semibold text-ink">{latestRun ? `${latestRun.billingSettledPoints ?? 0} 积分` : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777780]">预计退回</span>
                {/* Settlement happens once, at the end. Before that `settled` is 0,
                    so `reserved - settled` reads as a full refund even though every
                    dispatched planned call will be charged. Project from the ledger
                    instead, on the same unit rule the backend settles by. */}
                <span className="font-semibold text-ink">{latestRun ? `${projectedRefundPoints ?? 0} 积分${latestRun.billingSettlementStatus === "settled" ? "" : "（预估）"}` : "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777780]">知识库</span>
                <span className={`font-semibold ${latestRun?.knowledgeDocumentId ? "text-brand-ink" : latestRun?.status === "archiving" ? "text-brand-ink" : "text-[#8d8d95]"}`}>
                  {latestRun?.knowledgeDocumentId ? "AI 产物 · 已归档" : latestRun?.status === "archiving" ? "正在归档" : "等待最终产物"}
                </span>
              </div>
              {packageArtifact && (
                <div className="flex items-center justify-between">
                  <span className="text-[#777780]">兼容包大小</span>
                  <span className="font-semibold text-ink">{formatBytes(packageArtifact.sizeBytes)}</span>
                </div>
              )}
              {latestRun?.usage?.totalTokens !== undefined && (
                <div className="flex items-center justify-between">
                  <span className="text-[#777780]">模型 token</span>
                  <span className="font-semibold text-ink">{latestRun.usage.totalTokens.toLocaleString()}</span>
                </div>
              )}
              {latestRun && (
                <div className="rounded-[9px] bg-[#f7f8fa] px-2.5 py-2 text-[10px] leading-4 text-[#72727a]">
                  生图请求 {latestRun.requestedModel}<br />
                  生图实际 {latestRun.actualModels?.length > 0 ? latestRun.actualModels.join("、") : "等待上游返回"}<br />
                  AI 质检 {latestRun.qualityInspectionEnabled ? "已开启" : "关闭"}<br />
                  视觉实际 {latestRun.qualityInspectionEnabled ? (latestRun.visualQaActualModels?.length > 0 ? latestRun.visualQaActualModels.join("、") : "等待最终模型来源汇总") : "无调用"}<br />
                  模型合同 {modelContractState === "valid"
                    ? "所选模型来源 · 已验证"
                    : modelContractState === "invalid"
                      ? "来源不一致 · 已阻止交付"
                      : "等待实际模型来源"}
                  {modelContractState === "invalid" && (
                    <span role="alert" className="mt-1 block font-semibold text-red-700">
                      接口返回的模型或路由与项目启动时冻结的选择不一致。
                    </span>
                  )}
                </div>
              )}
              {detail?.imageCalls && detail.imageCalls.length > 0 && (
                <div className="max-h-28 space-y-1 overflow-y-auto rounded-[9px] border border-[#eceef1] p-2 text-[10px] text-[#62626a]" aria-label="生图调用账本">
                  {detail.imageCalls.map((call) => (
                    <div key={call.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">{call.jobKey} · {call.callKind}</span>
                      <span className="shrink-0">{call.status}{call.actualModel ? ` · ${call.actualModel}` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card ariaLabel="实时事件">
            <CardTitle icon="mdi:message-flash-outline" title="实时事件" aside={<span className="text-[10px] text-[#8d8d95]">游标 {eventCursorRef.current}</span>} />
            <ol className="max-h-72 space-y-0 overflow-y-auto p-3" aria-label="桌宠实时事件列表">
              {events.length === 0 && <li className="py-5 text-center text-[10px] text-[#97979f]">事件会先持久化，再通过 SSE 实时推送</li>}
              {events.slice().reverse().map((event) => (
                <li key={event.sequence} className="relative border-l border-[#dde1e6] pb-3 pl-3 last:pb-0">
                  <span className="absolute -left-[3px] top-1 size-[5px] rounded-full bg-brand" />
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-[10px] font-semibold leading-4 text-[#52525a]">{eventTitle(event)}</span>
                    <span className="flex-none text-[8px] text-[#a0a0a7]">#{event.sequence}</span>
                  </div>
                  <p className="mt-0.5 text-[9px] text-[#92929a]">{event.stage ? codexPetStatusLabel(event.stage) : event.type} · {shortDate(event.createdAt)}</p>
                </li>
              ))}
            </ol>
          </Card>

          {latestRun?.error && (
            <div className="rounded-[12px] border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">
              <strong className="block">运行诊断</strong>
              {latestRun.error}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
