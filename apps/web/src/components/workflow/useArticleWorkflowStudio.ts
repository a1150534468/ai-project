/**
 * 图文工坊的主控。四个子层拆出去之后这里只剩「批次 + 项目 + 动作」：
 *  - 草稿 / 脏标记 / hash 基线 → `useArticleWorkflowDrafts`
 *  - 新建表单 + 预览态换肤 → `useArticleWorkflowCreationForm`
 *  - 批次轮询 → `useArticleWorkflowBatchPolling`
 *  - 手动保存 + 自动保存 + 409 竞态 → `useArticleWorkflowSave`
 *
 * 返回值仍然是**一个扁平对象**：`ArticleWorkflowStudio.tsx` 与三个测试文件直接按名取值，这层
 * 形状不能改。但「怎么攒出这个对象」是自由的 —— 现在按状态分组存，最后一次 spread 成扁平的。
 *
 * 重写时收掉的四处：
 *  - **八个动作各手抄一遍 `try/catch/finally`**。`err instanceof Error ? err.message : "兜底"`
 *    抄了八份，`finally` 里解忙抄了八份（还要各自记得写回 `null` 还是 `false`），
 *    「成功后刷一次历史列表」抄了六份。现在这层外壳只有一份：`runAction`。
 *  - **七个 `useState` 只为记「哪个动作在飞」**。收成一份 `pending`：`resetToNewProject`
 *    与 `return` 各少七行，`runAction` 也才可能按 `NOTHING_PENDING` 自动解忙。
 *  - **`batchProjects` / `activePlatform` / `editorSyncKey` 是同一件事的三个 state**。
 *    载入批次、切平台、回新建态都得三行一起写，漏一行就是「换了平台但编辑器没重灌」。
 *    收成一份 `batch` 之后 `activePlatform` 也从 `hydrateProjects` 的依赖里消失了 ——
 *    它原本挂在 `hydrateProjects → loadBatch → 轮询 effect` 这条链上，切一次平台就把 2.5s
 *    的轮询定时器重建一次。
 *  - **`error` / `notice` 两个 state**，可是每个动作都要「先清两条再写一条」。收成一份
 *    `messages`，清提示是一次 setState；「提示栏一句 + toast 一句」的五处成对调用收成 `announce`。
 *
 * 传给子 hook 的回调必须是稳定身份（`useCallback`）。链上任何一环每次渲染换新身份，2.5s 的
 * 轮询定时器就会被反复重建，等于永不发车；`setError` / `setNotice` 现在是 `messages` 上的包装，
 * 同样得稳 —— 它们进了保存层 `saveProject` 的依赖数组，换身份等于自动保存的 1.5s 计时器
 * 每渲染重置一次。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  articleWorkflowPlatformConfig,
  type ArticleWorkflowGenerationMode,
  type ArticleWorkflowPlatform,
  type ArticleWorkflowSourceFormat,
} from "@ai-assistant/article-workflow";
import { useToast } from "../../motion";
import {
  applyArticleWorkflowTheme,
  createArticleWorkflowProject,
  deleteArticleWorkflowProject,
  generateArticleWorkflowImages,
  getArticleWorkflowBatch,
  getArticleWorkflowProject,
  listArticleWorkflowHistory,
  regenerateArticleWorkflowImage,
  retryArticleWorkflowProject,
  rewriteArticleWorkflowProject,
  type ArticleWorkflowProject,
  type ArticleWorkflowProjectSummary,
} from "../../workflowArticleApi";
import {
  articleWorkflowBatchKey,
  articleWorkflowBatchProgress,
  groupArticleWorkflowHistory,
  resolveActiveArticleWorkflowProject,
  type ArticleWorkflowBatchEntry,
} from "./articleWorkflowBatchModel";
import { createArticleWorkflowCopyActions } from "./articleWorkflowCopyActions";
import {
  articleWorkflowCreationConfigFromDraft,
  canSubmitArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";
import {
  articleWorkflowDraftHash,
  canSaveArticleWorkflowStatus,
  cloneImageManifest,
  isBusyArticleWorkflowStatus,
  needsArticleWorkflowImages,
  type ArticleWorkflowStudioProps,
} from "./articleWorkflowStudioModel";
import { useArticleWorkflowBatchPolling, type ArticleWorkflowLoadBatchArgs } from "./useArticleWorkflowBatchPolling";
import { useArticleWorkflowCreationForm } from "./useArticleWorkflowCreationForm";
import { useArticleWorkflowDrafts, type ArticleWorkflowDraftPatch } from "./useArticleWorkflowDrafts";
import { useArticleWorkflowSave } from "./useArticleWorkflowSave";

/** 侧栏点一行传回来的东西。`key` 是 `articleWorkflowBatchKey` 算出来的那个。 */
export interface ArticleWorkflowBatchSelection {
  readonly key: string;
  readonly batchId: string | null;
  readonly projectId: string;
}

/** 批次、当前平台、编辑器重灌键：三个值必须同时改，所以存成一个。 */
interface BatchView {
  readonly projects: readonly ArticleWorkflowProject[];
  readonly platform: ArticleWorkflowPlatform | null;
  readonly syncKey: string;
}

/** 「哪个动作在飞」。上一版是七个各自的 `useState`，于是每处都得七行一起写。 */
interface PendingActions {
  readonly creating: boolean;
  readonly rewriting: boolean;
  readonly applyingTheme: boolean;
  readonly retryingProjectId: string | null;
  readonly deletingBatchKey: string | null;
  readonly regeneratingSlot: string | null;
  readonly generatingImageProjectIds: readonly string[];
}

interface RewritePanel {
  readonly rewriteInstruction: string;
  readonly rewriteGenerationMode: ArticleWorkflowGenerationMode;
  readonly rewriteRegenerateImages: boolean;
}

interface Messages {
  readonly error: string;
  readonly notice: string;
}

/**
 * 一个动作要告诉外壳的全部信息。除了 `run` 之外都是「失败/收尾怎么办」，
 * 缺省值就是最常见的那一档：不置忙、失败只写提示栏、成功后刷历史列表。
 */
interface ActionSpec {
  readonly pending?: Partial<PendingActions>;
  readonly failure: string;
  readonly toastFailure?: boolean;
  readonly saveDirtyFirst?: boolean;
  readonly keepHistory?: boolean;
  readonly run: () => Promise<unknown>;
  readonly recover?: () => Promise<unknown>;
}

const NOTHING_PENDING: PendingActions = {
  creating: false,
  rewriting: false,
  applyingTheme: false,
  retryingProjectId: null,
  deletingBatchKey: null,
  regeneratingSlot: null,
  generatingImageProjectIds: [],
};

const NO_MESSAGES: Messages = { error: "", notice: "" };
const EMPTY_BATCH: BatchView = { projects: [], platform: null, syncKey: "" };
const CLEAN_REWRITE_PANEL: RewritePanel = {
  rewriteInstruction: "",
  rewriteGenerationMode: "preserve-text",
  rewriteRegenerateImages: false,
};

/** 动作落地时按缺省值解忙，免得每个动作都记一遍「我这个键解开时该写 `null` 还是 `false`」。 */
function settled(pending: Partial<PendingActions>): Partial<PendingActions> {
  const keys = Object.keys(pending) as (keyof PendingActions)[];
  return Object.fromEntries(keys.map((key) => [key, NOTHING_PENDING[key]]));
}

function failureText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/** 进批次的每一行都换一份自己的 manifest：编辑器会就地改它，共享引用等于改到别人身上。 */
function withClonedManifest(project: ArticleWorkflowProject): ArticleWorkflowProject {
  return { ...project, imageManifestJson: cloneImageManifest(project.imageManifestJson) };
}
export function useArticleWorkflowStudio({
  token,
  initialHistory,
  initialProject = null,
  initialBootstrapping,
}: ArticleWorkflowStudioProps) {
  const toast = useToast();
  const previewBodyRef = useRef<HTMLDivElement | null>(null);

  const [bootstrapping, setBootstrapping] = useState(initialBootstrapping ?? !initialHistory);
  const [history, setHistory] = useState<readonly ArticleWorkflowProjectSummary[]>(initialHistory ?? []);
  const [batch, setBatch] = useState<BatchView>(() =>
    initialProject
      ? { projects: [initialProject], platform: initialProject.platform, syncKey: "" }
      : EMPTY_BATCH,
  );
  const [pending, setPending] = useState(NOTHING_PENDING);
  const [rewritePanel, setRewritePanel] = useState<RewritePanel>(() => ({
    ...CLEAN_REWRITE_PANEL,
    rewriteGenerationMode: initialProject?.generationMode ?? CLEAN_REWRITE_PANEL.rewriteGenerationMode,
  }));
  const [messages, setMessages] = useState(NO_MESSAGES);

  const markPending = useCallback(
    (patch: Partial<PendingActions>) => setPending((current) => ({ ...current, ...patch })),
    [],
  );
  const setError = useCallback((error: string) => setMessages((current) => ({ ...current, error })), []);
  const setNotice = useCallback((notice: string) => setMessages((current) => ({ ...current, notice })), []);
  const resetMessages = useCallback(() => setMessages(NO_MESSAGES), []);
  /** 成功一句话要同时进提示栏和 toast —— 上一版这对调用在五个动作里各写了一遍。 */
  const announce = useCallback(
    (text: string) => {
      setMessages({ error: "", notice: text });
      toast.show("ok", text);
    },
    [toast],
  );

  /** 三个 setter 都得是稳定身份：`setRewriteGenerationMode` 进了 `hydrateProjects` 的依赖数组。 */
  const patchRewritePanel = useCallback(
    (patch: Partial<RewritePanel>) => setRewritePanel((current) => ({ ...current, ...patch })),
    [],
  );
  const setRewriteInstruction = useCallback(
    (value: string) => patchRewritePanel({ rewriteInstruction: value }),
    [patchRewritePanel],
  );
  const setRewriteGenerationMode = useCallback(
    (value: ArticleWorkflowGenerationMode) => patchRewritePanel({ rewriteGenerationMode: value }),
    [patchRewritePanel],
  );
  const setRewriteRegenerateImages = useCallback(
    (value: boolean) => patchRewritePanel({ rewriteRegenerateImages: value }),
    [patchRewritePanel],
  );

  const batchProjects = batch.projects;
  const drafts = useArticleWorkflowDrafts({ initialProject, batchProjects });
  const { dirtyPlatforms, draftsFor, editDraft, hashOf, hydrateDrafts, markDirty, noteSaved } = drafts;

  /**
   * 当前平台跟着批次走：`platform` 为 null（刚点开一批、还不知道该停在哪）时由批次自己挑一行。
   * 用 ref 记一份，`hydrateProjects` 才不用把 `batch` 收进依赖 —— 它在轮询定时器那条链上。
   */
  const project = useMemo(
    () => resolveActiveArticleWorkflowProject(batch.projects, batch.platform),
    [batch.platform, batch.projects],
  );
  const batchRef = useRef(batch);
  batchRef.current = batch;

  const platform = project?.platform ?? "wechat";
  const platformConfig = articleWorkflowPlatformConfig(platform);
  const captionPlatform = platformConfig.outputKind === "caption";
  const selectedBatchKey = project ? articleWorkflowBatchKey(project) : null;
  const dirty = dirtyPlatforms.includes(platform);
  /** 只有 ready 的行能存。生成中/失败的行连脏标记都打不上，自动保存自然也不会启动。 */
  const savable = canSaveArticleWorkflowStatus(project?.status);

  /**
   * 当前平台的五个草稿值。这里必须 memo：`tags` 缺省是 `[]` 字面量，每次渲染都是新数组，
   * 直接往保存层传会把自动保存的 1.5s 计时器每渲染重置一次。
   */
  const activeDrafts = useMemo(() => draftsFor(platform), [draftsFor, platform]);
  const {
    bodyHtml: bodyHtmlDraft,
    captionText: captionDraft,
    summary: summaryDraft,
    tags: tagsDraft,
    title: titleDraft,
  } = activeDrafts;

  const creationForm = useArticleWorkflowCreationForm({
    initialProject,
    activeProjectId: project?.id,
    onEdit: resetMessages,
  });
  const { creationDraft, generateImages, generationMode, hydrateFromBatch, selectedPlatforms } = creationForm;
  // 主题创作没有原文，格式与原文两格按纯文本兜住
  const sourceFormat: ArticleWorkflowSourceFormat =
    creationDraft.mode === "source" ? creationDraft.sourceFormat : "plain-text";
  const sourceText = creationDraft.mode === "source" ? creationDraft.sourceText : "";

  const historyBatches = useMemo(() => groupArticleWorkflowHistory(history), [history]);
  const batchProgress = useMemo(() => articleWorkflowBatchProgress(batch.projects), [batch.projects]);
  const batchBusy = batch.projects.some((item) => isBusyArticleWorkflowStatus(item.status));

  const replaceProjectRow = useCallback((next: ArticleWorkflowProject) => {
    setBatch((current) => ({
      ...current,
      projects: current.projects.map((item) => (item.id === next.id ? withClonedManifest(next) : item)),
    }));
  }, []);

  /**
   * 服务端那一批的状态写回三处：新建表单、草稿、批次视图。
   * `force=false` 留着仍在编辑的平台草稿，落点则默认沿用当前平台 —— 前提是它还在这一批里。
   */
  const hydrateProjects = useCallback(
    (
      details: readonly ArticleWorkflowProject[],
      args?: { readonly force?: boolean; readonly focusPlatform?: ArticleWorkflowPlatform | null },
    ) => {
      const force = args?.force ?? true;
      if (force) hydrateFromBatch(details);
      // 必须先灌草稿：下面那句 `hashOf` 要读的正是它刚立好的新基线
      hydrateDrafts(details, force);

      const held = batchRef.current.platform;
      const fallback = details.some((item) => item.platform === held) ? held : null;
      const focused = resolveActiveArticleWorkflowProject(details, args?.focusPlatform ?? fallback);
      const syncKey = focused ? `${focused.id}:${hashOf(focused.platform) ?? ""}` : null;
      setBatch((current) => ({
        projects: details.map(withClonedManifest),
        platform: focused?.platform ?? current.platform,
        syncKey: syncKey ?? current.syncKey,
      }));
      if (focused) setRewriteGenerationMode(focused.generationMode);
      return details;
    },
    [hashOf, hydrateDrafts, hydrateFromBatch, setRewriteGenerationMode],
  );

  const refreshHistory = useCallback(async () => {
    setHistory(await listArticleWorkflowHistory(token));
  }, [token]);

  /** 有 batchId 就整批拉，没有的是多平台之前建的存量项目，只能单拉那一个。 */
  const loadBatch = useCallback(
    async (args: ArticleWorkflowLoadBatchArgs) => {
      const details = args.batchId
        ? (await getArticleWorkflowBatch(token, args.batchId)).projects
        : [await getArticleWorkflowProject(token, args.projectId)];
      return hydrateProjects(details, { force: args.force, focusPlatform: args.focusPlatform });
    },
    [hydrateProjects, token],
  );

  // 服务端直出了历史列表就不再拉一次；自己拉的话不论成败都得把首屏骨架关掉
  useEffect(() => {
    if (initialHistory) {
      setBootstrapping(false);
      return;
    }
    void refreshHistory()
      .catch(() => setError("加载图文工作台失败"))
      .finally(() => setBootstrapping(false));
  }, [initialHistory, refreshHistory, setError]);

  // 直出的那个项目也要先立 hash 基线，否则编辑器载入时的规范化回写会被当成用户编辑
  useEffect(() => {
    if (!initialProject) return;
    const syncKey = `${initialProject.id}:${noteSaved(initialProject)}`;
    setBatch((current) => ({ ...current, syncKey }));
  }, [initialProject, noteSaved]);

  useArticleWorkflowBatchPolling({ batchProjects, batchBusy, loadBatch, refreshHistory, setError, setNotice });

  const { saving, saveProject } = useArticleWorkflowSave({
    token,
    project,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    captionDraft,
    tagsDraft,
    dirty,
    rewriting: pending.rewriting,
    hashOf,
    markDirty,
    noteSaved,
    replaceProjectRow,
    refreshHistory,
    setError,
    setNotice,
    toast,
  });

  const canGenerate =
    canSubmitArticleWorkflowCreationDraft(creationDraft) && selectedPlatforms.length > 0 && !pending.creating;
  const canSave = Boolean(project && dirty && savable && !saving);
  const canRewrite = Boolean(
    project &&
      rewritePanel.rewriteInstruction.trim() &&
      !pending.rewriting &&
      !saving &&
      !isBusyArticleWorkflowStatus(project.status),
  );

  const copyActions = createArticleWorkflowCopyActions({
    previewBodyRef,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    captionDraft,
    tagsDraft,
    toast,
    setError,
    setNotice,
  });

  /**
   * 八个动作共用的外壳。上一版每个动作都手抄一遍
   * 「置忙 → 清提示 → try → catch 里 `err instanceof Error ? err.message : 兜底` → finally 解忙」，
   * 其中「成功后刷一次历史列表」抄了六份，`finally` 里解忙还要各自记得写 `null` 还是 `false`。
   */
  const runAction = ({ pending: busy, failure, toastFailure, saveDirtyFirst, keepHistory, run, recover }: ActionSpec) => {
    void (async () => {
      // 先把当前平台的脏草稿存下来。存不成（409 / 网络错）就整个动作都不做
      if (saveDirtyFirst && dirty && !(await saveProject("manual"))) return;
      if (busy) markPending(busy);
      resetMessages();
      try {
        await run();
        if (!keepHistory) await refreshHistory();
      } catch (reason) {
        const message = failureText(reason, failure);
        setError(message);
        if (toastFailure) toast.show("err", message);
        await recover?.();
      } finally {
        if (busy) markPending(settled(busy));
      }
    })();
  };

  /**
   * 服务端重渲过正文（重生图片、换肤都是）：新值即新基线，草稿跟过去，不留脏标记。
   * 上一版这四行在两个动作里各抄了一遍。
   */
  const adoptServerBody = (updated: ArticleWorkflowProject) => {
    replaceProjectRow(updated);
    const syncKey = `${updated.id}:${noteSaved(updated)}`;
    drafts.writeDrafts(updated.platform, { bodyHtml: updated.bodyHtml });
    setBatch((current) => ({ ...current, syncKey }));
  };

  const ensureCanLeaveDirty = () =>
    dirtyPlatforms.length === 0 ||
    typeof window === "undefined" ||
    window.confirm("当前有未保存修改，确定切换项目吗？");

  const resetToNewProject = () => {
    setBatch(EMPTY_BATCH);
    setRewritePanel(CLEAN_REWRITE_PANEL);
    drafts.resetDrafts();
    creationForm.reset();
    resetMessages();
  };

  const handleNewProject = () => {
    if (ensureCanLeaveDirty()) resetToNewProject();
  };

  const handleSelectBatch = (entry: ArticleWorkflowBatchSelection) => {
    if (entry.key === selectedBatchKey || !ensureCanLeaveDirty()) return;
    runAction({
      failure: "加载项目失败",
      keepHistory: true,
      run: () => {
        drafts.clearDirty();
        setBatch((current) => ({ ...current, platform: null }));
        return loadBatch({ batchId: entry.batchId, projectId: entry.projectId, force: true });
      },
    });
  };

  const handleDeleteBatch = (entry: ArticleWorkflowBatchEntry) => {
    if (pending.deletingBatchKey || entry.status === "busy") return;
    const title = entry.title || "未命名图文";
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`确定删除“${title}”吗？该批次下的所有平台内容都会被删除，且无法恢复。`);
    if (!confirmed) return;
    runAction({
      pending: { deletingBatchKey: entry.key },
      failure: "删除项目失败",
      toastFailure: true,
      // 成功的话本地按批次剔掉就行，不必回服务端再拉一遍；只有失败才需要跟服务端对齐
      keepHistory: true,
      recover: () => refreshHistory().catch(() => undefined),
      run: async () => {
        await deleteArticleWorkflowProject(token, entry.projectId);
        setHistory((current) =>
          current.filter((item) => (entry.batchId ? item.batchId !== entry.batchId : item.id !== entry.projectId)),
        );
        if (entry.key === selectedBatchKey) resetToNewProject();
        toast.show("ok", "项目已删除");
      },
    });
  };

  const handleSelectPlatform = (next: ArticleWorkflowPlatform) => {
    const target = batch.projects.find((item) => item.platform === next);
    if (next === batch.platform || !target) return;
    setBatch((current) => ({ ...current, platform: next, syncKey: `${target.id}:${hashOf(next) ?? ""}` }));
    setRewriteGenerationMode(target.generationMode);
    resetMessages();
  };

  const handleGenerate = () => {
    if (!canGenerate) return;
    runAction({
      pending: { creating: true },
      failure: "创建图文项目失败",
      run: async () => {
        const created = await createArticleWorkflowProject(token, {
          creationMode: creationDraft.mode,
          creationConfig: articleWorkflowCreationConfigFromDraft(creationDraft, generateImages),
          sourceFormat,
          sourceText: sourceText.trim(),
          // 主题创作没有原文可保留，一律按「润色」出稿
          generationMode: creationDraft.mode === "topic" ? "polish-text" : generationMode,
          platforms: selectedPlatforms,
          generateImages,
          theme: creationForm.selectedTheme,
          themeColor: creationForm.selectedThemeColor || null,
          galleryMode: creationForm.selectedGalleryMode,
        });
        drafts.clearDirty();
        const details = await loadBatch({
          batchId: created.batchId,
          projectId: created.projectId,
          force: true,
          focusPlatform: created.projects[0]?.platform ?? null,
        });
        setNotice(`已开始生成 ${details.length} 个平台的${generateImages ? "图文" : "文案"}`);
      },
    });
  };

  const handleRewrite = () => {
    if (!project || !canRewrite) return;
    const target = project;
    runAction({
      pending: { rewriting: true },
      failure: "AI 重新生成失败",
      toastFailure: true,
      saveDirtyFirst: true,
      run: async () => {
        await rewriteArticleWorkflowProject(token, target.id, {
          instruction: rewritePanel.rewriteInstruction.trim(),
          generationMode: rewritePanel.rewriteGenerationMode,
          regenerateImages: rewritePanel.rewriteRegenerateImages,
        });
        await loadBatch({ batchId: target.batchId, projectId: target.id, force: true, focusPlatform: target.platform });
        setRewriteInstruction("");
        announce("已提交重新生成");
      },
    });
  };

  /** 失败行重试：走 retry 端点重跑首轮生成，之后交给现有轮询跟到终态。 */
  const handleRetry = (projectId: string) => {
    const target = batch.projects.find((item) => item.id === projectId);
    if (!target || target.status !== "failed" || pending.retryingProjectId) return;
    runAction({
      pending: { retryingProjectId: projectId },
      failure: "重新生成失败",
      toastFailure: true,
      run: async () => {
        await retryArticleWorkflowProject(token, projectId);
        // force=false：别把其他平台正在编辑的草稿冲掉；重试行本身是生成中，会被服务端值覆盖
        await loadBatch({
          batchId: target.batchId,
          projectId,
          force: false,
          focusPlatform: project?.platform ?? target.platform,
        });
        announce("已重新开始生成");
      },
    });
  };

  const handleRegenerateImage = (slot: string) => {
    if (!project) return;
    const target = project;
    runAction({
      pending: { regeneratingSlot: slot },
      failure: "图片重生失败",
      toastFailure: true,
      saveDirtyFirst: true,
      run: async () => {
        adoptServerBody(await regenerateArticleWorkflowImage(token, target.id, slot, {}));
        announce("图片已更新");
      },
    });
  };

  /** 后补配图：当前平台或整批里还缺图的 ready 行，各提一发。 */
  const handleGenerateImages = (scope: "current" | "batch") => {
    if (!project || pending.generatingImageProjectIds.length > 0) return;
    const anchor = project;
    const targets = (scope === "current" ? [anchor] : batch.projects).filter(needsArticleWorkflowImages);
    if (targets.length === 0) return;
    runAction({
      pending: { generatingImageProjectIds: targets.map((item) => item.id) },
      failure: "生成配图失败",
      saveDirtyFirst: true,
      run: async () => {
        // 一发失败不该拖累其他平台，所以是 allSettled 而不是 all
        const results = await Promise.allSettled(targets.map((item) => generateArticleWorkflowImages(token, item.id)));
        const failed = results.filter((result) => result.status === "rejected").length;
        await loadBatch({ batchId: anchor.batchId, projectId: anchor.id, force: false, focusPlatform: anchor.platform });
        if (failed > 0) setError(`${failed} 个平台提交配图失败`);
        else if (scope === "current") setNotice("已开始生成当前平台配图");
        else setNotice(`已开始生成 ${targets.length} 个平台配图`);
      },
    });
  };

  /** 应用预览态主题到项目：后端按 bodyMarkdown + 新主题重渲正文。 */
  const handleApplyTheme = () => {
    if (!project) return;
    const target = project;
    const themed = {
      theme: creationForm.previewTheme ?? target.theme,
      themeColor: (creationForm.previewThemeColor ?? target.themeColor) || null,
      galleryMode: creationForm.previewGalleryMode ?? target.galleryMode,
    };
    runAction({
      pending: { applyingTheme: true },
      failure: "应用主题失败",
      toastFailure: true,
      saveDirtyFirst: true,
      run: async () => {
        adoptServerBody(await applyArticleWorkflowTheme(token, target.id, themed));
        // 预览态到这里才清掉
        creationForm.clearPreviewTheme();
        announce("主题已应用");
      },
    });
  };

  /** 编辑器的五个 onChange 都是「写草稿 + 把上一次的提示清掉」。 */
  const editAndClear = (patch: ArticleWorkflowDraftPatch) => {
    editDraft(platform, patch);
    resetMessages();
  };

  return {
    // 批次与侧栏
    bootstrapping,
    history,
    historyBatches,
    selectedBatchKey,
    batchProjects,
    batchProgress,
    batchBusy,
    // 当前项目与它的草稿
    project,
    activePlatform: project?.platform ?? null,
    platformConfig,
    captionPlatform,
    editorSyncKey: batch.syncKey,
    dirty,
    dirtyPlatforms,
    previewBodyRef,
    titleDraft,
    summaryDraft,
    bodyHtmlDraft,
    captionDraft,
    tagsDraft,
    // 新建表单与换肤
    creationDraft,
    generateImages,
    generationMode,
    selectedPlatforms,
    sourceFormat,
    sourceText,
    setGenerationMode: creationForm.setGenerationMode,
    handleTogglePlatform: creationForm.handleTogglePlatform,
    selectedTheme: creationForm.selectedTheme,
    selectedThemeColor: creationForm.selectedThemeColor,
    selectedGalleryMode: creationForm.selectedGalleryMode,
    previewTheme: creationForm.previewTheme,
    previewThemeColor: creationForm.previewThemeColor,
    previewGalleryMode: creationForm.previewGalleryMode,
    // 创作表单/换肤的那批 setter 自带「改动即清提示」，原样透出
    ...creationForm.handlers,
    // 忙碌位（七个）与提示栏
    ...pending,
    saving,
    error: messages.error,
    notice: messages.notice,
    // 重写面板的三个值与三个 setter
    ...rewritePanel,
    setRewriteInstruction,
    setRewriteGenerationMode,
    setRewriteRegenerateImages,
    canGenerate,
    canSave,
    canRewrite,
    handleNewProject,
    handleSelectBatch,
    handleDeleteBatch,
    handleSelectPlatform,
    handleGenerate,
    handleRewrite,
    handleRetry,
    handleRegenerateImage,
    handleGenerateImages,
    handleApplyTheme,
    handleSave: () => saveProject("manual"),
    ...copyActions,
    markTitleDirty: (value: string) => editAndClear({ title: value }),
    markSummaryDirty: (value: string) => editAndClear({ summary: value }),
    markBodyHtmlDirty: (value: string) => editAndClear({ bodyHtml: value }),
    markCaptionDirty: (value: string) => editAndClear({ captionText: value }),
    markTagsDirty: (value: readonly string[]) => editAndClear({ tags: value }),
    handleBodyBlur: (value: string) => {
      editDraft(platform, { bodyHtml: value });
      // 失焦提交也要过内容判定：编辑器打开就会失焦一次，那一发不该写库
      const changed = articleWorkflowDraftHash({ ...activeDrafts, bodyHtml: value }) !== hashOf(platform);
      if (savable && changed) void saveProject("auto");
    },
  };
}
