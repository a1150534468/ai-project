import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { listNovelChapterVersions, listNovelGenerationRequests, restoreNovelChapterVersion, type NovelChapter, type NovelChapterVersion, type NovelGenerationRequest } from "../../api";

type DeskTab = "prose" | "plan" | "prompts" | "compare" | "versions";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function NovelChapterDesk({
  chapter,
  token,
  projectId,
  chapterTitle,
  chapterSummary,
  chapterOutline,
  generationHint,
  chapterContent,
  targetChars,
  saveStatus,
  isGenerating,
  isRewriting,
  onTitleChange,
  onSummaryChange,
  onOutlineChange,
  onGenerationHintChange,
  onContentChange,
  onTargetCharsChange,
  onGenerate,
  onRewrite,
  onAnalyze,
  onVersionRestored,
}: {
  readonly chapter: NovelChapter | null;
  readonly token: string;
  readonly projectId: string;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly chapterOutline: string;
  readonly generationHint: string;
  readonly chapterContent: string;
  readonly targetChars: string;
  readonly saveStatus: "idle" | "saving" | "saved" | "error";
  readonly isGenerating: boolean;
  readonly isRewriting: boolean;
  readonly onTitleChange: (value: string) => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onOutlineChange: (value: string) => void;
  readonly onGenerationHintChange: (value: string) => void;
  readonly onContentChange: (value: string) => void;
  readonly onTargetCharsChange: (value: string) => void;
  readonly onGenerate: () => void;
  readonly onRewrite: (payload: { selectedText: string; selectionStart: number; selectionEnd: number; instruction: string }) => Promise<void>;
  readonly onAnalyze: () => void;
  readonly onVersionRestored: (chapter: NovelChapter) => void;
}) {
  const [tab, setTab] = useState<DeskTab>("prose");
  const [versions, setVersions] = useState<NovelChapterVersion[]>([]);
  const [promptRequests, setPromptRequests] = useState<NovelGenerationRequest[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptError, setPromptError] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [versionBusy, setVersionBusy] = useState(false);
  const [versionError, setVersionError] = useState("");
  const [rewriteSelection, setRewriteSelection] = useState<{ text: string; start: number; end: number } | null>(null);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteInstruction, setRewriteInstruction] = useState("提升表达质感与叙事张力，保持原意和前后衔接。");
  useEffect(() => { setRewriteSelection(null); setRewriteOpen(false); }, [chapter?.id]);
  useEffect(() => {
    setVersions([]);
    setSelectedVersionId("");
    setVersionError("");
    if (tab !== "versions" || !chapter) return;
    void listNovelChapterVersions(token, projectId, chapter.chapterIndex).then((items) => {
      setVersions(items);
      setSelectedVersionId(items[0]?.id ?? "");
    }).catch((reason) => setVersionError(reason instanceof Error ? reason.message : "加载版本失败"));
  }, [chapter?.id, projectId, tab, token]);
  useEffect(() => {
    setPromptRequests([]);
    setSelectedPromptId("");
    setPromptError("");
    if (tab !== "prompts" || !chapter) return;
    void listNovelGenerationRequests(token, projectId, chapter.chapterIndex).then((items) => {
      setPromptRequests(items);
      setSelectedPromptId(items[0]?.id ?? "");
    }).catch((reason) => setPromptError(reason instanceof Error ? reason.message : "加载提示词记录失败"));
  }, [chapter?.id, projectId, tab, token]);
  const words = Array.from(chapterContent.replace(/\s+/gu, "")).length;
  const original = chapter?.rawContent ?? "";
  const changed = Boolean(original && original !== chapterContent);
  const originalPreview = useMemo(() => original || "暂无 AI 原稿；生成正文后会保留原稿用于对比。", [original]);
  const selectedVersion = versions.find((item) => item.id === selectedVersionId) ?? versions[0] ?? null;
  const selectedPrompt = promptRequests.find((item) => item.id === selectedPromptId) ?? promptRequests[0] ?? null;
  const activeRewriteSelection = rewriteSelection && chapterContent.slice(rewriteSelection.start, rewriteSelection.end) === rewriteSelection.text ? rewriteSelection : null;
  const rewriteChars = activeRewriteSelection ? Array.from(activeRewriteSelection.text.replace(/\s+/gu, "")).length : 0;
  const statusText = saveStatus === "saving" ? "自动保存中" : saveStatus === "saved" ? "已自动保存" : saveStatus === "error" ? "保存失败" : "所有修改自动保存";

  const restoreVersion = async () => {
    if (!chapter || !selectedVersion) return;
    if (!window.confirm(`确定恢复 ${new Date(selectedVersion.createdAt).toLocaleString("zh-CN")} 的版本吗？当前正文会先自动留档。`)) return;
    setVersionBusy(true);
    setVersionError("");
    try {
      const restored = await restoreNovelChapterVersion(token, projectId, chapter.chapterIndex, selectedVersion.id);
      onVersionRestored(restored);
      setTab("prose");
    } catch (reason) {
      setVersionError(reason instanceof Error ? reason.message : "恢复版本失败");
    } finally {
      setVersionBusy(false);
    }
  };
  const captureRewriteSelection = (target: HTMLTextAreaElement) => {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const text = target.value.slice(start, end);
    setRewriteSelection(text.trim() ? { text, start, end } : null);
  };
  const submitRewrite = async () => {
    if (!activeRewriteSelection || !rewriteInstruction.trim()) return;
    try {
      await onRewrite({
        selectedText: activeRewriteSelection.text,
        selectionStart: activeRewriteSelection.start,
        selectionEnd: activeRewriteSelection.end,
        instruction: rewriteInstruction.trim(),
      });
      setRewriteOpen(false);
      setRewriteSelection(null);
    } catch {
      // The parent keeps the product-level error visible while the dialog stays open for retry.
    }
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
      <header className="flex-none border-b border-hairline-subtle px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[220px] flex-[1_1_320px]"><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 rounded-md bg-surface-muted px-2 py-1 text-[10px] font-semibold text-ink-tertiary">第 {chapter?.chapterIndex ?? "-"} 章</span><input value={chapterTitle} onChange={(event) => onTitleChange(event.currentTarget.value)} disabled={!chapter} placeholder="章节标题" aria-label="章节标题" className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base font-semibold text-ink outline-none shadow-none focus:border-0 focus:shadow-none disabled:text-ink-tertiary" /></div><p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-tertiary"><Icon icon={saveStatus === "error" ? "mdi:alert-circle-outline" : "mdi:cloud-check-outline"} className={saveStatus === "saving" ? "animate-pulse text-brand-ink" : ""} />{statusText}<span>·</span><span>{words.toLocaleString("zh-CN")} 字</span>{changed && <><span>·</span><span className="text-brand-ink">已修改 AI 原稿</span></>}</p></div>
          <div className="ml-auto flex flex-[1_1_auto] flex-wrap items-center justify-end gap-2"><label className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline bg-surface-subtle px-2.5 text-[10px] font-semibold text-ink-tertiary transition focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/10">目标<input value={targetChars} onChange={(event) => onTargetCharsChange(event.currentTarget.value)} inputMode="numeric" aria-label="目标字数" className="w-12 rounded-none border-0 bg-transparent p-0 text-right text-xs font-semibold text-ink outline-none shadow-none focus:border-0 focus:shadow-none" />字</label><button type="button" onClick={() => setRewriteOpen(true)} disabled={!activeRewriteSelection || saveStatus === "saving" || isGenerating || isRewriting} title={activeRewriteSelection ? `改写已选中的 ${rewriteChars} 字` : "请先在正文中选择一段文字"} className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink-secondary disabled:opacity-40"><Icon icon={isRewriting ? "mdi:loading" : "mdi:text-box-edit-outline"} className={isRewriting ? "animate-spin" : ""} />{isRewriting ? "改写中" : "局部改写"}</button><button type="button" onClick={onAnalyze} disabled={!chapter?.content} className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink-secondary disabled:opacity-40"><Icon icon="mdi:shield-search-outline" />AI 审阅</button><button type="button" onClick={onGenerate} disabled={isGenerating || isRewriting} className="flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-xs font-semibold text-white shadow-sm disabled:opacity-45"><Icon icon={isGenerating ? "mdi:loading" : chapter?.content ? "mdi:refresh" : "mdi:creation-outline"} className={isGenerating ? "animate-spin" : ""} />{isGenerating ? "提交中" : chapter?.content ? "重写正文" : "生成正文"}</button></div>
        </div>
        <nav className="mt-3 flex gap-1 overflow-x-auto [scrollbar-width:none]">{([
          ["prose", "章节正文", "mdi:file-document-edit-outline"], ["plan", "写作要求", "mdi:clipboard-text-outline"], ["prompts", "提示词记录", "mdi:message-text-lock-outline"], ["compare", "原稿对比", "mdi:file-compare-outline"], ["versions", "版本历史", "mdi:history"],
        ] as const).map(([id, label, icon]) => <button key={id} type="button" onClick={() => setTab(id)} className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${tab === id ? "bg-brand-soft text-brand-ink" : "text-ink-tertiary "}`}><Icon icon={icon} />{label}</button>)}</nav>
      </header>

      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {!chapter ? <div className="grid min-h-[560px] place-items-center px-6 text-center"><div><Icon icon="mdi:book-open-page-variant-outline" className="mx-auto text-5xl text-ink-tertiary" /><h3 className="mt-3 text-sm font-semibold text-ink-secondary">从左侧选择一个章节</h3><p className="mt-1 text-xs text-ink-tertiary">章节规划、正文与情报会在这里展开。</p></div></div> : tab === "prose" ? <div data-testid="novel-chapter-prose-layout" className="mx-auto flex min-h-full w-full max-w-[clamp(920px,82vw,1480px)] flex-col gap-4 px-[clamp(1.25rem,4vw,5rem)] py-[clamp(1.25rem,3vh,2.5rem)]">
          <label className="grid gap-1.5"><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-tertiary">Chapter brief</span><textarea value={chapterSummary} onChange={(event) => onSummaryChange(event.currentTarget.value)} rows={2} placeholder="本章概要与剧情目标" className="w-full resize-none rounded-xl border border-hairline-subtle bg-surface-subtle px-3 py-2 text-xs leading-5 text-ink-secondary outline-none focus:border-brand/45" /></label>
          <textarea value={chapterContent} onChange={(event) => onContentChange(event.currentTarget.value)} onSelect={(event) => captureRewriteSelection(event.currentTarget)} placeholder="在这里写作，或点击右上角生成正文……" className="min-h-[320px] w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent font-serif text-[16px] leading-[2.05] text-ink outline-none [scrollbar-gutter:stable] [scrollbar-width:thin] placeholder:text-ink-tertiary" />
          <div className="flex flex-none items-center justify-between border-t border-hairline-subtle pt-3 text-[10px] text-ink-tertiary"><span>正文编辑器 · 自动保存</span><span>{words.toLocaleString("zh-CN")} 字 · 目标 {targetChars || "-"}</span></div>
        </div> : tab === "plan" ? <div className="mx-auto grid w-full max-w-[980px] gap-4 p-5 lg:grid-cols-2 lg:p-7"><label className="grid gap-2 rounded-2xl border border-hairline-subtle bg-surface-subtle p-4 text-xs font-semibold text-ink-secondary">章节大纲<textarea value={chapterOutline} onChange={(event) => onOutlineChange(event.currentTarget.value)} rows={14} className="mt-1 resize-y rounded-xl border border-hairline bg-surface p-3 text-sm font-normal leading-6 outline-none focus:border-brand/50" /></label><label className="grid gap-2 rounded-2xl border border-hairline-subtle bg-surface-subtle p-4 text-xs font-semibold text-ink-secondary">生成约束<textarea value={generationHint} onChange={(event) => onGenerationHintChange(event.currentTarget.value)} rows={14} placeholder="必须出现 / 不得出现 / 视角 / 场景约束" className="mt-1 resize-y rounded-xl border border-hairline bg-surface p-3 text-sm font-normal leading-6 outline-none focus:border-brand/50" /></label></div> : tab === "compare" ? <div className="grid min-h-[620px] gap-px bg-surface-muted lg:grid-cols-2"><section className="bg-surface-subtle p-5 lg:p-7"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">AI 原稿</h3><span className="text-[10px] text-ink-tertiary">{Array.from(original.replace(/\s+/gu, "")).length} 字</span></div><p className="mt-5 whitespace-pre-wrap font-serif text-sm leading-7 text-ink-secondary">{originalPreview}</p></section><section className="bg-surface p-5 lg:p-7"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">当前版本</h3><span className="text-[10px] text-brand-ink">{changed ? "有人工修改" : "与原稿一致"}</span></div><p className="mt-5 whitespace-pre-wrap font-serif text-sm leading-7 text-ink">{chapterContent || "暂无正文"}</p></section></div> : tab === "prompts" ? <div className="grid min-h-[620px] lg:grid-cols-[300px_minmax(0,1fr)]"><aside className="border-r border-hairline-subtle bg-surface-subtle p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">实际发送记录</h3><span className="text-[10px] text-ink-tertiary">{promptRequests.length} 次</span></div>{promptError && <p className="mt-3 rounded-lg bg-danger/10 p-2 text-xs text-danger-ink">{promptError}</p>}<div className="mt-3 grid gap-2">{promptRequests.map((request) => <button key={request.id} type="button" onClick={() => setSelectedPromptId(request.id)} className={`rounded-xl border p-3 text-left ${selectedPrompt?.id === request.id ? "border-brand/40 bg-brand-soft" : "border-hairline-subtle bg-surface"}`}><span className="block text-xs font-semibold">{request.targetKind === "chapterRewrite" ? "局部改写" : request.attempt > 1 ? `第 ${request.attempt} 次生成` : "正文生成"}</span><span className="mt-1 block text-[10px] text-ink-tertiary">{new Date(request.createdAt).toLocaleString("zh-CN")} · {request.model}</span><span className={`mt-1 block text-[10px] ${request.status === "failed" ? "text-danger-ink" : "text-brand-ink"}`}>{request.status}</span></button>)}{!promptRequests.length && !promptError && <p className="py-10 text-center text-xs leading-5 text-ink-tertiary">本章生成于提示词审计功能上线前，暂无可验证的原始请求。</p>}</div></aside><section className="min-w-0 p-5 lg:p-7">{selectedPrompt ? <div><div className="flex flex-wrap gap-2 text-[10px] text-ink-secondary"><span className="rounded-full bg-brand-soft px-2 py-1 text-brand-ink">实际发送</span><span className="rounded-full bg-surface-muted px-2 py-1">模型 {selectedPrompt.model}</span><span className="rounded-full bg-surface-muted px-2 py-1">Temperature {selectedPrompt.temperature ?? "默认"}</span><span className="rounded-full bg-surface-muted px-2 py-1">Max tokens {selectedPrompt.maxTokens}</span>{selectedPrompt.templateVersion && <span className="rounded-full bg-surface-muted px-2 py-1">模板 v{selectedPrompt.templateVersion}</span>}</div><div className="mt-5 grid gap-5"><section><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">System prompt</h3><button type="button" onClick={() => void navigator.clipboard?.writeText(selectedPrompt.systemPrompt)} className="text-[10px] font-semibold text-brand-ink">复制</button></div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-console p-4 text-xs leading-6 text-console-ink">{selectedPrompt.systemPrompt}</pre></section><section><div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">User prompt</h3><button type="button" onClick={() => void navigator.clipboard?.writeText(selectedPrompt.userPrompt)} className="text-[10px] font-semibold text-brand-ink">复制</button></div><pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-xl border border-hairline-subtle bg-surface-subtle p-4 text-xs leading-6 text-ink">{selectedPrompt.userPrompt}</pre></section></div></div> : <div className="grid min-h-[520px] place-items-center text-sm text-ink-tertiary">请选择一条提示词记录</div>}</section></div> : <div className="grid min-h-[620px] lg:grid-cols-[260px_minmax(0,1fr)]"><aside className="border-r border-hairline-subtle bg-surface-subtle p-4"><div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-secondary">版本历史</h3><span className="text-[10px] text-ink-tertiary">{versions.length} 个版本</span></div>{versionError && <p className="mt-3 rounded-lg bg-danger/10 p-2 text-xs text-danger-ink">{versionError}</p>}<div className="mt-3 grid gap-2">{versions.map((version, index) => <button key={version.id} type="button" onClick={() => setSelectedVersionId(version.id)} className={`rounded-xl border p-3 text-left ${selectedVersion?.id === version.id ? "border-brand/40 bg-brand-soft" : "border-hairline-subtle bg-surface"}`}><span className="block text-xs font-semibold">版本 {versions.length - index}</span><span className="mt-1 block text-[10px] text-ink-tertiary">{new Date(version.createdAt).toLocaleString("zh-CN")} · {version.billableChars} 字</span></button>)}{!versions.length && <p className="py-10 text-center text-xs text-ink-tertiary">编辑或生成正文后会自动留档</p>}</div></aside><section className="p-5 lg:p-7"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink">历史版本预览</h3><p className="mt-1 text-xs text-ink-tertiary">恢复前会自动保存当前正文</p></div><button type="button" onClick={() => void restoreVersion()} disabled={!selectedVersion || versionBusy} className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:opacity-40">{versionBusy ? "恢复中" : "恢复此版本"}</button></div><p className="mt-6 whitespace-pre-wrap font-serif text-sm leading-8 text-ink">{selectedVersion?.content || "请选择历史版本"}</p></section></div>}
      </div>
      {rewriteOpen && activeRewriteSelection && <div className="fixed inset-0 z-[90] grid place-items-center bg-scrim/45 p-4" role="dialog" aria-modal="true" aria-label="局部改写"><div className="w-full max-w-xl overflow-hidden rounded-2xl border border-surface/60 bg-surface shadow-2xl"><header className="flex items-start justify-between border-b border-hairline-subtle px-5 py-4"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon icon="mdi:text-box-edit-outline" className="text-brand-ink" />局部改写</h3><p className="mt-1 text-xs text-ink-tertiary">只替换当前选区，前后正文和章节版本都会保留。</p></div><button type="button" onClick={() => setRewriteOpen(false)} disabled={isRewriting} className="grid h-8 w-8 place-items-center rounded-lg text-ink-secondary disabled:opacity-40" aria-label="关闭"><Icon icon="mdi:close" /></button></header><div className="grid gap-4 p-5"><div className="rounded-xl border border-hairline-subtle bg-surface-subtle p-3"><div className="flex items-center justify-between text-[10px] font-semibold text-ink-tertiary"><span>已选正文</span><span>{rewriteChars} 字</span></div><p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap font-serif text-xs leading-6 text-ink-secondary">{activeRewriteSelection.text}</p></div><div><p className="mb-2 text-xs font-semibold text-ink-secondary">改写方向</p><div className="mb-2 flex flex-wrap gap-2">{["润色表达，保持原意", "增强冲突与叙事张力", "精简重复，加快节奏", "扩写动作、感官与细节"].map((preset) => <button key={preset} type="button" onClick={() => setRewriteInstruction(preset)} className="rounded-full border border-hairline-subtle px-2.5 py-1 text-[10px] text-ink-secondary ">{preset}</button>)}</div><textarea value={rewriteInstruction} onChange={(event) => setRewriteInstruction(event.currentTarget.value)} maxLength={2000} rows={4} autoFocus className="w-full resize-y rounded-xl border border-hairline px-3 py-2 text-sm leading-6 text-ink outline-none focus:border-brand/50" placeholder="例如：保留事实不变，增强人物压迫感，减少解释性句子……" /></div></div><footer className="flex items-center justify-between border-t border-hairline-subtle bg-surface-subtle px-5 py-3"><span className="text-[10px] text-ink-tertiary">提交后由独立 Novel Worker 执行</span><div className="flex gap-2"><button type="button" onClick={() => setRewriteOpen(false)} disabled={isRewriting} className="h-9 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink-secondary disabled:opacity-40">取消</button><button type="button" onClick={() => void submitRewrite()} disabled={isRewriting || !rewriteInstruction.trim()} className="flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-xs font-semibold text-white disabled:opacity-40"><Icon icon={isRewriting ? "mdi:loading" : "mdi:creation-outline"} className={isRewriting ? "animate-spin" : ""} />{isRewriting ? "提交中" : "开始改写"}</button></div></footer></div></div>}
    </section>
  );
}
