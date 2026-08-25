import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { InAppSelect } from "../agent-teams/InAppSelect";
import { listModels } from "../../api";
import { pickInitialModel, type ModelOption } from "../../chatState";
import {
  listScheduledTasks, createScheduledTask, updateScheduledTask, deleteScheduledTask,
  listScheduledTaskRuns, aiDraftScheduledTask, type ScheduledTask, type ScheduledTaskRun,
} from "../../scheduledApi";
import { presetToCron, humanizeSchedule, draftToFormPatch, type SchedulePreset } from "../../scheduledState";

interface Props { readonly token: string; }

const DEFAULT_TZ = "Asia/Shanghai";
const CARD = "rounded-[10px] border border-hairline-subtle bg-white p-4";

export function ScheduledTaskStudio({ token }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("MiniMax-M3");
  const [emailTo, setEmailTo] = useState("");
  const [preset, setPreset] = useState<SchedulePreset>({ kind: "daily", hour: 8, minute: 0 });
  const [oneShot, setOneShot] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openRuns, setOpenRuns] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [aiDesc, setAiDesc] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const reload = async () => setTasks(await listScheduledTasks(token));
  useEffect(() => { void reload(); }, [token]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await listModels();
        setModels(list);
        setModel((prev) => pickInitialModel(list, prev));
      } catch { /* 拉取失败保持手填默认值，不阻塞 */ }
    })();
  }, []);

  const submit = async () => {
    setErr(null);
    try {
      await createScheduledTask(token, {
        title, prompt, model, emailTo, cron: presetToCron(preset), timezone: DEFAULT_TZ, oneShot,
      });
      setTitle(""); setPrompt(""); await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "创建失败"); }
  };

  const generateFromAi = async () => {
    if (!aiDesc.trim()) return;
    setErr(null);
    setAiLoading(true);
    try {
      const draft = await aiDraftScheduledTask(token, aiDesc.trim());
      const patch = draftToFormPatch(draft);
      setTitle(patch.title);
      setPrompt(patch.prompt);
      if (models.some((m) => m.model === patch.model)) setModel(patch.model);
      setEmailTo(patch.emailTo);
      setOneShot(patch.oneShot);
      setPreset(patch.preset);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI 生成失败");
    } finally {
      setAiLoading(false);
    }
  };

  const toggle = async (t: ScheduledTask) => {
    try {
      await updateScheduledTask(token, t.id, { enabled: !t.enabled });
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "操作失败"); }
  };
  const remove = async (id: string) => {
    try {
      await deleteScheduledTask(token, id);
      await reload();
    } catch (e) { setErr(e instanceof Error ? e.message : "删除失败"); }
  };

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink">
          <Icon icon="mdi:calendar-clock-outline" /> 新建定时任务
        </h3>
        <div className="grid gap-3">
          <div className="flex items-center gap-2 rounded-[8px] border border-dashed border-brand/40 bg-brand/5 p-2">
            <input
              className="flex-1 rounded-[8px] border border-hairline-subtle bg-white px-3 py-2 text-sm placeholder-[#8a8a8f]"
              placeholder="用一句话描述需求，AI 帮你填好"
              value={aiDesc}
              onChange={(e) => setAiDesc(e.target.value)}
            />
            <button
              type="button"
              disabled={aiLoading || !aiDesc.trim()}
              className="inline-flex flex-none items-center gap-1 rounded-full bg-brand px-3 py-2 text-sm font-medium text-white transition disabled:opacity-40"
              onClick={() => void generateFromAi()}
            >
              <Icon icon={aiLoading ? "mdi:loading" : "mdi:auto-fix"} className={aiLoading ? "animate-spin" : ""} /> AI 生成
            </button>
          </div>
          <input className="w-full rounded-[8px] border border-hairline-subtle px-3 py-2 text-sm placeholder-[#8a8a8f]" placeholder="任务名称" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="w-full resize-y rounded-[8px] border border-hairline-subtle px-3 py-2 text-sm placeholder-[#8a8a8f]" rows={3} placeholder="到点执行的指令" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <InAppSelect
            icon="mdi:robot-outline"
            label="模型"
            value={model}
            options={models.length > 0 ? models.map((m) => ({ value: m.model, label: m.displayName, description: m.model })) : [{ value: model, label: model }]}
            onChange={setModel}
          />
          <input className="w-full rounded-[8px] border border-hairline-subtle px-3 py-2 text-sm placeholder-[#8a8a8f]" placeholder="收件邮箱" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-secondary">每天</span>
            <input type="number" min={0} max={23} className="w-16 rounded-[8px] border border-hairline-subtle px-2 py-1 text-center text-sm" value={preset.kind === "daily" ? preset.hour : 8}
              onChange={(e) => setPreset({ kind: "daily", hour: Number(e.target.value), minute: preset.kind === "daily" ? preset.minute : 0 })} />
            <span className="text-ink-secondary">时</span>
            <input type="number" min={0} max={59} className="w-16 rounded-[8px] border border-hairline-subtle px-2 py-1 text-center text-sm" value={preset.kind === "daily" ? preset.minute : 0}
              onChange={(e) => setPreset({ kind: "daily", hour: preset.kind === "daily" ? preset.hour : 8, minute: Number(e.target.value) })} />
            <span className="text-ink-secondary">分（{DEFAULT_TZ}）</span>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} /> 仅执行一次</label>
          {err && <p className="text-sm text-[#d4380d]">{err}</p>}
          <button className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand px-4 py-2 font-medium text-white transition disabled:opacity-40" onClick={() => void submit()}>
            <Icon icon="mdi:plus" /> 创建
          </button>
        </div>
      </section>

      <section className="space-y-3">
        {tasks.map((t) => (
          <div key={t.id} className={CARD}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="font-semibold text-ink">{t.title}</p>
                <p className="text-xs text-ink-secondary">{humanizeSchedule(t.cron)}｜下次 {new Date(t.nextRunAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                <button className="text-xs text-ink-secondary transition " onClick={() => void toggle(t)}>{t.enabled ? "暂停" : "启用"}</button>
                <button className="text-xs text-[#d4380d] transition " onClick={() => void remove(t.id)}>删除</button>
                <button className="text-xs text-brand transition " onClick={() => void listScheduledTaskRuns(token, t.id).then((r) => setOpenRuns((m) => ({ ...m, [t.id]: r }))).catch((e) => setErr(e instanceof Error ? e.message : "获取运行记录失败"))}>记录</button>
              </div>
            </div>
            {openRuns[t.id] && (
              <div className="mt-3 space-y-2 border-t border-hairline-subtle pt-3">
                {openRuns[t.id].length === 0 && <p className="text-xs text-ink-tertiary">暂无运行记录</p>}
                {openRuns[t.id].map((run) => (
                  <details key={run.id} className="text-xs">
                    <summary className="cursor-pointer text-ink-secondary">
                      {new Date(run.triggeredAt).toLocaleString()} — {run.status}{run.skipReason ? `（${run.skipReason}）` : ""}｜邮件 {run.emailStatus ?? "-"}
                    </summary>
                    {run.reportText && <div className="mt-2 rounded-[8px] bg-[#f5f5f7] p-2 text-ink" dangerouslySetInnerHTML={{ __html: run.reportText }} />}
                  </details>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
