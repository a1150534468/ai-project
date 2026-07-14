import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  completeNovelSetup,
  generateNovelSetup,
  getNovelSetup,
  saveNovelSetup,
  type NovelProjectDetail,
  type NovelSetupKind,
  type NovelSetupPayload,
} from "../../api";

const STEPS: readonly { kind: NovelSetupKind | "complete"; title: string; description: string; icon: string }[] = [
  { kind: "bible", title: "文风 / 世界观", description: "文风公约与五维世界", icon: "mdi:book-open-variant" },
  { kind: "characters", title: "人物", description: "主要人物与关系", icon: "mdi:account-group-outline" },
  { kind: "locations", title: "地图", description: "地点系统与空间关系", icon: "mdi:map-outline" },
  { kind: "plot", title: "剧情总纲", description: "故事线与部卷幕章", icon: "mdi:graph-outline" },
  { kind: "complete", title: "开始", description: "进入作品工作台", icon: "mdi:rocket-launch-outline" },
];

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function setupDraft(setup: NovelSetupPayload | null, kind: NovelSetupKind): unknown {
  if (!setup) return {};
  if (kind === "bible") {
    const bible = record(setup.bible);
    const styleGuide = Object.fromEntries((Array.isArray(bible.styleNotes) ? bible.styleNotes : []).map((item) => {
      const row = record(item);
      return [text(row.category), text(row.content)];
    }).filter(([key]) => key));
    const worldbuilding = Object.fromEntries((Array.isArray(bible.worldDimensions) ? bible.worldDimensions : []).map((item) => {
      const row = record(item);
      return [text(row.dimensionKey), { summary: text(row.summary), ...record(row.details) }];
    }).filter(([key]) => key));
    return { styleGuide, worldbuilding };
  }
  if (kind === "characters") return { characters: setup.characters, relations: setup.relations };
  if (kind === "locations") return { locations: setup.locations };
  return { storylines: setup.storylines, structure: setup.structure, chapters: setup.chapters };
}

function hasResult(setup: NovelSetupPayload | null, kind: NovelSetupKind): boolean {
  if (!setup) return false;
  if (kind === "bible") return Boolean(setup.bible && Array.isArray(record(setup.bible).worldDimensions) && (record(setup.bible).worldDimensions as unknown[]).length);
  if (kind === "characters") return setup.characters.length > 0;
  if (kind === "locations") return setup.locations.length > 0;
  return setup.chapters.length > 0 && setup.structure.length > 0;
}

function Preview({ setup, kind }: { readonly setup: NovelSetupPayload; readonly kind: NovelSetupKind }) {
  if (kind === "bible") {
    const bible = record(setup.bible);
    const styles = Array.isArray(bible.styleNotes) ? bible.styleNotes.map(record) : [];
    const dimensions = Array.isArray(bible.worldDimensions) ? bible.worldDimensions.map(record) : [];
    return <div className="grid gap-4"><section className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-[#26302d]"><Icon icon="mdi:feather" className="text-brand-ink" />文风公约</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{styles.map((item, index) => <div key={text(item.id) || index} className="rounded-xl bg-[#f6f8f7] p-3"><p className="text-xs font-semibold text-brand-ink">{text(item.title) || text(item.category)}</p><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#5f6966]">{text(item.content)}</p></div>)}</div></section><section className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-[#26302d]"><Icon icon="mdi:earth" className="text-brand-ink" />五维世界观</h4><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{dimensions.map((item, index) => <div key={text(item.id) || index} className="rounded-xl border border-[#e8ecea] p-3"><p className="text-xs font-semibold text-[#26302d]">{text(item.title)}</p><p className="mt-1 line-clamp-5 text-xs leading-5 text-[#65706c]">{text(item.summary) || JSON.stringify(item.details)}</p></div>)}</div></section></div>;
  }
  if (kind === "characters") return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{setup.characters.map((item, index) => <article key={text(item.id) || index} className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-brand-soft font-semibold text-brand-ink">{text(item.name).slice(0, 1) || "?"}</div><div><h4 className="text-sm font-semibold text-[#26302d]">{text(item.name) || "未命名人物"}</h4><p className="text-xs text-brand-ink">{text(item.role) || "人物"}</p></div></div><p className="mt-3 line-clamp-4 text-xs leading-5 text-[#65706c]">{text(item.coreMotivation) || text(item.description) || "等待补充人物锚点"}</p></article>)}</div>;
  if (kind === "locations") return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{setup.locations.map((item, index) => <article key={text(item.id) || index} className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><Icon icon="mdi:map-marker-radius-outline" className="text-xl text-brand-ink" /><h4 className="mt-2 text-sm font-semibold text-[#26302d]">{text(item.name) || "未命名地点"}</h4><p className="mt-2 line-clamp-4 text-xs leading-5 text-[#65706c]">{text(item.description)}</p><p className="mt-2 text-[11px] text-[#8a928f]">规则：{text(item.rules) || "待补充"}</p></article>)}</div>;
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"><section className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><h4 className="text-sm font-semibold text-[#26302d]">部 · 卷 · 幕 · 章</h4><div className="mt-3 grid max-h-96 gap-2 overflow-y-auto [scrollbar-width:thin]">{setup.structure.map((node) => <div key={node.id} className="rounded-xl border border-[#e8ecea] px-3 py-2" style={{ marginLeft: node.nodeType === "volume" ? 8 : node.nodeType === "act" ? 20 : node.nodeType === "chapter" ? 32 : 0 }}><p className="text-xs font-semibold text-[#303936]">{node.nodeType} · {node.title}</p><p className="mt-1 line-clamp-2 text-[11px] text-[#7a8380]">{node.outline || node.description}</p></div>)}</div></section><section className="rounded-2xl border border-[#e2e7e5] bg-white p-4"><h4 className="text-sm font-semibold text-[#26302d]">故事线</h4><div className="mt-3 grid gap-2">{setup.storylines.map((item, index) => <div key={text(item.id) || index} className="rounded-xl bg-[#f6f8f7] p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold text-[#303936]">{text(item.title)}</p><span className="text-[10px] font-semibold text-brand-ink">{text(item.storylineType)}</span></div><p className="mt-1 line-clamp-3 text-[11px] leading-5 text-[#6c7572]">{text(item.goal) || text(item.conflict)}</p></div>)}</div></section></div>;
}

export function NovelSetupWizard({ token, project, onClose, onCompleted, onBalanceRefresh }: { readonly token: string; readonly project: NovelProjectDetail["project"]; readonly onClose: () => void; readonly onCompleted: () => void; readonly onBalanceRefresh?: () => void }) {
  const [setup, setSetup] = useState<NovelSetupPayload | null>(null);
  const [step, setStep] = useState(Math.max(1, Math.min(5, project.setupStage || 1)));
  const [editor, setEditor] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const current = STEPS[step - 1]!;
  const kind = current.kind === "complete" ? null : current.kind;

  const load = useCallback(async () => {
    const next = await getNovelSetup(token, project.id);
    setSetup(next);
    if (!next.activeTask && next.project.setupStage > step) setStep(Math.min(5, next.project.setupStage));
    return next;
  }, [project.id, step, token]);

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : "加载新书设置失败")); }, [load]);
  useEffect(() => {
    if (!setup?.activeTask) return undefined;
    const timer = window.setInterval(() => void load().catch(() => undefined), 1800);
    return () => window.clearInterval(timer);
  }, [load, setup?.activeTask?.id]);
  useEffect(() => {
    if (!kind || !setup) return;
    setEditor(JSON.stringify(setupDraft(setup, kind), null, 2));
    setEditing(false);
  }, [kind, setup, step]);

  const generated = kind ? hasResult(setup, kind) : false;
  const generating = Boolean(setup?.activeTask);
  const prompt = useMemo(() => kind ? `请基于《${project.title}》已锁定的梗概和前序资料，生成${current.title}。` : "", [current.title, kind, project.title]);

  const generate = async () => {
    if (!kind) return;
    setBusy("generate"); setError("");
    try { await generateNovelSetup(token, project.id, kind, prompt); await load(); onBalanceRefresh?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "生成失败"); }
    finally { setBusy(""); }
  };
  const saveAndNext = async () => {
    if (!kind) return;
    if (!editing) {
      setStep(Math.min(5, step + 1));
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(editor); } catch { setError("编辑内容不是有效 JSON，请检查格式"); return; }
    setBusy("save"); setError("");
    try { await saveNovelSetup(token, project.id, kind, parsed); const next = await load(); setStep(Math.min(5, Math.max(step + 1, next.project.setupStage))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(""); }
  };
  const complete = async () => {
    setBusy("complete"); setError("");
    try { await completeNovelSetup(token, project.id); onCompleted(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "完成设置失败"); }
    finally { setBusy(""); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#101615]/55 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="新书设置向导">
      <section className="grid max-h-[94dvh] w-full max-w-[1120px] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-3xl bg-[#f5f7f6] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-[#e1e5e3] bg-white px-5 py-4 sm:px-6"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-ink">New book setup</p><h2 className="mt-1 text-xl font-semibold text-[#202825]">《{project.title}》设置向导</h2><p className="mt-1 text-xs text-[#7c8582]">每一步都可以生成、修改、确认，进度会自动保留。</p></div><button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d9dfdd] text-[#65706c]" aria-label="关闭"><Icon icon="mdi:close" /></button></header>
        <nav className="flex gap-1 overflow-x-auto border-b border-[#e1e5e3] bg-white px-4 py-3 [scrollbar-width:none]">{STEPS.map((item, index) => { const active = index + 1 === step; const complete = index + 1 < step || (setup?.project.setupCompleted && index === 4); return <button key={item.kind} type="button" onClick={() => index + 1 <= Math.max(step, setup?.project.setupStage ?? 1) && setStep(index + 1)} className={`flex min-w-[170px] flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left transition ${active ? "bg-brand-soft ring-1 ring-brand/25" : complete ? "bg-[#f5f7f6]" : "opacity-55"}`}><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm ${active ? "bg-brand text-white" : complete ? "bg-emerald-100 text-emerald-700" : "bg-[#edf0ef] text-[#7a8380]"}`}><Icon icon={complete ? "mdi:check" : item.icon} /></span><span><span className="block text-xs font-semibold text-[#303936]">{index + 1}. {item.title}</span><span className="mt-0.5 block text-[10px] text-[#818986]">{item.description}</span></span></button>; })}</nav>
        <main className="min-h-0 overflow-y-auto p-4 sm:p-6 [scrollbar-width:thin]">
          {error && <p className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
          {current.kind === "complete" ? <div className="grid min-h-96 place-items-center text-center"><div><div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-brand-soft text-4xl text-brand-ink"><Icon icon="mdi:rocket-launch-outline" /></div><h3 className="mt-5 text-xl font-semibold text-[#25302d]">叙事基座已经就绪</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[#6c7572]">Bible、人物、地点和故事树已写入作品数据。进入工作台后，可以从第一章的执行剧本开始辅助创作，也可以启动全托管。</p><button type="button" onClick={() => void complete()} disabled={Boolean(busy)} className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-6 text-sm font-semibold text-white disabled:opacity-50"><Icon icon={busy ? "mdi:loading" : "mdi:arrow-right"} className={busy ? "animate-spin" : ""} />进入作品工作台</button></div></div> : generating ? <div className="grid min-h-96 place-items-center text-center"><div><div className="relative mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-brand-soft text-4xl text-brand-ink"><Icon icon={current.icon} /><span className="absolute -bottom-1 -right-1 h-6 w-6 animate-spin rounded-full border-2 border-white border-t-brand bg-white" /></div><h3 className="mt-5 text-lg font-semibold text-[#25302d]">正在生成{current.title}</h3><p className="mt-2 text-sm text-[#6c7572]">独立 Novel Worker 正在处理，关闭向导也不会中断。</p><div className="mx-auto mt-5 h-2 w-72 overflow-hidden rounded-full bg-[#e5e9e7]"><div className="h-full w-2/3 animate-pulse rounded-full bg-brand" /></div></div></div> : generated && setup && !editing ? <Preview setup={setup} kind={current.kind} /> : editing ? <div className="grid gap-3"><div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold text-[#2c3532]">编辑本步结构化数据</h3><p className="mt-1 text-xs text-[#7c8582]">保存后直接覆盖本步骤的作品数据，不经过旧阶段文本块。</p></div><button type="button" onClick={() => setEditing(false)} className="h-9 rounded-xl border border-[#d9dfdd] bg-white px-3 text-xs font-semibold">返回预览</button></div><textarea value={editor} onChange={(event) => setEditor(event.currentTarget.value)} rows={24} className="w-full resize-y rounded-2xl border border-[#d9dfdd] bg-[#111816] p-4 font-mono text-xs leading-6 text-[#d9ebe5] outline-none focus:border-brand" /></div> : <div className="grid min-h-96 place-items-center text-center"><div><div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-brand-soft text-4xl text-brand-ink"><Icon icon={current.icon} /></div><h3 className="mt-5 text-lg font-semibold text-[#25302d]">准备生成{current.title}</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[#6c7572]">AI 会基于已锁定梗概与前序确认结果生成结构化资料，完成后可逐项检查和修改。</p><button type="button" onClick={() => void generate()} disabled={Boolean(busy)} className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-white disabled:opacity-50"><Icon icon={busy ? "mdi:loading" : "mdi:creation-outline"} className={busy ? "animate-spin" : ""} />开始生成</button></div></div>}
        </main>
          {current.kind !== "complete" && <footer className="flex flex-col gap-3 border-t border-[#e1e5e3] bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-[#7c8582]">{generated ? setup?.project.setupCompleted ? "作品已启用；可修改结构化资料，AI 重生成请在对应工作区执行。" : "已生成，可逐项修改并确认进入下一步。" : "生成结果会直接保存到新小说领域模型。"}</p><div className="flex flex-wrap gap-2">{generated && <><button type="button" onClick={() => setEditing((value) => !value)} className="h-10 rounded-xl border border-[#d9dfdd] px-4 text-xs font-semibold text-[#4f5956]"><Icon icon="mdi:pencil-outline" className="mr-1 inline" />{editing ? "预览" : "修改"}</button>{!setup?.project.setupCompleted && <button type="button" onClick={() => void generate()} disabled={Boolean(busy)} className="h-10 rounded-xl border border-brand/30 px-4 text-xs font-semibold text-brand-ink">重新生成</button>}<button type="button" onClick={() => void saveAndNext()} disabled={Boolean(busy)} className="h-10 rounded-xl bg-brand px-5 text-xs font-semibold text-white disabled:opacity-50">{busy === "save" ? "保存中" : setup?.project.setupCompleted ? "保存修改" : "确认并继续"}<Icon icon="mdi:arrow-right" className="ml-1 inline" /></button></>}</div></footer>}
      </section>
    </div>
  );
}
