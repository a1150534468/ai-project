/**
 * 桌宠工坊的状态与动作层。`CodexPetStudio.tsx` 1991 行里的 state / effect / handler 全在这里,
 * 三个面板只读这个 controller,不再各自持有状态。
 *
 * **每个动作开头那句 `if (... || interactionLocked) return;` 都不是装饰。** 桌宠一轮跑十几分钟且
 * 按次计费,重复提交的代价是真扣积分:
 *  - `runIdempotencyKeyRef` / `continuationIdempotencyKeyRef` 让"启动"和"续跑"在失败重试时复用同一把
 *    幂等键,成功后才置空——所以连点两次不会开出两轮运行。
 *  - `detailRevisionRef` + `selectedProjectIdRef` 是一对乱序护栏:任何异步回写落地前都要对一次
 *    "我拉的还是当前选中的项目吗、这期间 detail 有没有被别人换过",否则快速切项目会把 A 的详情
 *    盖到 B 上,更糟的是让「保存草稿」用 A 的输入去 PATCH B。
 *  - `terminalBalanceRefreshRef` 保证同一个 run 的同一个终态只刷一次余额。
 *
 * `persistDraft` 与 `handleStart` 的校验强度**故意不同**:存草稿不要求视觉输入(允许先存名字风格,
 * 回头再补图),开始制作才走完整校验。这不是漏检,是两个动作的语义差别。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import * as codexPetApi from "../../codexPetApi";
import {
  CODEX_PET_IMAGE_MODEL,
  CODEX_PET_VISUAL_QA_MODEL,
} from "../../codexPetApi";
import type {
  CodexPetActionPromptKey,
  CodexPetBaseSelection,
  CodexPetModelOptions,
  CodexPetPricing,
  CodexPetProject,
  CodexPetProjectDetail,
  CodexPetProjectSummary,
  CodexPetReferenceAsset,
} from "../../codexPetApi";
import { readFileAsInlineImage } from "./ecomWorkflowStudioModel";
import {
  CODEX_PET_MAX_REFERENCES,
  EMPTY_CODEX_PET_DRAFT,
  canEditCodexPetProject,
  codexPetCurrentSubtask,
  codexPetDisplayProgress,
  codexPetDraftFromProject,
  codexPetFileError,
  codexPetModelContractState,
  codexPetPayloadFromDraft,
  isCodexPetDeliveryReady,
  makeCodexPetIdempotencyKey,
  validateCodexPetDraft,
  type CodexPetDraft,
} from "./codexPetStudioModel";
import {
  DEFAULT_CODEX_PET_STUDIO_CLIENT,
  type CodexPetStudioClient,
} from "./codexPetStudioClient";
import {
  codexPetErrorMessage,
  isAbortError,
  launchInstallUrl,
  openDownload,
  TERMINAL_RUN_STATUSES,
  type CodexPetBusyAction,
} from "./codexPetStudioFormat";
import {
  deriveCodexPetArtifacts,
  deriveCodexPetBilling,
  deriveCodexPetRunGates,
  upsertProjectSummary,
} from "./codexPetStudioDerived";
import { useCodexPetRunStream } from "./useCodexPetRunStream";

export interface CodexPetStudioProps {
  readonly token: string;
  readonly initialProjectId?: string | null;
  readonly onBalanceRefresh?: () => void;
  readonly onOpenKnowledgeDocument?: (documentId: string) => void;
  readonly onInstallUrl?: (url: string) => void;
  readonly client?: CodexPetStudioClient;
}

const STREAM_LABELS: Record<string, string> = {
  live: "SSE 实时",
  polling: "轮询兜底",
  reconnecting: "正在重连",
  connecting: "正在连接",
  ended: "事件已同步",
};

export function useCodexPetStudio({
  token,
  initialProjectId,
  onBalanceRefresh,
  onOpenKnowledgeDocument,
  onInstallUrl,
  client = DEFAULT_CODEX_PET_STUDIO_CLIENT,
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
  const [selectedBaseArtifactId, setSelectedBaseArtifactId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<CodexPetBusyAction>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showActualSize, setShowActualSize] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedProjectIdRef = useRef<string | null | undefined>(undefined);
  const draftProjectIdRef = useRef<string | null>(null);
  const detailRevisionRef = useRef(0);
  const createIdempotencyKeyRef = useRef(makeCodexPetIdempotencyKey("project"));
  const runIdempotencyKeyRef = useRef<{ readonly projectId: string; readonly key: string } | null>(null);
  const continuationIdempotencyKeyRef = useRef<{ readonly runId: string; readonly key: string } | null>(null);
  const terminalBalanceRefreshRef = useRef<{ readonly runId: string; readonly status: string } | null>(null);

  selectedProjectIdRef.current = selectedProjectId;

  const latestRun = detail?.latestRun ?? null;
  const artifactView = useMemo(() => deriveCodexPetArtifacts(detail, latestRun), [detail, latestRun]);
  const billing = useMemo(() => deriveCodexPetBilling(detail, latestRun, pricing), [detail, latestRun, pricing]);
  const gates = useMemo(() => deriveCodexPetRunGates(detail, latestRun), [detail, latestRun]);
  const { baseCandidates } = artifactView;
  const {
    projectStatus,
    historicalImageModel,
    readOnlyArchive,
    runIsTerminal,
    runAllowsInputEdit,
    canContinueFailedBase,
    canResumeGateFailure,
    resumableGateRowLabels,
  } = gates;
  const deliveryReady = isCodexPetDeliveryReady(latestRun);
  const modelContractState = codexPetModelContractState(latestRun);

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
      if (!silent) setError(codexPetErrorMessage(refreshError, "刷新桌宠项目失败"));
      return null;
    }
  }, [applyDetail, client, token]);

  const { events, streamState, eventCursorRef, resetEvents } = useCodexPetRunStream({
    client,
    token,
    projectId: detail?.project.id,
    run: detail?.latestRun,
    selectedProjectIdRef,
    detailRevisionRef,
    applyDetail,
    refreshSelectedProject,
  });

  const lastEvent = events.at(-1);
  const currentSubtask = codexPetCurrentSubtask(detail?.jobs ?? [], lastEvent?.jobKey, latestRun?.progressStage);
  const progress = codexPetDisplayProgress(latestRun, lastEvent?.progress ?? 0);
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

  const clearFeedback = useCallback(() => {
    setError("");
    setNotice("");
  }, []);

  useEffect(() => {
    if (!initialProjectId || initialProjectId === selectedProjectIdRef.current) return;
    setSelectedProjectId(initialProjectId);
    selectedProjectIdRef.current = initialProjectId;
    detailRevisionRef.current += 1;
    setDetail(null);
    setDraft(EMPTY_CODEX_PET_DRAFT);
    setLoadingDetail(true);
    resetEvents();
    clearFeedback();
  }, [clearFeedback, initialProjectId, resetEvents]);

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
        setError(codexPetErrorMessage(projectsResult.reason, "加载桌宠项目失败"));
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
    resetEvents();
    void client.getProject(token, projectId, controller.signal)
      .then((next) => {
        if (selectedProjectIdRef.current !== projectId || detailRevisionRef.current !== revision) return;
        applyDetail(next, true);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) setError(codexPetErrorMessage(loadError, "加载桌宠项目详情失败"));
      })
      .finally(() => {
        if (selectedProjectIdRef.current === projectId) setLoadingDetail(false);
      });
    return () => controller.abort();
  }, [applyDetail, client, resetEvents, selectedProjectId, token]);

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
    if (!latestRun || !TERMINAL_RUN_STATUSES.has(latestRun.status)) return;
    const last = terminalBalanceRefreshRef.current;
    if (last?.runId === latestRun.id && last.status === latestRun.status) return;
    terminalBalanceRefreshRef.current = { runId: latestRun.id, status: latestRun.status };
    onBalanceRefresh?.();
  }, [latestRun?.id, latestRun?.status, onBalanceRefresh]);

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
    setSelectedBaseArtifactId(null);
    draftProjectIdRef.current = null;
    resetEvents();
    createIdempotencyKeyRef.current = makeCodexPetIdempotencyKey("project");
    runIdempotencyKeyRef.current = null;
    clearFeedback();
  };

  const selectProject = (projectId: string) => {
    if (interactionLocked) return;
    setSelectedProjectId(projectId);
    selectedProjectIdRef.current = projectId;
    detailRevisionRef.current += 1;
    // Clear the old detail synchronously. The effect below also sets this
    // state, but doing it here closes the one-render window in which
    // destructive actions could still target the previously selected project.
    setDetail(null);
    setDraft(EMPTY_CODEX_PET_DRAFT);
    setLoadingDetail(true);
    resetEvents();
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
      .catch((saveError: unknown) => setError(codexPetErrorMessage(saveError, "保存桌宠草稿失败")))
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
        setError(codexPetErrorMessage(startError, "启动桌宠制作失败"));
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
        setError(codexPetErrorMessage(uploadError, "上传参考图失败"));
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
      .catch((continuationError: unknown) => setError(codexPetErrorMessage(continuationError, "续跑失败的 GPT 桌宠项目失败")))
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
      .catch((resumeError: unknown) => setError(codexPetErrorMessage(resumeError, "重做闸门指认的动作组失败")))
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
        setSelectedBaseArtifactId(null);
        draftProjectIdRef.current = null;
        resetEvents();
      }
      setNotice("项目已从历史中删除，数据和产物仍保留");
    };

    void client.deleteProject(token, projectId)
      .then(() => {
        const remaining = projects.filter((item) => item.id !== projectId);
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
        setError(codexPetErrorMessage(deleteError, "删除桌宠项目失败"));
      })
      .finally(() => {
        setBusyAction(null);
        setDeletingProjectId(null);
      });
  };

  const handleCancelRun = () => {
    const project = detail?.project;
    const run = latestRun;
    if (!project || !run || !gates.runIsCancellable || interactionLocked) return;
    // Per-image billing does not settle all-or-nothing: cancelling charges the
    // planned calls that already reached the provider and refunds the rest of the
    // reservation. The old "全额退款 / 不退款" wording was wrong in both directions.
    const refundText = `按次计费：已发出的 ${billing.settledPlannedUnits} 次计划内生图会照常结算，`
      + `未发出的部分预计退回 ${billing.projectedRefundPoints ?? 0} 积分。`;
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
      .catch((cancelError: unknown) => setError(codexPetErrorMessage(cancelError, "取消桌宠制作失败")))
      .finally(() => setBusyAction(null));
  };

  const mutateBaseSelection = (
    selection: CodexPetBaseSelection,
    action: Exclude<CodexPetBusyAction, null>,
    success: string,
  ) => {
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
      .catch((selectionError: unknown) => setError(codexPetErrorMessage(selectionError, "处理主形象失败")))
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
      .catch((approvalError: unknown) => setError(codexPetErrorMessage(approvalError, "批准下一次真实生图失败")))
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
      .catch((installError: unknown) => setError(codexPetErrorMessage(installError, "安装到 Codex 失败")))
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
      .catch((downloadError: unknown) => setError(codexPetErrorMessage(downloadError, "下载兼容包失败")))
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

  return {
    state: {
      projects,
      selectedProjectId,
      detail,
      draft,
      selectedActionPrompt,
      pricing,
      modelOptions,
      events,
      streamState,
      /** 事件游标只在渲染期读一次,和拆分前 JSX 里直接读 ref 的行为一致。 */
      eventCursor: eventCursorRef.current,
      selectedBaseArtifactId,
      busyAction,
      deletingProjectId,
      bootstrapping,
      loadingDetail,
      showActualSize,
      error,
      notice,
    },
    derived: {
      latestRun,
      ...artifactView,
      ...billing,
      ...gates,
      deliveryReady,
      modelContractState,
      lastEvent,
      currentSubtask,
      progress,
      detailMatchesSelection,
      selectionIsPending,
      interactionLocked,
      canEdit,
      canStart,
      streamLabel: STREAM_LABELS[streamState] ?? "等待运行",
    },
    actions: {
      setSelectedActionPrompt,
      setSelectedBaseArtifactId,
      setShowActualSize,
      clearFeedback,
      updateDraft,
      updateActionPrompt,
      startNewProject,
      selectProject,
      handleSaveDraft,
      handleStart,
      handleReferenceFiles,
      handleContinueFailedRun,
      handleResumeGateFailure,
      handleDeleteProject,
      handleCancelRun,
      mutateBaseSelection,
      handleApproveNextImage,
      handleInstall,
      handleDownload,
      handleOpenKnowledge,
      handleCopyProject,
    },
  };
}

export type CodexPetStudioController = ReturnType<typeof useCodexPetStudio>;
