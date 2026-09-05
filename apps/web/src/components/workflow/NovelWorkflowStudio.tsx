/**
 * 小说工作流的容器：书库 / 设置向导 / 写作工作台三个界面共用一份项目状态，页面本身不画任何 UI，
 * 只负责取数、轮询、章节草稿的自动保存，以及把这些分给三个子页面。
 *
 * 重写时收掉与修掉的七处：
 *  - **「保存回来的章节写回两份状态」原来抄了五遍**（自动保存 / 新建章节 / 章节分析 / 保存审阅 /
 *    恢复版本），每遍都是 `setDetail` + `setWorkbench` + `upsertChapter` 三件套。收成一个
 *    `mergeChapter(projectId, saved)`，**并且五处都带上项目 id 校验** —— 原来只有自动保存那一处
 *    有，另外四处在「请求还在飞、用户已经切走」时会把这一章塞进另一个项目的状态里。
 *  - **「已保存」原来一闪就没**。章节重置 effect 盯的是 `selectedChapter` 的 `id` 与 `updatedAt`，
 *    而我们自己那次保存恰好会把 `updatedAt` 顶上来 —— 于是状态刚写成 `saved` 就被重置回 `idle`。
 *    现在内容一致就不重置（服务端真的推了新正文时照旧重置，那条路要留着）。
 *  - **「自动保存中」原来一进书就卡住不走了**。打开作品那一次提交里，重置 effect 刚把服务端那一章
 *    写进草稿，同一次提交里的自动保存 effect 读到的还是**上一帧的空草稿**配**新一章** —— 于是判成
 *    脏、写下 `saving`；下一帧草稿追上了，effect 早退，`saving` 再没人改。`NovelChapterDesk` 的
 *    局部改写按钮恰好 `disabled={… || saveStatus === "saving" || …}`，所以那颗按钮从进书起就一直是灰的。
 *    换章同理。现在草稿连着「它属于哪一章」一起存（`ChapterEditor`），两者对不上就不判脏。
 *  - **五个章节草稿字段收成一个对象**。原来 `chapterTitle` / `chapterSummary` / `chapterOutline` /
 *    `generationHint` / `chapterContent` 五个 `useState`，重置、脏判定、提交三处各点一遍名字。
 *  - **任务轮询的依赖从整个 `detail` 换成「有没有在跑的任务 + 项目 id」**。`refreshProject` 每 2.2 秒
 *    换一个新的 `detail` 对象，于是那个 `setInterval` 每一轮都被拆掉重建一次。
 *  - **两处 `window.history.replaceState` 收成 `setNovelHash`**，进工作台写 hash、回书库清 hash。
 *  - **建档的梗概门槛改用 `hasNovelPremise`**，不再和 `NovelCreatePage` 各写一遍 `>= 10`。
 *  - **新书设置向导原来两个 return 各写一遍**（五个 props 一字不差），收成一个 `setupWizard`。
 *
 * 顺带：`createProject` 里那个 `chapters` 遮住了组件作用域里的章节列表，改叫 `targetChapters`；
 * `busy` 从裸字符串收成联合类型；`applyDetail` 与 `applyWorkbench` 里那句「选中的章节还在就留着，
 * 不在就选第一章」收成 `selectChapterFrom`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../apiError";
import {
  analyzeNovelChapter,
  createNovelProject,
  deleteNovelProject,
  getNovelEngineRun,
  getNovelProject,
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

  const chapters = workbench?.chapters ?? detail?.chapters ?? [];
  const selectedChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === selectedChapterId) ?? chapters[0] ?? null,
    [chapters, selectedChapterId],
  );

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

  /** 保存回来的那一章写回 detail 与 workbench。请求飞在路上时用户可能已经切走了，所以两边都认项目 id。 */
  const mergeChapter = useCallback((projectId: string, saved: NovelChapter) => {
    setDetail((current) =>
      current?.project.id === projectId ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current,
    );
    setWorkbench((current) =>
      current?.project.id === projectId ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current,
    );
  }, []);

  const applyDetail = useCallback(
    (next: NovelProjectDetail) => {
      setDetail(next);
      setTargetChars(String(next.project.targetCharsPerChapter || 3000));
      selectChapterFrom(next.chapters);
    },
    [selectChapterFrom],
  );

  const applyWorkbench = useCallback(
    (next: NovelWorkbenchPayload) => {
      setWorkbench(next);
      selectChapterFrom(next.chapters);
    },
    [selectChapterFrom],
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

  /** 工作台那一份数据分两个接口，工作台视图缺了也能用 detail 顶着，所以后者失败不算失败。 */
  const refreshProject = useCallback(
    async (projectId: string, quiet = false) => {
      try {
        const [nextDetail, nextWorkbench] = await Promise.all([
          getNovelProject(token, projectId),
          getNovelWorkbench(token, projectId).catch(() => null),
        ]);
        applyDetail(nextDetail);
        if (nextWorkbench) applyWorkbench(nextWorkbench);
        setProjects((current) => [projectSummary(nextDetail), ...current.filter((item) => item.id !== projectId)]);
        if (!quiet) setError("");
        return nextDetail;
      } catch (reason) {
        if (!quiet) setError(errorMessage(reason, "加载作品失败"));
        return null;
      }
    },
    [applyDetail, applyWorkbench, token],
  );

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
