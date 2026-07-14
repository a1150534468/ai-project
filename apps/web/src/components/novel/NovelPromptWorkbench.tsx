import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { listModels, listNovelPrompts, rollbackNovelPrompt, saveNovelPrompt, type NovelPromptTemplate } from "../../api";

const DEFAULT_CONTENT = "你是中文长篇小说创作助手。\n\n作品：{{projectTitle}}\n当前章节：{{chapterNumber}}\n章节任务：{{chapterPlan}}\n\n请遵守叙事契约、人物状态与世界规则。";

export function NovelPromptWorkbench({ token, projectId }: { readonly token: string; readonly projectId: string }) {
  const [templates, setTemplates] = useState<NovelPromptTemplate[]>([]);
  const [models, setModels] = useState<Array<{ model: string; displayName: string }>>([]);
  const [selectedId, setSelectedId] = useState("");
  const [nodeKey, setNodeKey] = useState("chapter-writing");
  const [name, setName] = useState("章节写作");
  const [category, setCategory] = useState("writing");
  const [content, setContent] = useState(DEFAULT_CONTENT);
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selected = useMemo(() => templates.find((item) => item.id === selectedId) ?? null, [selectedId, templates]);

  const load = async () => {
    const [nextTemplates, nextModels] = await Promise.all([listNovelPrompts(token, projectId), listModels().catch(() => [])]);
    setTemplates(nextTemplates);
    setModels(nextModels);
    setSelectedId((current) => nextTemplates.some((item) => item.id === current) ? current : nextTemplates[0]?.id ?? "");
  };

  useEffect(() => { void load(); }, [projectId, token]);

  useEffect(() => {
    if (!selected) return;
    setNodeKey(selected.nodeKey);
    setName(selected.name);
    setCategory(selected.category);
    setContent(selected.content);
    setModel(selected.model);
    setTemperature(String(selected.temperature));
  }, [selected?.id, selected?.activeVersion]);

  const newTemplate = () => {
    setSelectedId("");
    setNodeKey(`custom-${Date.now()}`);
    setName("自定义提示词");
    setCategory("custom");
    setContent(DEFAULT_CONTENT);
    setModel(models[0]?.model ?? "");
    setTemperature("0.7");
  };

  const save = async () => {
    const numericTemperature = Number(temperature);
    if (!nodeKey.trim() || !name.trim() || !content.trim() || !Number.isFinite(numericTemperature)) {
      setMessage("请完整填写提示词信息");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const saved = await saveNovelPrompt(token, projectId, { nodeKey: nodeKey.trim(), name: name.trim(), category: category.trim() || "custom", content, variables: Array.from(content.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)).map((match) => match[1]!), model, temperature: numericTemperature, changeNote: selected ? "工作台编辑" : "创建模板" });
      await load();
      setSelectedId(saved.id);
      setMessage("已创建新版本");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (version: number) => {
    if (!selected) return;
    setBusy(true);
    try {
      await rollbackNovelPrompt(token, projectId, selected.id, version);
      await load();
      setMessage(`已回滚到 v${version}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "回滚失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-ink">Prompt Studio</p><h3 className="mt-1 text-lg font-semibold text-[#1d1d1f]">提示词工作台</h3><p className="mt-1 text-sm text-[#6e6e73]">项目级覆盖、变量识别、模型绑定、版本和回滚。</p></div><button type="button" onClick={newTemplate} className="h-9 rounded-lg border border-brand/30 px-3 text-xs font-semibold text-brand-ink"><Icon icon="mdi:plus" className="mr-1 inline" />新建模板</button></div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_240px]">
        <div className="grid max-h-[480px] content-start gap-2 overflow-y-auto [scrollbar-width:thin]">{templates.map((template) => <button key={template.id} type="button" onClick={() => setSelectedId(template.id)} className={`rounded-lg border p-3 text-left ${selectedId === template.id ? "border-brand/40 bg-brand-soft" : "border-[#e8e8ed]"}`}><span className="block text-sm font-semibold">{template.name}</span><span className="mt-1 block text-xs text-[#8a8a8f]">{template.category} · v{template.activeVersion}</span></button>)}{!templates.length && <p className="rounded-lg border border-dashed border-[#d2d2d7] py-8 text-center text-xs text-[#8a8a8f]">暂无项目提示词</p>}</div>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">节点 Key<input value={nodeKey} onChange={(event) => setNodeKey(event.target.value)} className="h-9 rounded-lg border border-[#d2d2d7] px-3 text-sm" /></label><label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">名称<input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-lg border border-[#d2d2d7] px-3 text-sm" /></label><label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">分类<input value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 rounded-lg border border-[#d2d2d7] px-3 text-sm" /></label></div>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={18} className="w-full resize-y rounded-lg border border-[#d2d2d7] bg-[#fbfefd] p-4 font-mono text-sm leading-6 outline-none focus:border-brand/60" />
          <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">平台模型<select value={model} onChange={(event) => setModel(event.target.value)} className="h-9 min-w-48 rounded-lg border border-[#d2d2d7] px-3 text-sm"><option value="">系统默认</option>{models.map((item) => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}</select></label><label className="grid gap-1 text-xs font-semibold text-[#6e6e73]">Temperature<input value={temperature} onChange={(event) => setTemperature(event.target.value)} className="h-9 w-24 rounded-lg border border-[#d2d2d7] px-3 text-sm" /></label><button type="button" onClick={() => void save()} disabled={busy} className="h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "保存中" : "保存新版本"}</button>{message && <span className="text-xs text-[#6e6e73]">{message}</span>}</div>
        </div>
        <div><h4 className="text-sm font-semibold text-[#1d1d1f]">版本历史</h4><div className="mt-3 grid max-h-[430px] gap-2 overflow-y-auto [scrollbar-width:thin]">{selected?.versions.map((version) => <div key={version.id} className="rounded-lg border border-[#e8e8ed] p-3"><div className="flex items-center justify-between"><span className="text-sm font-semibold">v{version.version}</span>{version.version !== selected.activeVersion && <button type="button" onClick={() => void rollback(version.version)} disabled={busy} className="text-xs font-semibold text-brand-ink">回滚</button>}</div><p className="mt-1 text-xs text-[#8a8a8f]">{version.changeNote || new Date(version.createdAt).toLocaleString("zh-CN")}</p></div>)}{!selected?.versions.length && <p className="text-xs text-[#8a8a8f]">保存后生成版本记录</p>}</div></div>
      </div>
    </section>
  );
}
