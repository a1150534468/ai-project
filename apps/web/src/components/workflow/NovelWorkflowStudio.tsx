import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
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
import { createDefaultNovelDraft, novelCreateGenre, novelCreateTitle, type NovelCreateDraft } from "./NovelCreatePage";
import { NovelLibraryPage } from "../novel/NovelLibraryPage";
import { NovelSetupWizard } from "../novel/NovelSetupWizard";
import { NovelWorkbenchShell } from "../novel/NovelWorkbenchShell";
import { novelProjectIdFromHash } from "../../novelRoute";

interface NovelWorkflowStudioProps {
  readonly token: string;
  readonly onBalanceRefresh?: () => void;
}

type ChapterSaveStatus = "idle" | "saving" | "saved" | "error";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 402) return "算力点不足，请充值后继续";
  return error instanceof Error ? error.message : fallback;
}

function isActiveTask(status: string): boolean {
  return status === "queued" || status === "running";
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "planning", "writing", "validating", "postprocessing"]);

function upsertChapter(chapters: readonly NovelChapter[], chapter: NovelChapter): NovelChapter[] {
  return [...chapters.filter((item) => item.id !== chapter.id && item.chapterIndex !== chapter.chapterIndex), chapter].sort((a, b) => a.chapterIndex - b.chapterIndex);
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

export function NovelWorkflowStudio({ token, onBalanceRefresh }: NovelWorkflowStudioProps) {
  const [projects, setProjects] = useState<readonly NovelProjectSummary[]>([]);
  const [detail, setDetail] = useState<NovelProjectDetail | null>(null);
  const [workbench, setWorkbench] = useState<NovelWorkbenchPayload | null>(null);
  const [view, setView] = useState<"library" | "workbench">("library");
  const [setupOpen, setSetupOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<NovelCreateDraft>(() => createDefaultNovelDraft());
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [chapterSummary, setChapterSummary] = useState("");
  const [chapterOutline, setChapterOutline] = useState("");
  const [generationHint, setGenerationHint] = useState("");
  const [chapterContent, setChapterContent] = useState("");
  const [targetChars, setTargetChars] = useState("3000");
  const [chapterSaveStatus, setChapterSaveStatus] = useState<ChapterSaveStatus>("idle");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [watchedRunId, setWatchedRunId] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const chapters = workbench?.chapters ?? detail?.chapters ?? [];
  const selectedChapter = useMemo(() => chapters.find((chapter) => chapter.id === selectedChapterId) ?? chapters[0] ?? null, [chapters, selectedChapterId]);

  const applyDetail = useCallback((next: NovelProjectDetail) => {
    setDetail(next);
    setTargetChars(String(next.project.targetCharsPerChapter || 3000));
    setSelectedChapterId((current) => next.chapters.some((chapter) => chapter.id === current) ? current : next.chapters[0]?.id ?? "");
  }, []);

  const applyWorkbench = useCallback((next: NovelWorkbenchPayload) => {
    setWorkbench(next);
    setSelectedChapterId((current) => next.chapters.some((chapter) => chapter.id === current) ? current : next.chapters[0]?.id ?? "");
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try { setProjects(await listNovelProjects(token)); }
    catch (reason) { setError(errorMessage(reason, "加载小说书库失败")); }
    finally { setLoading(false); }
  }, [token]);

  const refreshProject = useCallback(async (projectId: string, quiet = false) => {
    try {
      const [nextDetail, nextWorkbench] = await Promise.all([getNovelProject(token, projectId), getNovelWorkbench(token, projectId).catch(() => null)]);
      applyDetail(nextDetail);
      if (nextWorkbench) applyWorkbench(nextWorkbench);
      setProjects((current) => [projectSummary(nextDetail), ...current.filter((item) => item.id !== projectId)]);
      if (!quiet) setError("");
      return nextDetail;
    } catch (reason) {
      if (!quiet) setError(errorMessage(reason, "加载作品失败"));
      return null;
    }
  }, [applyDetail, applyWorkbench, token]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
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
    return () => { active = false; };
  }, [refreshProject]);
  useEffect(() => {
    if (!detail?.tasks.some((task) => isActiveTask(task.status))) return undefined;
    const timer = window.setInterval(() => void refreshProject(detail.project.id, true), 2200);
    return () => window.clearInterval(timer);
  }, [detail, refreshProject]);

  useEffect(() => {
    if (!detail || !watchedRunId) return undefined;
    let cancelled = false;
    let polling = false;
    const projectId = detail.project.id;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await getNovelEngineRun(token, projectId, watchedRunId);
        if (cancelled) return;
        if (ACTIVE_RUN_STATUSES.has(next.run.status)) return;
        await refreshProject(projectId, true);
        if (cancelled) return;
        setWatchedRunId((current) => current === watchedRunId ? "" : current);
        if (next.run.status === "awaitingReview" || next.run.status === "completed") {
          setNotice(`第 ${next.run.currentChapter ?? "-"} 章生成完成，正文已刷新`);
        } else if (next.run.status === "failed") {
          setError(next.run.error || "章节生成失败");
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason, "刷新章节生成状态失败"));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.project.id, refreshProject, token, watchedRunId]);

  useEffect(() => {
    if (!selectedChapter) {
      setChapterTitle(""); setChapterSummary(""); setChapterOutline(""); setGenerationHint(""); setChapterContent(""); setChapterSaveStatus("idle");
      return;
    }
    setChapterTitle(selectedChapter.title);
    setChapterSummary(selectedChapter.summary);
    setChapterOutline(selectedChapter.outline ?? selectedChapter.summary);
    setGenerationHint(selectedChapter.generationHint ?? "");
    setChapterContent(selectedChapter.content);
    setChapterSaveStatus("idle");
  }, [selectedChapter?.id, selectedChapter?.updatedAt]);

  useEffect(() => {
    if (!detail || !selectedChapter) return undefined;
    const unchanged = chapterTitle.trim() === selectedChapter.title && chapterSummary.trim() === selectedChapter.summary && chapterOutline === (selectedChapter.outline ?? selectedChapter.summary) && generationHint === (selectedChapter.generationHint ?? "") && chapterContent === selectedChapter.content;
    if (unchanged) return undefined;
    setChapterSaveStatus("saving");
    const timer = window.setTimeout(() => {
      void saveNovelChapter(token, detail.project.id, selectedChapter.chapterIndex, { title: chapterTitle.trim(), summary: chapterSummary.trim(), outline: chapterOutline, generationHint, content: chapterContent })
        .then((saved) => {
          setDetail((current) => current && current.project.id === detail.project.id ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
          setWorkbench((current) => current && current.project.id === detail.project.id ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
          setChapterSaveStatus("saved");
        })
        .catch((reason) => { setChapterSaveStatus("error"); setError(errorMessage(reason, "自动保存章节失败")); });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [chapterContent, chapterOutline, chapterSummary, chapterTitle, detail?.project.id, generationHint, selectedChapter, token]);

  const createProject = async () => {
    if (createDraft.premise.trim().length < 10) { setError("请先用一段话写清故事梗概"); return; }
    const chapters = numeric(createDraft.chapterCount, 100);
    const chars = numeric(createDraft.chapterChars, 3000);
    if (chapters < 1 || chapters > 9999 || chars < 500 || chars > 20_000) { setError("请检查章节数与每章字数"); return; }
    setBusy("create"); setError("");
    try {
      const created = await createNovelProject(token, {
        title: novelCreateTitle(createDraft), premise: createDraft.premise.trim(), genre: novelCreateGenre(createDraft),
        worldPreset: createDraft.worldPreset, storyStructure: createDraft.storyStructure, pacingControl: createDraft.pacingControl,
        writingStyle: createDraft.writingStyle, specialRequirements: createDraft.specialRequirements,
        targetChapters: chapters, targetCharsPerChapter: chars,
      });
      applyDetail(created); setWorkbench(null); setProjects((current) => [projectSummary(created), ...current]); setCreateDraft(createDefaultNovelDraft()); setSetupOpen(true); setNotice("作品已建档，请完成新书设置");
    } catch (reason) { setError(errorMessage(reason, "创建作品失败")); }
    finally { setBusy(""); }
  };

  const openProject = async (projectId: string) => {
    setBusy("open"); setError(""); setNotice(""); setWorkbench(null);
    const loaded = await refreshProject(projectId);
    setBusy("");
    if (!loaded) return;
    if (!loaded.project.setupCompleted) { setSetupOpen(true); return; }
    setView("workbench");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#novel/${loaded.project.id}/workbench`);
  };

  const removeProject = (project: NovelProjectSummary) => {
    if (!window.confirm(`确定删除《${project.title}》吗？小说数据会被完整删除。`)) return;
    void deleteNovelProject(token, project.id).then(() => setProjects((current) => current.filter((item) => item.id !== project.id))).catch((reason) => setError(errorMessage(reason, "删除作品失败")));
  };

  const finishSetup = async () => {
    if (!detail) return;
    setSetupOpen(false);
    const loaded = await refreshProject(detail.project.id);
    if (loaded) { setView("workbench"); setNotice("新书叙事基座已就绪"); }
  };

  const createChapter = async () => {
    if (!detail) return;
    const chapterIndex = (chapters.at(-1)?.chapterIndex ?? 0) + 1;
    setBusy("new-chapter");
    try {
      const saved = await saveNovelChapter(token, detail.project.id, chapterIndex, { title: `第 ${chapterIndex} 章`, summary: "", outline: "", generationHint: "", content: "" });
      setDetail((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setWorkbench((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setSelectedChapterId(saved.id);
    } catch (reason) { setError(errorMessage(reason, "创建章节失败")); }
    finally { setBusy(""); }
  };

  const generateChapter = async () => {
    if (!detail || !selectedChapter) { setError("请先选择或新建章节"); return; }
    const chars = numeric(targetChars, 3000);
    if (chars < 500 || chars > 12_000) { setError("章节目标字数需在 500 到 12000 之间"); return; }
    setBusy("generate"); setError("");
    try {
      const run = await startNovelAssistedRun(token, detail.project.id, { chapterIndex: selectedChapter.chapterIndex, title: chapterTitle.trim(), summary: [chapterOutline, generationHint].filter(Boolean).join("\n\n"), targetChars: chars });
      setWatchedRunId(run.id);
      setNotice("章节已交给独立 Novel Worker，运行进度会持续刷新"); onBalanceRefresh?.();
    } catch (reason) { setError(errorMessage(reason, "提交章节生成失败")); }
    finally { setBusy(""); }
  };

  const rewriteChapterSelection = async (payload: { selectedText: string; selectionStart: number; selectionEnd: number; instruction: string }) => {
    if (!detail || !selectedChapter) throw new Error("请先选择章节");
    if (chapterSaveStatus === "saving" || chapterContent !== selectedChapter.content) throw new Error("请等待当前修改自动保存后再改写");
    if (chapterContent.slice(payload.selectionStart, payload.selectionEnd) !== payload.selectedText) throw new Error("正文选区已变化，请重新选择");
    setBusy("rewrite"); setError("");
    try {
      const task = await rewriteNovelChapterSelection(token, detail.project.id, selectedChapter.chapterIndex, payload);
      setDetail((current) => current && current.project.id === detail.project.id ? { ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] } : current);
      setNotice("局部改写已交给独立 Novel Worker；完成后会自动替换选区并保留旧版本");
      onBalanceRefresh?.();
    } catch (reason) {
      setError(errorMessage(reason, "提交局部改写失败"));
      throw reason;
    } finally {
      setBusy("");
    }
  };

  const analyzeChapter = () => {
    if (!detail || !selectedChapter) return;
    setReviewSaving(true); setError("");
    void analyzeNovelChapter(token, detail.project.id, selectedChapter.chapterIndex).then((saved) => {
      setDetail((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setWorkbench((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setNotice("章节质量、连续性与叙事资产已刷新");
    }).catch((reason) => setError(errorMessage(reason, "章节分析失败"))).finally(() => setReviewSaving(false));
  };

  const saveReview = (payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean }) => {
    if (!detail || !selectedChapter) return;
    setReviewSaving(true); setError("");
    void saveNovelChapterReview(token, detail.project.id, selectedChapter.chapterIndex, payload).then((saved) => {
      setDetail((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setWorkbench((current) => current ? { ...current, chapters: upsertChapter(current.chapters, saved) } : current);
      setNotice("审阅状态已保存");
    }).catch((reason) => setError(errorMessage(reason, "保存审阅失败"))).finally(() => setReviewSaving(false));
  };

  const applyRestoredVersion = (chapter: NovelChapter) => {
    setDetail((current) => current ? { ...current, chapters: upsertChapter(current.chapters, chapter) } : current);
    setWorkbench((current) => current ? { ...current, chapters: upsertChapter(current.chapters, chapter) } : current);
    setNotice("章节已恢复到所选版本，恢复前正文已自动留档");
  };

  const changeWritingModel = async (model: string, displayName: string) => {
    if (!detail) return;
    setModelSaving(true); setError("");
    try {
      const updated = await updateNovelProject(token, detail.project.id, { writingModel: model });
      applyDetail(updated);
      setNotice(`项目默认写作模型已切换为${model ? `「${displayName}」` : "系统默认"}，将从下一次生成任务开始生效`);
    } catch (reason) {
      setError(errorMessage(reason, "切换写作模型失败"));
    } finally {
      setModelSaving(false);
    }
  };

  if (view === "library" || !detail) return <><div data-novel-scroll-region="library" className="h-full min-h-0 overflow-y-auto overscroll-contain [scroll-padding-bottom:8rem] [scrollbar-gutter:stable] [scrollbar-width:thin]"><NovelLibraryPage projects={projects} loading={loading} draft={createDraft} isCreating={busy === "create"} error={error} onDraftChange={setCreateDraft} onCreate={() => void createProject()} onOpenProject={(id) => void openProject(id)} onDeleteProject={removeProject} /></div>{setupOpen && detail && <NovelSetupWizard token={token} project={detail.project} onClose={() => setSetupOpen(false)} onCompleted={() => void finishSetup()} onProjectChanged={() => refreshProject(detail.project.id, true).then(() => undefined)} onBalanceRefresh={onBalanceRefresh} />}</>;

  return <><NovelWorkbenchShell token={token} detail={detail} workbench={workbench} selectedChapter={selectedChapter} selectedChapterId={selectedChapterId} chapterTitle={chapterTitle} chapterSummary={chapterSummary} chapterOutline={chapterOutline} generationHint={generationHint} chapterContent={chapterContent} targetChars={targetChars} saveStatus={chapterSaveStatus} isGenerating={busy === "generate"} isRewriting={busy === "rewrite"} isReviewSaving={reviewSaving} writingModel={projectWritingModel(detail)} isModelSaving={modelSaving} notice={notice} error={error} onBackToLibrary={() => { setView("library"); setDetail(null); setWorkbench(null); void loadProjects(); window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); }} onOpenSetup={() => setSetupOpen(true)} onRefresh={() => void refreshProject(detail.project.id, true)} onSelectChapter={setSelectedChapterId} onCreateChapter={() => void createChapter()} onTitleChange={setChapterTitle} onSummaryChange={setChapterSummary} onOutlineChange={setChapterOutline} onGenerationHintChange={setGenerationHint} onContentChange={setChapterContent} onTargetCharsChange={setTargetChars} onGenerate={() => void generateChapter()} onRewrite={rewriteChapterSelection} onAnalyze={analyzeChapter} onSaveReview={saveReview} onVersionRestored={applyRestoredVersion} onWritingModelChange={(model, displayName) => void changeWritingModel(model, displayName)} />{setupOpen && <NovelSetupWizard token={token} project={detail.project} onClose={() => setSetupOpen(false)} onCompleted={() => void finishSetup()} onProjectChanged={() => refreshProject(detail.project.id, true).then(() => undefined)} onBalanceRefresh={onBalanceRefresh} />}</>;
}
