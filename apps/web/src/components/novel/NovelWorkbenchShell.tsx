import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { nextNovelChapterIndex } from "@ai-assistant/novel-workflow";
import { getNovelStructure, type NovelChapter, type NovelProjectDetail, type NovelStructureNode, type NovelWorkbenchPayload } from "../../api";
import { NovelChapterDesk } from "./NovelChapterDesk";
import { NovelContextInspector } from "./NovelContextInspector";
import { NovelStructureSidebar } from "./NovelStructureSidebar";
import { NovelRunCockpit } from "./NovelRunCockpit";
import { NovelIntelligenceWorkspace } from "./NovelIntelligenceWorkspace";
import { NovelPromptWorkbench } from "./NovelPromptWorkbench";
import { NovelBibleWorkspace } from "./NovelBibleWorkspace";

export type NovelWorkspace = "writing" | "story" | "bible" | "autopilot" | "prompts";

const WORKSPACES: readonly { id: NovelWorkspace; label: string; icon: string; hint: string }[] = [
  { id: "writing", label: "章节创作", icon: "mdi:pen", hint: "规划与正文" },
  { id: "story", label: "故事导航", icon: "mdi:source-branch", hint: "结构与治理" },
  { id: "bible", label: "叙事资产", icon: "mdi:book-open-variant", hint: "Bible 与人物" },
  { id: "autopilot", label: "全托管", icon: "mdi:steering", hint: "运行与 DAG" },
  { id: "prompts", label: "提示词", icon: "mdi:code-braces-box", hint: "节点与版本" },
];

function phaseLabel(value: string): string {
  return ({ opening: "开局", development: "发展", convergence: "收敛", finale: "终局" } as Record<string, string>)[value] ?? value;
}

export function NovelWorkbenchShell({
  token,
  detail,
  workbench,
  selectedChapter,
  selectedChapterId,
  chapterTitle,
  chapterSummary,
  chapterOutline,
  generationHint,
  executionPlan,
  microBeats,
  chapterContent,
  targetChars,
  saveStatus,
  isGenerating,
  isRewriting,
  isReviewSaving,
  notice,
  error,
  onBackToLibrary,
  onOpenSetup,
  onRefresh,
  onSelectChapter,
  onCreateChapter,
  onTitleChange,
  onSummaryChange,
  onOutlineChange,
  onGenerationHintChange,
  onExecutionPlanChange,
  onMicroBeatsChange,
  onContentChange,
  onTargetCharsChange,
  onGenerate,
  onRewrite,
  onAnalyze,
  onSaveReview,
  onVersionRestored,
}: {
  readonly token: string;
  readonly detail: NovelProjectDetail;
  readonly workbench: NovelWorkbenchPayload | null;
  readonly selectedChapter: NovelChapter | null;
  readonly selectedChapterId: string;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly chapterOutline: string;
  readonly generationHint: string;
  readonly executionPlan: unknown;
  readonly microBeats: unknown[];
  readonly chapterContent: string;
  readonly targetChars: string;
  readonly saveStatus: "idle" | "saving" | "saved" | "error";
  readonly isGenerating: boolean;
  readonly isRewriting: boolean;
  readonly isReviewSaving: boolean;
  readonly notice: string;
  readonly error: string;
  readonly onBackToLibrary: () => void;
  readonly onOpenSetup: () => void;
  readonly onRefresh: () => void;
  readonly onSelectChapter: (chapterId: string) => void;
  readonly onCreateChapter: () => void;
  readonly onTitleChange: (value: string) => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onOutlineChange: (value: string) => void;
  readonly onGenerationHintChange: (value: string) => void;
  readonly onExecutionPlanChange: (value: unknown) => void;
  readonly onMicroBeatsChange: (value: unknown[]) => void;
  readonly onContentChange: (value: string) => void;
  readonly onTargetCharsChange: (value: string) => void;
  readonly onGenerate: () => void;
  readonly onRewrite: (payload: { selectedText: string; selectionStart: number; selectionEnd: number; instruction: string }) => Promise<void>;
  readonly onAnalyze: () => void;
  readonly onSaveReview: (payload: { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean }) => void;
  readonly onVersionRestored: (chapter: NovelChapter) => void;
}) {
  const [workspace, setWorkspace] = useState<NovelWorkspace>("writing");
  const [structure, setStructure] = useState<NovelStructureNode[]>([]);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  useEffect(() => { void getNovelStructure(token, detail.project.id).then(setStructure).catch(() => setStructure([])); }, [detail.project.id, detail.project.updatedAt, token, workbench?.chapters.length]);
  const chapters = workbench?.chapters ?? detail.chapters;
  const totalWords = workbench?.stats.totalWords ?? chapters.reduce((sum, chapter) => sum + chapter.billableChars, 0);
  const completed = workbench?.stats.finishedChapters ?? chapters.filter((chapter) => Boolean(chapter.content)).length;
  const progress = detail.project.targetChapters > 0 ? Math.min(100, Math.round(completed / detail.project.targetChapters * 100)) : 0;
  const activeRun = detail.tasks.find((task) => task.status === "queued" || task.status === "running");
  const runningChapter = useMemo(() => {
    const payload = activeRun?.requestPayload;
    return payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).chapterIndex === "number" ? (payload as Record<string, unknown>).chapterIndex as number : null;
  }, [activeRun]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f2f5f4] text-[#26302d]">
      <header className="flex-none border-b border-[#dfe5e2] bg-white">
        <div className="flex min-h-14 flex-col gap-3 px-3 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-4">
          <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={onBackToLibrary} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[#d9dfdd] text-[#64706b]" title="返回书库"><Icon icon="mdi:arrow-left" /></button><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-base font-semibold text-[#202825]">{detail.project.title}</h1><span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand-ink">{phaseLabel(detail.project.storyPhase)}</span>{activeRun && <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-brand-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-brand" />后台生成中</span>}</div><p className="mt-0.5 truncate text-[10px] text-[#89928f]">{detail.project.genre} · {detail.project.currentBranch} 世界线</p></div></div>
          <div className="flex items-center gap-4 overflow-x-auto [scrollbar-width:none]"><div className="flex shrink-0 items-center gap-5 text-center">{[[totalWords.toLocaleString("zh-CN"), "总字数"], [`${completed}/${detail.project.targetChapters}`, "章节"], [`${progress}%`, "进度"]].map(([value, label]) => <div key={label}><p className="text-sm font-semibold text-[#303936]">{value}</p><p className="text-[9px] text-[#8d9693]">{label}</p></div>)}</div><div className="h-8 w-px shrink-0 bg-[#e2e7e5]" /><button type="button" onClick={onOpenSetup} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#6b7671] hover:bg-[#f0f3f2]" title="作品设置"><Icon icon="mdi:cog-outline" /></button><button type="button" onClick={onRefresh} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#6b7671] hover:bg-[#f0f3f2]" title="刷新"><Icon icon="mdi:refresh" /></button></div>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto border-t border-[#eef1f0] px-3 py-1.5 [scrollbar-width:none]">{WORKSPACES.map((item) => <button key={item.id} type="button" onClick={() => setWorkspace(item.id)} className={`group flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition ${workspace === item.id ? "bg-brand-soft text-brand-ink" : "text-[#65706c] hover:bg-[#f2f5f4]"}`}><Icon icon={item.icon} /><span>{item.label}</span><span className={`hidden text-[9px] font-normal xl:inline ${workspace === item.id ? "text-brand-ink/70" : "text-[#9aa19f]"}`}>{item.hint}</span></button>)}<div className="flex-1" />{workspace === "writing" && <div className="hidden items-center gap-1 xl:flex"><button type="button" onClick={() => setLeftOpen((value) => !value)} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${leftOpen ? "bg-[#eef2f0] text-brand-ink" : "text-[#7c8582]"}`} title="切换结构栏"><Icon icon="mdi:dock-left" /></button><button type="button" onClick={() => setRightOpen((value) => !value)} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${rightOpen ? "bg-[#eef2f0] text-brand-ink" : "text-[#7c8582]"}`} title="切换情报栏"><Icon icon="mdi:dock-right" /></button></div>}</div>
      </header>

      {(error || notice) && <div className={`mx-3 mt-2 flex-none rounded-lg px-3 py-2 text-xs ${error ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand-ink"}`}>{error || notice}</div>}

      <main className="min-h-0 flex-1">
        {workspace === "writing" ? <div className={`grid h-full min-h-0 grid-cols-1 overflow-hidden ${leftOpen && rightOpen ? "xl:grid-cols-[230px_minmax(0,1fr)_290px] 2xl:grid-cols-[250px_minmax(0,1fr)_310px]" : leftOpen ? "xl:grid-cols-[230px_minmax(0,1fr)] 2xl:grid-cols-[250px_minmax(0,1fr)]" : rightOpen ? "xl:grid-cols-[minmax(0,1fr)_290px] 2xl:grid-cols-[minmax(0,1fr)_310px]" : ""}`}>
          {leftOpen && <NovelStructureSidebar nodes={structure} chapters={chapters} selectedChapterId={selectedChapterId} runningChapter={runningChapter} onSelectChapter={onSelectChapter} onCreateChapter={onCreateChapter} onOpenPlanning={() => setWorkspace("story")} />}
          <NovelChapterDesk token={token} projectId={detail.project.id} chapter={selectedChapter} chapterTitle={chapterTitle} chapterSummary={chapterSummary} chapterOutline={chapterOutline} generationHint={generationHint} executionPlan={executionPlan} microBeats={microBeats} chapterContent={chapterContent} targetChars={targetChars} saveStatus={saveStatus} isGenerating={isGenerating} isRewriting={isRewriting} onTitleChange={onTitleChange} onSummaryChange={onSummaryChange} onOutlineChange={onOutlineChange} onGenerationHintChange={onGenerationHintChange} onExecutionPlanChange={onExecutionPlanChange} onMicroBeatsChange={onMicroBeatsChange} onContentChange={onContentChange} onTargetCharsChange={onTargetCharsChange} onGenerate={onGenerate} onRewrite={onRewrite} onAnalyze={onAnalyze} onVersionRestored={onVersionRestored} />
          {rightOpen && <NovelContextInspector token={token} projectId={detail.project.id} chapter={selectedChapter} workbench={workbench} isReviewSaving={isReviewSaving} onSaveReview={onSaveReview} onAnalyze={onAnalyze} />}
        </div> : workspace === "autopilot" ? <div className="h-full min-h-0 overflow-hidden p-4 sm:p-6"><NovelRunCockpit token={token} projectId={detail.project.id} nextChapter={nextNovelChapterIndex(chapters)} onProjectChanged={onRefresh} /></div> : <div className="h-full overscroll-contain overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]">{workspace === "story" ? <div className="p-4 sm:p-6"><NovelIntelligenceWorkspace token={token} projectId={detail.project.id} showPrompts={false} /></div> : workspace === "bible" ? <NovelBibleWorkspace token={token} projectId={detail.project.id} onOpenSetup={onOpenSetup} /> : <div className="p-4 sm:p-6"><NovelPromptWorkbench token={token} projectId={detail.project.id} /></div>}</div>}
      </main>
    </section>
  );
}
