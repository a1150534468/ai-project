import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import {
  controlNovelEngineRun,
  exportNovelProject,
  getNovelEngineRun,
  getNovelNarrativeDashboard,
  importNovelProject,
  listNovelEngineEvents,
  listNovelEngineRuns,
  startNovelAutopilotRun,
  streamNovelEngineEvents,
  type NovelEngineEvent,
  type NovelEngineRun,
  type NovelEngineStep,
  type NovelNarrativeDashboard,
} from "../../api";
import { NovelScoreTrend } from "./NovelScoreTrend";

const ACTIVE_STATUSES = new Set(["queued", "planning", "writing", "validating", "postprocessing"]);
const BOOK_LOCKING_STATUSES = new Set([...ACTIVE_STATUSES, "awaitingReview", "paused", "failed"]);

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  planning: "规划中",
  writing: "写作中",
  validating: "质检中",
  postprocessing: "章后处理",
  awaitingReview: "等待审阅",
  paused: "已暂停",
  completed: "已完成",
  failed: "异常挂起",
  cancelled: "已取消",
};

const STEP_LABELS: Record<string, string> = {
  prepareChapter: "章节剧本",
  assembleContext: "上下文装配",
  writeChapter: "正文生成",
  validateContent: "内容质检",
  auditVoice: "文风审计",
  postprocessChapter: "章后同步",
  scoreTension: "张力评分",
  finalizeChapter: "状态推进",
};
const PIPELINE_ORDER = ["prepareChapter", "assembleContext", "writeChapter", "validateContent", "auditVoice", "postprocessChapter", "scoreTension", "finalizeChapter"] as const;
const STEP_HEARTBEAT_STALE_MS = 90_000;

export function novelRunEventText(event: NovelEngineEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.error === "string") return payload.error;
  if (event.type === "runQueued") return "运行已入队";
  if (event.type === "runStatusChanged") {
    if (payload.reason === "autoRevisionRequested") return `质量门禁未通过，自动返修 ${String(payload.revisionAttempt ?? "-")}/${String(payload.maxRevisionAttempts ?? "-")}`;
    if (payload.reason === "aiRevisionRequested") return "已提交 AI 修订重检";
    return STATUS_LABELS[event.stage] ?? event.stage;
  }
  if (event.type === "chapterCompleted") return `第 ${event.chapterNumber ?? "-"} 章完成`;
  if (event.type === "runCompleted") return "目标章节已经完成";
  if (event.type === "reviewRequired") {
    if (payload.reason === "assistedCompletion") return "辅助写作完成，等待人工确认";
    if (payload.reason === "manualReviewPolicy") return "自动续写已关闭，等待人工确认";
    const reasons = Array.isArray(payload.gateReasons) ? payload.gateReasons.filter((reason): reason is string => typeof reason === "string") : [];
    return reasons.length ? `质量门禁未通过：${reasons.join("；")}` : "质量门禁未通过，等待人工审阅";
  }
  if (event.type === "chapterChunk" && typeof payload.text === "string") return payload.text;
  if (event.type === "stepStarted") return "开始";
  if (event.type === "stepCompleted") return "完成";
  return STEP_LABELS[event.step ?? ""] ?? event.type;
}

export function novelRunEventScope(event: NovelEngineEvent): string {
  if (["runQueued", "runStatusChanged", "runCompleted", "reviewRequired", "chapterCompleted"].includes(event.type)) return "运行";
  return event.step ? STEP_LABELS[event.step] ?? event.step : event.type;
}

export function novelRunEventTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

function compactEvents(current: NovelEngineEvent[], next: NovelEngineEvent): NovelEngineEvent[] {
  if (current.some((event) => event.id === next.id)) return current;
  return [...current, next].sort((a, b) => a.sequence - b.sequence).slice(-200);
}

export function NovelRunCockpit({
  token,
  projectId,
  nextChapter,
  onProjectChanged,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly nextChapter: number;
  readonly onProjectChanged?: () => void;
}) {
  const [runs, setRuns] = useState<NovelEngineRun[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [steps, setSteps] = useState<NovelEngineStep[]>([]);
  const [events, setEvents] = useState<NovelEngineEvent[]>([]);
  const [dashboard, setDashboard] = useState<NovelNarrativeDashboard | null>(null);
  const [view, setView] = useState<"cockpit" | "governance" | "dashboard" | "operations">("cockpit");
  const [targetChapters, setTargetChapters] = useState("100");
  const [targetChars, setTargetChars] = useState("3000");
  const [autoReview, setAutoReview] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const cursorRef = useRef(0);
  const onProjectChangedRef = useRef(onProjectChanged);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const logFollowingRef = useRef(true);

  useEffect(() => {
    onProjectChangedRef.current = onProjectChanged;
  }, [onProjectChanged]);

  const activeRun = useMemo(() => runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null, [activeRunId, runs]);
  const streamedDraft = useMemo(() => events
    .filter((event) => event.type === "chapterChunk" && event.chapterNumber === activeRun?.currentChapter && typeof (event.payload as Record<string, unknown>).text === "string")
    .map((event) => String((event.payload as Record<string, unknown>).text))
    .join(""), [activeRun?.currentChapter, events]);
  const logEvents = useMemo(() => events.filter((event) => event.type !== "chapterChunk"), [events]);

  useEffect(() => {
    const element = logScrollRef.current;
    if (!element || !logFollowingRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [logEvents]);

  useEffect(() => {
    if (!activeRun) return;
    setTargetChapters(String(activeRun.targetChapters));
    setTargetChars(String(activeRun.targetCharsPerChapter));
    setAutoReview(activeRun.autoReview);
  }, [activeRun?.id, activeRun?.targetChapters, activeRun?.targetCharsPerChapter, activeRun?.autoReview]);

  const load = useCallback(async (selectLatest = false) => {
    const [nextRuns, nextDashboard] = await Promise.all([
      listNovelEngineRuns(token, projectId),
      getNovelNarrativeDashboard(token, projectId).catch(() => null),
    ]);
    setRuns(nextRuns);
    if (nextDashboard) setDashboard(nextDashboard);
    setActiveRunId((current) => selectLatest || !nextRuns.some((run) => run.id === current) ? nextRuns[0]?.id ?? "" : current);
  }, [projectId, token]);

  useEffect(() => {
    setRuns([]);
    setSteps([]);
    setEvents([]);
    setActiveRunId("");
    void load(true).catch((reason) => setError(reason instanceof Error ? reason.message : "加载驾驶舱失败"));
  }, [load]);

  useEffect(() => {
    if (!activeRun) return undefined;
    let cancelled = false;
    const refresh = async () => {
      const detail = await getNovelEngineRun(token, projectId, activeRun.id);
      if (cancelled) return;
      setSteps(detail.steps);
      setRuns((current) => current.map((run) => run.id === detail.run.id ? detail.run : run));
    };
    void refresh();
    if (!ACTIVE_STATUSES.has(activeRun.status)) return () => { cancelled = true; };
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status, projectId, token]);

  useEffect(() => {
    if (!activeRun) return undefined;
    const controller = new AbortController();
    cursorRef.current = 0;
    setEvents([]);
    void (async () => {
      const initial = await listNovelEngineEvents(token, projectId, activeRun.id, 0);
      if (controller.signal.aborted) return;
      setEvents(initial.events);
      cursorRef.current = initial.cursor;
      while (!controller.signal.aborted) {
        try {
          await streamNovelEngineEvents({
            token,
            projectId,
            runId: activeRun.id,
            after: cursorRef.current,
            signal: controller.signal,
            onEvent: (event) => {
              cursorRef.current = Math.max(cursorRef.current, event.sequence);
              setEvents((current) => compactEvents(current, event));
              if (event.type === "chapterCompleted" || event.type === "runCompleted" || event.type === "reviewRequired") {
                onProjectChangedRef.current?.();
                void load();
              }
            },
          });
        } catch (reason) {
          if (controller.signal.aborted) return;
          setError(reason instanceof Error ? reason.message : "运行流连接中断");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
    })();
    return () => controller.abort();
  }, [activeRun?.id, load, projectId, token]);

  const start = async () => {
    const chapters = Number.parseInt(targetChapters, 10);
    const chars = Number.parseInt(targetChars, 10);
    if (!Number.isInteger(chapters) || chapters < nextChapter || chapters > 9999) {
      setError(`目标章节需在 ${nextChapter} 到 9999 之间`);
      return;
    }
    if (!Number.isInteger(chars) || chars < 500 || chars > 12000) {
      setError("每章字数需在 500 到 12000 之间");
      return;
    }
    setBusy("start");
    setError("");
    try {
      const run = await startNovelAutopilotRun(token, projectId, { targetChapters: chapters, targetCharsPerChapter: chars, startChapter: nextChapter, autoReview });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setActiveRunId(run.id);
      onProjectChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "启动全托管失败");
    } finally {
      setBusy("");
    }
  };

  const control = async (action: "pause" | "resume" | "cancel" | "revise") => {
    if (!activeRun) return;
    setBusy(action);
    setError("");
    try {
      const run = await controlNovelEngineRun(token, projectId, activeRun.id, action);
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运行操作失败");
    } finally {
      setBusy("");
    }
  };

  const download = async (format: "markdown" | "docx" | "epub" | "pdf") => {
    setBusy(`export:${format}`);
    setError("");
    try {
      const blob = await exportNovelProject(token, projectId, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `novel.${format === "markdown" ? "md" : format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    } finally {
      setBusy("");
    }
  };

  const importFile = async (file: File) => {
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    if (extension !== "md" && extension !== "markdown" && extension !== "txt") {
      setError("仅支持 Markdown 或 TXT 文件");
      return;
    }
    if (!window.confirm("导入将替换当前章节；系统会先自动创建检查点。确定继续吗？")) return;
    setBusy("import");
    setError("");
    try {
      await importNovelProject(token, projectId, { format: extension === "txt" ? "text" : "markdown", content: await file.text(), mode: "replace", filename: file.name });
      onProjectChanged?.();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setBusy("");
    }
  };

  const canStart = !runs.some((run) => BOOK_LOCKING_STATUSES.has(run.status));
  const liveRun = activeRun && BOOK_LOCKING_STATUSES.has(activeRun.status) ? activeRun : null;
  const completed = liveRun?.completedChapters ?? dashboard?.stats.chapters ?? 0;
  const target = liveRun?.targetChapters ?? (Number.parseInt(targetChapters, 10) || 1);
  const percent = Math.min(100, Math.round((completed / Math.max(target, 1)) * 100));

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-hidden">
      <div className="flex-none rounded-[14px] border border-[#e8e8ed] bg-white p-4 shadow-[0_16px_44px_rgba(15,23,42,0.055)] sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-ink">Autopilot</p>
            <h3 className="mt-1 text-xl font-semibold text-[#1d1d1f]">全托管驾驶舱</h3>
            <p className="mt-1 text-sm text-[#6e6e73]">基于已锁定的 Bible 与故事树，独立 Worker 持续执行逐章写作、质检和章后同步。</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">目标章节<input value={targetChapters} onChange={(event) => setTargetChapters(event.target.value)} className="h-9 w-24 rounded-lg border border-[#d2d2d7] px-3 text-sm text-[#1d1d1f]" /></label>
            <label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">每章字数<input value={targetChars} onChange={(event) => setTargetChars(event.target.value)} className="h-9 w-24 rounded-lg border border-[#d2d2d7] px-3 text-sm text-[#1d1d1f]" /></label>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-[#d2d2d7] px-3 text-xs font-semibold"><input type="checkbox" checked={autoReview} onChange={(event) => setAutoReview(event.target.checked)} />质量通过后自动继续</label>
            {canStart && <button type="button" onClick={() => void start()} disabled={busy === "start"} className="h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">{busy === "start" ? "启动中" : "启动全托管"}</button>}
            {activeRun && ACTIVE_STATUSES.has(activeRun.status) && <button type="button" onClick={() => void control("pause")} disabled={Boolean(busy)} className="h-9 rounded-lg border border-amber-200 px-4 text-sm font-semibold text-amber-700">暂停</button>}
            {activeRun && (activeRun.status === "paused" || activeRun.status === "failed" || activeRun.status === "awaitingReview") && <button type="button" onClick={() => void control("resume")} disabled={Boolean(busy)} className="h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white">恢复</button>}
            {activeRun?.status === "awaitingReview" && <button type="button" onClick={() => void control("revise")} disabled={Boolean(busy)} className="h-9 rounded-lg border border-brand/30 px-4 text-sm font-semibold text-brand-ink disabled:opacity-50">{busy === "revise" ? "提交中" : "AI 修订重检"}</button>}
            {activeRun && !["completed", "cancelled"].includes(activeRun.status) && <button type="button" onClick={() => void control("cancel")} disabled={Boolean(busy)} className="h-9 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-600">停止</button>}
          </div>
        </div>
        <nav className="mt-5 flex gap-1 overflow-x-auto rounded-xl bg-[#f1f4f3] p-1 [scrollbar-width:none]">{([
          ["cockpit", "全托管驾驶", "mdi:steering"], ["governance", "总编辑治理", "mdi:shield-crown-outline"], ["dashboard", "数据仪表盘", "mdi:chart-box-outline"], ["operations", "监控与 DAG", "mdi:graph-outline"],
        ] as const).map(([id, label, icon]) => <button key={id} type="button" onClick={() => setView(id)} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${view === id ? "bg-white text-brand-ink shadow-sm" : "text-[#69736f]"}`}><Icon icon={icon} />{label}</button>)}</nav>
        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {view === "cockpit" && <><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["运行状态", STATUS_LABELS[activeRun?.status ?? dashboard?.project.autopilotStatus ?? ""] ?? "未启动", "mdi:engine-outline"],
            ["当前位置", liveRun?.currentChapter ? `第 ${liveRun.currentChapter} 章` : `第 ${nextChapter} 章（下一章）`, "mdi:map-marker-path"],
            ["完成章节", `${completed}/${target}`, "mdi:book-check-outline"],
            ["开放伏笔", `${dashboard?.stats.openForeshadows ?? 0} 条`, "mdi:source-branch"],
            ["叙事阶段", dashboard?.project.storyPhase ?? "opening", "mdi:chart-timeline-variant"],
          ].map(([label, value, icon]) => (
            <div key={label} className="rounded-xl border border-[#e8e8ed] bg-[#f7faf9] p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-[#8a8a8f]"><Icon icon={icon} />{label}</p>
              <p className="mt-2 truncate text-base font-semibold text-[#1d1d1f]">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#eef1f0]"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} /></div></>}
      </div>

      {view === "governance" && <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain sm:grid-cols-2 xl:grid-cols-4 [scrollbar-gutter:stable] [scrollbar-width:thin]">{[
        ["开放伏笔", dashboard?.stats.openForeshadows ?? 0, "需要在回收窗口内处理", "mdi:source-branch"],
        ["叙事债务", dashboard?.stats.debts ?? 0, "未兑现承诺与开放问题", "mdi:alert-decagram-outline"],
        ["稳定事实", dashboard?.stats.facts ?? 0, "进入章节硬约束", "mdi:graph-outline"],
        ["活跃故事线", dashboard?.stats.storylines ?? 0, "主线、支线与暗线", "mdi:timeline-text-outline"],
      ].map(([label, value, hint, icon]) => <article key={String(label)} className="rounded-2xl border border-[#e1e6e4] bg-white p-5"><Icon icon={String(icon)} className="text-2xl text-brand-ink" /><p className="mt-3 text-xs font-semibold text-[#858e8b]">{label}</p><p className="mt-1 text-3xl font-semibold">{value}</p><p className="mt-2 text-xs text-[#6e7774]">{hint}</p></article>)}</div>}

      {view === "dashboard" && <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-[#e1e6e4] bg-white p-5 [scrollbar-gutter:stable] [scrollbar-width:thin]"><div><h3 className="font-semibold">章节张力 / 质量仪表盘</h3><p className="mt-1 text-xs text-[#7d8683]">柱高为总张力，圆点显示质量门禁分。</p></div><div className="mt-6"><NovelScoreTrend rows={dashboard?.tensionCurve ?? []} /></div></section>}

      {(view === "cockpit" || view === "operations") && <div className={`min-h-0 flex-1 overscroll-contain ${view === "operations" ? "overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]" : "overflow-y-auto xl:overflow-hidden"}`}>
        <div className={`grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)] ${view === "operations" ? "min-h-[360px]" : "xl:h-full xl:min-h-0"}`}>
        <section className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-[14px] border border-[#e8e8ed] bg-white p-4 xl:min-h-0">
          <div className="flex items-center justify-between"><h3 className="font-semibold text-[#1d1d1f]">实时管线</h3><span className="text-xs text-[#8a8a8f]">步骤可断点恢复</span></div>
          {streamedDraft && <div className="mt-4 min-h-0 max-h-52 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-brand/20 bg-[#fbfefd] p-4 [scrollbar-gutter:stable] [scrollbar-width:thin]"><p className="mb-2 text-xs font-semibold text-brand-ink">正文流式预览</p><p className="whitespace-pre-wrap text-sm leading-7 text-[#343438]">{streamedDraft}</p></div>}
          <div className="mt-4 flex-none overflow-x-auto pb-2 [scrollbar-width:thin]"><div className="flex min-w-[1180px] items-center">{PIPELINE_ORDER.map((kind, index) => { const step = [...steps].reverse().find((item) => item.kind === kind); const state = step?.status ?? "waiting"; const taskProgress = step?.taskProgress; const progress = state === "running" ? Math.max(step?.progress ?? 0, taskProgress?.percent ?? 0) : step?.progress ?? 0; const heartbeatAt = taskProgress?.updatedAt ?? step?.updatedAt; const heartbeatStale = state === "running" && heartbeatAt ? Date.now() - new Date(heartbeatAt).getTime() > STEP_HEARTBEAT_STALE_MS : false; const activity = state === "running" ? taskProgress?.message || (heartbeatStale ? "心跳延迟，系统正在自动恢复" : "Worker 心跳正常，步骤执行中") : ""; return <div key={kind} className="contents"><div className={`w-32 shrink-0 rounded-2xl border p-3 text-center ${state === "running" ? "border-brand bg-brand-soft ring-2 ring-brand/15" : state === "succeeded" ? "border-emerald-200 bg-emerald-50" : state === "failed" ? "border-red-200 bg-red-50" : "border-[#e1e6e4] bg-[#fafbfb]"}`}><span className={`mx-auto grid h-8 w-8 place-items-center rounded-full text-xs font-bold ${state === "succeeded" ? "bg-emerald-500 text-white" : state === "running" ? "bg-brand text-white" : state === "failed" ? "bg-red-500 text-white" : "bg-[#e8ecea] text-[#7a8380]"}`}>{state === "succeeded" ? <Icon icon="mdi:check" /> : index + 1}</span><p className="mt-2 text-xs font-semibold">{STEP_LABELS[kind]}</p><p className="mt-1 text-[10px] text-[#7a8380]">{state === "waiting" ? "等待" : state} · {Math.round(progress)}%</p>{activity && <p className={`mt-1 line-clamp-3 text-[9px] ${heartbeatStale ? "text-amber-700" : "text-brand-ink"}`}>{activity}</p>}{taskProgress && taskProgress.streamedChars > 0 && <p className="mt-1 text-[9px] text-[#64706b]">已接收 {taskProgress.streamedChars.toLocaleString("zh-CN")} 字</p>}{step?.error && <p className="mt-1 line-clamp-2 text-[9px] text-red-600">{step.error}</p>}</div>{index < PIPELINE_ORDER.length - 1 && <div className={`h-0.5 w-5 shrink-0 ${state === "succeeded" ? "bg-emerald-400" : "bg-[#dfe4e2]"}`}><Icon icon="mdi:chevron-right" className="-ml-0.5 -mt-[9px] text-lg text-[#9aa29f]" /></div>}</div>; })}</div></div>
        </section>
        <section className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-[14px] border border-[#20252b] bg-[#111418] p-4 text-[#d7e0e8] xl:min-h-0">
          <div className="flex flex-none items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-[#59d5c5] shadow-[0_0_0_4px_rgba(89,213,197,0.1)]" />运行日志</h3><span className="whitespace-nowrap text-[10px] text-[#7f8b96]">SSE 实时跟随 · #{cursorRef.current}</span></div>
          <div ref={logScrollRef} onScroll={(event) => { const element = event.currentTarget; logFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }} className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 font-mono text-xs leading-5 [scrollbar-gutter:stable] [scrollbar-width:thin]">
            {logEvents.map((event) => <p key={event.id} className="break-words"><span className="text-[#6ed7c8]" title={new Date(event.createdAt).toLocaleString("zh-CN")}>[{novelRunEventTime(event.createdAt)}]</span> <span className="text-[#8da2b3]">{novelRunEventScope(event)}</span> {novelRunEventText(event)}</p>)}
            {logEvents.length === 0 && events.length > 0 && <p className="text-[#7f8b96]">正文正在流式生成，流程事件将在步骤完成后继续更新…</p>}
            {events.length === 0 && <p className="text-[#7f8b96]">正在加载最近运行事件…</p>}
          </div>
        </section>
        </div>
        <div className={`mt-4 gap-4 ${view === "operations" ? "grid" : "hidden"}`}>
          {runs.length > 1 && <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-4"><h3 className="text-sm font-semibold text-[#1d1d1f]">运行历史</h3><div className="mt-3 flex gap-2 overflow-x-auto">{runs.map((run) => <button key={run.id} type="button" onClick={() => setActiveRunId(run.id)} className={`shrink-0 rounded-lg border px-3 py-2 text-left text-xs ${activeRun?.id === run.id ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-[#e8e8ed]"}`}><span className="block font-semibold">{run.mode === "autopilot" ? "全托管" : "辅助写作"} · {STATUS_LABELS[run.status] ?? run.status}</span><span className="mt-1 block text-[#8a8a8f]">{new Date(run.createdAt).toLocaleString("zh-CN")}</span></button>)}</div></section>}
          <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-semibold text-[#1d1d1f]">作品导入与导出</h3><p className="mt-1 text-xs text-[#8a8a8f]">导入 Markdown/TXT，或按当前章节顺序生成整书文件</p></div><div className="flex flex-wrap gap-2"><label className={`flex h-9 cursor-pointer items-center rounded-lg border border-brand/30 px-3 text-xs font-semibold text-brand-ink ${busy ? "pointer-events-none opacity-50" : ""}`}>{busy === "import" ? "导入中" : "导入 Markdown"}<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} /></label>{(["markdown", "docx", "epub", "pdf"] as const).map((format) => <button key={format} type="button" disabled={Boolean(busy)} onClick={() => void download(format)} className="h-9 rounded-lg border border-[#d2d2d7] px-3 text-xs font-semibold uppercase text-[#4f4f55] disabled:opacity-50">{busy === `export:${format}` ? "导出中" : format}</button>)}</div></div></section>
        </div>
      </div>}
    </section>
  );
}
