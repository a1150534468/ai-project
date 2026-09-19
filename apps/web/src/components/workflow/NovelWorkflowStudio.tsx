/**
 * 小说工作流的容器：书库 / 设置向导 / 写作工作台三个界面共用一份项目状态，页面本身不画任何 UI，
 * 只负责取数、轮询、章节草稿的自动保存，以及把这些分给三个子页面。
 *
 * 项目目录使用 compact 读取，选中章节按需加载；未加载条目不能进入编辑器。
 * detail 是章节唯一来源，workbench 仅提供统计/上下文摘要。刷新共享在途请求，
 * 用项目身份、版本和本地修改保护迟到响应，保持已有自动保存与生成流程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../apiError";
import {
  analyzeNovelChapter,
  createNovelProject,
  deleteNovelProject,
  getNovelEngineRun,
  getNovelProject,
  getNovelChapter,
  getNovelWorkbench,
  listNovelProjects,
  rewriteNovelChapterSelection,
  saveNovelChapter,
  saveNovelChapterReview,
  startNovelAssistedRun,
  updateNovelProject,
  type NovelChapter,
  type NovelProjectDetail,
  type NovelProjectSummary,
  type NovelWorkbenchPayload,
} from "../../api";
import { NovelLibraryPage } from "../novel/NovelLibraryPage";
import { NovelSetupWizard } from "../novel/NovelSetupWizard";
import { NovelWorkbenchShell } from "../novel/NovelWorkbenchShell";
import { novelProjectIdFromHash } from "../../novelRoute";
import {
  createDefaultNovelDraft,
  hasNovelPremise,
  novelCreateGenre,
  novelCreateTitle,
  type NovelCreateDraft,
} from "./NovelCreatePage";

interface NovelWorkflowStudioProps {
  readonly token: string;
}

type ChapterSaveStatus = "idle" | "saving" | "saved" | "error";

/** 同一时刻只会有一件事在跑，界面靠它决定哪颗按钮转圈。 */
type BusyAction = "" | "open" | "create" | "new-chapter" | "generate" | "rewrite";

/** 编辑器手里的那一章。五个字段一起重置、一起比对、一起提交，所以就是一个对象。 */
interface ChapterDraft {
  readonly title: string;
  readonly summary: string;
  readonly outline: string;
  readonly generationHint: string;
  readonly content: string;
}

const EMPTY_CHAPTER_DRAFT: ChapterDraft = { title: "", summary: "", outline: "", generationHint: "", content: "" };

/**
 * 草稿必须记着自己是哪一章的：换章时重置 effect 与自动保存 effect 在同一次提交里跑，后者读到的
 * 是上一帧的草稿。对不上就不判脏，也就不会写下一个再没人清的 `saving`。
 */
interface ChapterEditor {
  readonly chapterId: string;
  readonly draft: ChapterDraft;
}

const EMPTY_EDITOR: ChapterEditor = { chapterId: "", draft: EMPTY_CHAPTER_DRAFT };

function isActiveTask(status: string): boolean {
  return status === "queued" || status === "running";
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "planning", "writing", "validating", "postprocessing"]);

/** 服务端那一章落到编辑器里：大纲缺省用摘要顶上，生成提示可能没有。 */
function chapterDraftOf(chapter: NovelChapter): ChapterDraft {
  return {
    title: chapter.title,
    summary: chapter.summary,
    outline: chapter.outline ?? chapter.summary,
    generationHint: chapter.generationHint ?? "",
    content: chapter.content,
  };
}

/** 提交与比对都按这一份来：标题和摘要两头的空白不算改动，正文与大纲一个字符都算。 */
function normalizeChapterDraft(draft: ChapterDraft): ChapterDraft {
  return { ...draft, title: draft.title.trim(), summary: draft.summary.trim() };
}

function sameChapterDraft(left: ChapterDraft, right: ChapterDraft): boolean {
  return (
    left.title === right.title &&
    left.summary === right.summary &&
    left.outline === right.outline &&
    left.generationHint === right.generationHint &&
    left.content === right.content
  );
}

/** id 或章序号撞上的都算同一章，换掉之后按章序号重排。 */
function upsertChapter(chapters: readonly NovelChapter[], chapter: NovelChapter): NovelChapter[] {
  return [
    ...chapters.filter((item) => item.id !== chapter.id && item.chapterIndex !== chapter.chapterIndex),
    chapter,
  ].sort((left, right) => left.chapterIndex - right.chapterIndex);
}

function projectSummary(detail: NovelProjectDetail): NovelProjectSummary {
  return {
    id: detail.project.id,
    title: detail.project.title,
    genre: detail.project.genre,
    premise: detail.project.premise,
    status: detail.project.status,
    setupStage: detail.project.setupStage,
    setupCompleted: detail.project.setupCompleted,
    targetChapters: detail.project.targetChapters,
    chapterCount: detail.chapters.length,
    totalWords: detail.chapters.reduce((sum, chapter) => sum + chapter.billableChars, 0),
    updatedAt: detail.project.updatedAt,
  };
}

function numeric(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function projectWritingModel(detail: NovelProjectDetail | null): string {
  const value = detail?.project.generationPrefs?.writingModel;
  return typeof value === "string" ? value : "";
}

/** 工作台把项目 id 写进 hash，回书库时清掉；两处只差这一个片段。 */
function setNovelHash(hash: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
}

export function NovelWorkflowStudio({ token }: NovelWorkflowStudioProps) {
  const [projects, setProjects] = useState<readonly NovelProjectSummary[]>([]);
  const [detail, setDetail] = useState<NovelProjectDetail | null>(null);
  const [workbench, setWorkbench] = useState<NovelWorkbenchPayload | null>(null);
  const [view, setView] = useState<"library" | "workbench">("library");
  const [setupOpen, setSetupOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<NovelCreateDraft>(() => createDefaultNovelDraft());
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [chapterEditor, setChapterEditor] = useState<ChapterEditor>(EMPTY_EDITOR);
  const [saveStatus, setSaveStatus] = useState<ChapterSaveStatus>("idle");
  const [targetChars, setTargetChars] = useState("3000");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyAction>("");
  const [modelSaving, setModelSaving] = useState(false);
  const [watchedRunId, setWatchedRunId] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [chapterLoadError, setChapterLoadError] = useState("");
  const [chapterLoadAttempt, setChapterLoadAttempt] = useState(0);
  const requestedProjectRef = useRef("");
  const mutationRevisionRef = useRef(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const refreshesRef = useRef(new Map<string, Promise<NovelProjectDetail | null>>());
  const chapters = detail?.chapters ?? [];
  const selectedEntry = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedChapterId) ?? chapters[0] ?? null,
    [chapters, selectedChapterId],
  );

  const selectedChapter = selectedEntry?.detailLoaded === false ? null : selectedEntry;

  /** 章节重置 effect 要读当下的草稿，但不能跟着草稿重跑 —— 那就是每敲一个字重置一次。 */
  const chapterEditorRef = useRef(chapterEditor);
  useEffect(() => {
    chapterEditorRef.current = chapterEditor;
  }, [chapterEditor]);

  const chapterDraft = chapterEditor.draft;
  const patchChapterDraft = (patch: Partial<ChapterDraft>) =>
    setChapterEditor((current) => ({ ...current, draft: { ...current.draft, ...patch } }));

  /** 选中的章节还在新列表里就留着，不在（被删掉、或换了项目）就选第一章。 */
  const selectChapterFrom = useCallback((next: readonly NovelChapter[]) => {
    setSelectedChapterId((current) => (next.some((chapter) => chapter.id === current) ? current : next[0]?.id ?? ""));
  }, []);

  /** 目录与已加载章节以 detail 为唯一来源；迟到的保存结果不能写入其他项目。 */
  const mergeChapter = useCallback((projectId: string, saved: NovelChapter) => {
    mutationRevisionRef.current += 1;
    setDetail((current) =>
      current?.project.id === projectId ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current,
    );
  }, []);

  const applyDetail = useCallback(
    (next: NovelProjectDetail) => {
      setDetail((current) => ({
        ...next,
        chapters: next.chapters.map((chapter) => {
          const cached = current?.project.id === next.project.id ? current.chapters.find((item) => item.id === chapter.id) : null;
          const editor = chapterEditorRef.current;
          const dirty = cached && editor.chapterId === cached.id && !sameChapterDraft(normalizeChapterDraft(editor.draft), chapterDraftOf(cached));
          return chapter.detailLoaded === false && cached && cached.detailLoaded !== false && (cached.updatedAt === chapter.updatedAt || dirty) ? cached : chapter;
        }),
      }));
      setTargetChars(String(next.project.targetCharsPerChapter || 3000));
      selectChapterFrom(next.chapters);
    },
    [selectChapterFrom],
  );

  const applyWorkbench = useCallback(
    (next: NovelWorkbenchPayload) => {
      setWorkbench(next);
    },
    [],
  );

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listNovelProjects(token));
    } catch (reason) {
      setError(errorMessage(reason, "加载小说书库失败"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  /** Compact directory + highlights; concurrent refresh triggers share one flight. */
  const refreshProject = useCallback(
    (projectId: string, quiet = false) => {
      if (!quiet) requestedProjectRef.current = projectId;
      const key = `${token}:${projectId}:${mutationRevisionRef.current}`;
      const existing = refreshesRef.current.get(key);
      if (existing) return existing;
      const revision = mutationRevisionRef.current;
      const load = async () => {
        try {
          const [nextDetail, nextWorkbench] = await Promise.all([
            getNovelProject(token, projectId, true),
            getNovelWorkbench(token, projectId, true).catch(() => null),
          ]);
          if (requestedProjectRef.current !== projectId || tokenRef.current !== token || mutationRevisionRef.current !== revision) return null;
          applyDetail(nextDetail);
          if (nextWorkbench) applyWorkbench(nextWorkbench);
          else setWorkbench(null);
          setProjects((current) => [projectSummary(nextDetail), ...current.filter((item) => item.id !== projectId)]);
          if (!quiet) setError("");
          return nextDetail;
        } catch (reason) {
          if (!quiet && requestedProjectRef.current === projectId) setError(errorMessage(reason, "加载作品失败"));
          return null;
        }
      };
      const flight = load().finally(() => {
        if (refreshesRef.current.get(key) === flight) refreshesRef.current.delete(key);
      });
      refreshesRef.current.set(key, flight);
      return flight;
    },
    [applyDetail, applyWorkbench, token],
  );

  // An unloaded directory entry is never editable or eligible for autosave.
  useEffect(() => {
    if (!detail || !selectedEntry || selectedEntry.detailLoaded !== false) return;
    let cancelled = false;
    const projectId = detail.project.id;
    const entry = selectedEntry;
    setChapterLoadError("");
    void getNovelChapter(token, projectId, entry.chapterIndex).then((chapter) => {
      if (cancelled) return;
      setDetail((current) => {
        if (current?.project.id !== projectId) return current;
        const currentEntry = current.chapters.find((item) => item.id === entry.id);
        // A save or a newer refresh may have overtaken this read.
        if (currentEntry?.detailLoaded !== false || currentEntry.updatedAt !== entry.updatedAt) return current;
        return { ...current, chapters: upsertChapter(current.chapters, chapter) };
      });
    }).catch((reason) => {
      if (!cancelled) setChapterLoadError(errorMessage(reason, "加载章节失败"));
    });
    return () => { cancelled = true; };
  }, [detail?.project.id, selectedEntry?.id, selectedEntry?.updatedAt, selectedEntry?.detailLoaded, chapterLoadAttempt, token]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /**
   * 地址栏里带着项目 id 就直接进工作台。加载途中组件卸掉了就别再动状态。
   *
   * 这条路刻意不看 `setupCompleted`：把一本还在搭设置的书的链接发给别人，是很正常的一件事，
   * 拿到链接的人应该落在工作台上而不是被按进向导里 —— 那道闸只留在点封面进来的 `openProject` 上。
   * 代价是「设置没做完」这件事在工作台上得说出来，由 NovelWorkbenchShell 的警告条负责。
   */
  useEffect(() => {
    const projectId = novelProjectIdFromHash(window.location.hash);
    if (!projectId) return undefined;

    let active = true;
    setBusy("open");
    void refreshProject(projectId).then((loaded) => {
      if (!active) return;
      setBusy("");
      if (loaded) setView("workbench");
    });
    return () => {
      active = false;
    };
  }, [refreshProject]);

  /**
   * 有任务在跑就每 2.2 秒拉一次。依赖只认「项目 id + 有没有在跑的任务」两个原始值 ——
   * 写成 `detail` 的话每一轮刷新都换一个新对象，这个 interval 就每 2.2 秒被拆掉重建一次。
   */
  const openProjectId = detail?.project.id ?? "";
  const hasActiveTask = detail?.tasks.some((task) => isActiveTask(task.status)) ?? false;
  useEffect(() => {
    if (!openProjectId || !hasActiveTask) return undefined;
    const timer = window.setInterval(() => void refreshProject(openProjectId, true), 2200);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, openProjectId, refreshProject]);

  /** 盯着一次引擎运行：跑完了就刷正文、清掉 watch，顺带按最终状态说一句话。 */
  useEffect(() => {
    if (!openProjectId || !watchedRunId) return undefined;

    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getNovelEngineRun(token, openProjectId, watchedRunId);
        if (cancelled || ACTIVE_RUN_STATUSES.has(next.run.status)) return;
        await refreshProject(openProjectId, true);
        if (cancelled) return;
        setWatchedRunId((current) => (current === watchedRunId ? "" : current));
        if (next.run.status === "failed") {
          setError(next.run.error || "章节生成失败");
        } else if (next.run.status === "awaitingReview" || next.run.status === "completed") {
          setNotice(`第 ${next.run.currentChapter ?? "-"} 章生成完成，正文已刷新`);
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason, "刷新章节生成状态失败"));
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [openProjectId, refreshProject, token, watchedRunId]);

  /**
   * 换章、或者服务端推了新正文（`updatedAt` 变了）就把编辑器重置到服务端那一份。
   *
   * 但我们自己那次自动保存也会把 `updatedAt` 顶上来 —— 同一章、内容也一致就什么都不做，否则刚写上的
   * 「已保存」会立刻被这里刷回 `idle`，用户永远看不到那两个字。换章一定重置，哪怕两章内容一模一样。
   */
  useEffect(() => {
    if (!selectedChapter) {
      setChapterEditor(EMPTY_EDITOR);
      setSaveStatus("idle");
      return;
    }
    const incoming = chapterDraftOf(selectedChapter);
    const current = chapterEditorRef.current;
    if (current.chapterId === selectedChapter.id && sameChapterDraft(incoming, normalizeChapterDraft(current.draft))) {
      return;
    }
    setChapterEditor({ chapterId: selectedChapter.id, draft: incoming });
    setSaveStatus("idle");
  }, [selectedChapter?.id, selectedChapter?.updatedAt]);

  /** 停手 850 毫秒就存一次。`chapterEditor` 的身份只在真的改过之后才变，所以这个计时器不会被白重置。 */
  useEffect(() => {
    if (!openProjectId || !selectedChapter || chapterEditor.chapterId !== selectedChapter.id) return undefined;
    const payload = normalizeChapterDraft(chapterEditor.draft);
    if (sameChapterDraft(payload, chapterDraftOf(selectedChapter))) return undefined;

    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      void saveNovelChapter(token, openProjectId, selectedChapter.chapterIndex, payload)
        .then((saved) => {
          mergeChapter(openProjectId, saved);
          setSaveStatus("saved");
        })
        .catch((reason) => {
          setSaveStatus("error");
          setError(errorMessage(reason, "自动保存章节失败"));
        });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [chapterEditor, mergeChapter, openProjectId, selectedChapter, token]);

  const createProject = async () => {
    if (!hasNovelPremise(createDraft)) {
      setError("请先用一段话写清故事梗概");
      return;
    }
    const targetChapters = numeric(createDraft.chapterCount, 100);
    const charsPerChapter = numeric(createDraft.chapterChars, 3000);
    if (targetChapters < 1 || targetChapters > 9999 || charsPerChapter < 500 || charsPerChapter > 20_000) {
      setError("请检查章节数与每章字数");
      return;
    }

    setBusy("create");
    setError("");
    try {
      const created = await createNovelProject(token, {
        title: novelCreateTitle(createDraft),
        premise: createDraft.premise.trim(),
        genre: novelCreateGenre(createDraft),
        worldPreset: createDraft.worldPreset,
        storyStructure: createDraft.storyStructure,
        pacingControl: createDraft.pacingControl,
        writingStyle: createDraft.writingStyle,
        specialRequirements: createDraft.specialRequirements,
        targetChapters,
        targetCharsPerChapter: charsPerChapter,
      });
      requestedProjectRef.current = created.project.id;
      applyDetail(created);
      setWorkbench(null);
      setProjects((current) => [projectSummary(created), ...current]);
      setCreateDraft(createDefaultNovelDraft());
      setSetupOpen(true);
      setNotice("作品已建档，请完成新书设置");
    } catch (reason) {
      setError(errorMessage(reason, "创建作品失败"));
    } finally {
      setBusy("");
    }
  };

  /** 新书设置没做完就先开向导，做完了才进工作台。 */
  const openProject = async (projectId: string) => {
    setBusy("open");
    setError("");
    setNotice("");
    setWorkbench(null);
    const loaded = await refreshProject(projectId);
    setBusy("");
    if (!loaded) return;
    if (!loaded.project.setupCompleted) {
      setSetupOpen(true);
      return;
    }
    setView("workbench");
    setNovelHash(`#novel/${loaded.project.id}/workbench`);
  };

  const removeProject = (project: NovelProjectSummary) => {
    if (!window.confirm(`确定删除《${project.title}》吗？小说数据会被完整删除。`)) return;
    void deleteNovelProject(token, project.id)
      .then(() => setProjects((current) => current.filter((item) => item.id !== project.id)))
      .catch((reason) => setError(errorMessage(reason, "删除作品失败")));
  };

  const finishSetup = async () => {
    if (!openProjectId) return;
    setSetupOpen(false);
    if (await refreshProject(openProjectId)) {
      setView("workbench");
      setNotice("新书叙事基座已就绪");
    }
  };

  const createChapter = async () => {
    if (!openProjectId) return;
    const chapterIndex = (chapters.at(-1)?.chapterIndex ?? 0) + 1;
    setBusy("new-chapter");
    try {
      const saved = await saveNovelChapter(token, openProjectId, chapterIndex, {
        ...EMPTY_CHAPTER_DRAFT,
        title: `第 ${chapterIndex} 章`,
      });
      mergeChapter(openProjectId, saved);
      setSelectedChapterId(saved.id);
    } catch (reason) {
      setError(errorMessage(reason, "创建章节失败"));
    } finally {
      setBusy("");
    }
  };

  const generateChapter = async () => {
    if (!openProjectId || !selectedChapter) {
      setError("请先选择或新建章节");
      return;
    }
    const chars = numeric(targetChars, 3000);
    if (chars < 500 || chars > 12_000) {
      setError("章节目标字数需在 500 到 12000 之间");
      return;
    }

    setBusy("generate");
    setError("");
    try {
      const run = await startNovelAssistedRun(token, openProjectId, {
        chapterIndex: selectedChapter.chapterIndex,
        title: chapterDraft.title.trim(),
        // 大纲与生成提示一起当作这一章的写作指令下发
        summary: [chapterDraft.outline, chapterDraft.generationHint].filter(Boolean).join("\n\n"),
        targetChars: chars,
      });
      setWatchedRunId(run.id);
      setNotice("章节已交给独立 Novel Worker，运行进度会持续刷新");
    } catch (reason) {
      setError(errorMessage(reason, "提交章节生成失败"));
    } finally {
      setBusy("");
    }
  };

  /** 局部改写按字符区间下发，所以正文必须先落盘、选区必须还对得上。 */
  const rewriteChapterSelection = async (payload: {
    selectedText: string;
    selectionStart: number;
    selectionEnd: number;
    instruction: string;
  }) => {
    if (!openProjectId || !selectedChapter) throw new Error("请先选择章节");
    if (saveStatus === "saving" || chapterDraft.content !== selectedChapter.content) {
      throw new Error("请等待当前修改自动保存后再改写");
    }
    if (chapterDraft.content.slice(payload.selectionStart, payload.selectionEnd) !== payload.selectedText) {
      throw new Error("正文选区已变化，请重新选择");
    }

    setBusy("rewrite");
    setError("");
    try {
      const task = await rewriteNovelChapterSelection(token, openProjectId, selectedChapter.chapterIndex, payload);
      setDetail((current) =>
        current?.project.id === openProjectId
          ? { ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] }
          : current,
      );
      setNotice("局部改写已交给独立 Novel Worker；完成后会自动替换选区并保留旧版本");
    } catch (reason) {
      setError(errorMessage(reason, "提交局部改写失败"));
      throw reason;
    } finally {
      setBusy("");
    }
  };

  /** 章节分析与保存审阅回来的都是整章，收尾只差那句话。 */
  const runReviewAction = (action: Promise<NovelChapter>, done: string, fallback: string) => {
    const projectId = openProjectId;
    setReviewSaving(true);
    setError("");
    void action
      .then((saved) => {
        mergeChapter(projectId, saved);
        setNotice(done);
      })
      .catch((reason) => setError(errorMessage(reason, fallback)))
      .finally(() => setReviewSaving(false));
  };

  const analyzeChapter = () => {
    if (!openProjectId || !selectedChapter) return;
    runReviewAction(
      analyzeNovelChapter(token, openProjectId, selectedChapter.chapterIndex),
      "章节质量、连续性与叙事资产已刷新",
      "章节分析失败",
    );
  };

  const saveReview = (payload: {
    status?: "pending" | "approved" | "revise";
    reviewNotes?: string;
    regenerateAi?: boolean;
  }) => {
    if (!openProjectId || !selectedChapter) return;
    runReviewAction(
      saveNovelChapterReview(token, openProjectId, selectedChapter.chapterIndex, payload),
      "审阅状态已保存",
      "保存审阅失败",
    );
  };

  const applyRestoredVersion = (chapter: NovelChapter) => {
    mergeChapter(openProjectId, chapter);
    setNotice("章节已恢复到所选版本，恢复前正文已自动留档");
  };

  const changeWritingModel = async (model: string, displayName: string) => {
    if (!openProjectId) return;
    setModelSaving(true);
    setError("");
    try {
      applyDetail(await updateNovelProject(token, openProjectId, { writingModel: model }));
      setNotice(`项目默认写作模型已切换为${model ? `「${displayName}」` : "系统默认"}，将从下一次生成任务开始生效`);
    } catch (reason) {
      setError(errorMessage(reason, "切换写作模型失败"));
    } finally {
      setModelSaving(false);
    }
  };

  const backToLibrary = () => {
    requestedProjectRef.current = "";
    setView("library");
    setDetail(null);
    setWorkbench(null);
    void loadProjects();
    setNovelHash("");
  };

  /** 书库与工作台都可能挂着新书设置向导，props 一字不差，所以只写一份。 */
  const setupWizard =
    setupOpen && detail ? (
      <NovelSetupWizard
        token={token}
        project={detail.project}
        onClose={() => setSetupOpen(false)}
        onCompleted={() => void finishSetup()}
        onProjectChanged={() => void refreshProject(detail.project.id, true)}
      />
    ) : null;

  if (view === "library" || !detail) {
    return (
      <>
        <div
          data-novel-scroll-region="library"
          className="h-full min-h-0 overflow-y-auto overscroll-contain [scroll-padding-bottom:8rem] [scrollbar-gutter:stable] [scrollbar-width:thin]"
        >
          <NovelLibraryPage
            projects={projects}
            loading={loading}
            draft={createDraft}
            isCreating={busy === "create"}
            error={error}
            onDraftChange={setCreateDraft}
            onCreate={() => void createProject()}
            onOpenProject={(id) => void openProject(id)}
            onDeleteProject={removeProject}
          />
        </div>
        {setupWizard}
      </>
    );
  }

  return (
    <>
      <NovelWorkbenchShell
        token={token}
        detail={detail}
        workbench={workbench}
        selectedChapter={selectedChapter}
        chapterLoading={selectedEntry?.detailLoaded === false}
        chapterLoadError={chapterLoadError}
        onRetryChapter={() => setChapterLoadAttempt((value) => value + 1)}
        selectedChapterId={selectedChapterId}
        chapterTitle={chapterDraft.title}
        chapterSummary={chapterDraft.summary}
        chapterOutline={chapterDraft.outline}
        generationHint={chapterDraft.generationHint}
        chapterContent={chapterDraft.content}
        targetChars={targetChars}
        saveStatus={saveStatus}
        isGenerating={busy === "generate"}
        isRewriting={busy === "rewrite"}
        isReviewSaving={reviewSaving}
        writingModel={projectWritingModel(detail)}
        isModelSaving={modelSaving}
        notice={notice}
        error={error}
        onBackToLibrary={backToLibrary}
        onOpenSetup={() => setSetupOpen(true)}
        onRefresh={() => void refreshProject(detail.project.id, true)}
        onSelectChapter={setSelectedChapterId}
        onCreateChapter={() => void createChapter()}
        onTitleChange={(value) => patchChapterDraft({ title: value })}
        onSummaryChange={(value) => patchChapterDraft({ summary: value })}
        onOutlineChange={(value) => patchChapterDraft({ outline: value })}
        onGenerationHintChange={(value) => patchChapterDraft({ generationHint: value })}
        onContentChange={(value) => patchChapterDraft({ content: value })}
        onTargetCharsChange={setTargetChars}
        onGenerate={() => void generateChapter()}
        onRewrite={rewriteChapterSelection}
        onAnalyze={analyzeChapter}
        onSaveReview={saveReview}
        onVersionRestored={applyRestoredVersion}
        onWritingModelChange={(model, displayName) => void changeWritingModel(model, displayName)}
      />
      {setupWizard}
    </>
  );
}
