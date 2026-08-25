import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useToast } from "../../motion";
import { MarkdownMessage } from "../MarkdownMessage";
import {
  analyzeMaterialsApi,
  analyzeReferenceApi,
  generateScriptApi,
  listAnalyzePricing,
  type AnalyzePricing,
  type MaterialInsight,
  type ReferenceBreakdown,
} from "../../videoApi";

export interface WizardMaterial {
  readonly url: string;
  readonly mime: string;
  readonly name: string;
  readonly durationSec: number;
}

interface HelpWriteWizardProps {
  readonly token: string;
  readonly open: boolean;
  readonly materials: readonly WizardMaterial[];
  readonly durationSec: number;
  readonly onClose: () => void;
  readonly onApply: (script: string, opts: { hasNarration: boolean }) => void;
}

type Stage = "confirm" | "analyzing" | "insight" | "creating" | "generating" | "preview";
type InsightKey = "features" | "sellingPoints" | "audience" | "scenes";

const REF_MAX_BYTES = 50 * 1024 * 1024;

const BUSINESS = ["电商带货", "同城到店", "上门服务", "教育培训"];
const LANGUAGE = ["中文", "英文", "泰国", "马来西亚", "巴西", "不限"];
const CONTENT_TYPES = ["智能匹配", "带货", "种草", "卖点钩子", "剧情演绎", "生活记录"];
const SHOOT_TYPES = ["智能匹配", "桌拍开箱", "真人口播", "一镜到底", "运动跟拍", "品牌TVC"];
const REF_REQUIREMENTS: Array<{ icon: string; title: string; desc: string }> = [
  { icon: "mdi:clock-outline", title: "30 秒以内", desc: "内容聚焦，分析更精准" },
  { icon: "mdi:image-outline", title: "画面清晰", desc: "便于识别商品与字幕" },
  { icon: "mdi:file-document-outline", title: "内容完整", desc: "包含开场、卖点和结尾" },
  { icon: "mdi:brush-outline", title: "风格可参考", desc: "方向和目标人群尽量相关" },
];
const REF_TAGS = ["带货视频", "种草视频", "产品展示", "口播参考", "场景氛围"];

const STEPS: Array<{ title: string; sub: string }> = [
  { title: "分析素材", sub: "分析素材内容" },
  { title: "创作脚本", sub: "选择创作方向与脚本偏好" },
  { title: "预览脚本", sub: "确认脚本并应用" },
];

function stepIndexOf(stage: Stage): number {
  if (stage === "confirm" || stage === "analyzing" || stage === "insight") return 0;
  if (stage === "preview") return 2;
  return 1;
}

function StepRail({ active }: { active: number }) {
  return (
    <aside className="w-[220px] shrink-0 border-r border-hairline-subtle bg-surface-subtle p-5">
      <div className="flex items-center gap-2 pb-5">
        <Icon icon="mdi:auto-fix" className="text-lg text-ink" aria-hidden />
        <span className="text-[15px] font-semibold text-ink">帮我写</span>
      </div>
      <ol className="grid gap-6">
        {STEPS.map((step, i) => {
          const done = i < active;
          const on = i === active;
          return (
            <li key={step.title} className="flex gap-3">
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${on ? "bg-surface-inverse text-ink-inverse" : done ? "bg-surface-inverse text-ink-inverse" : "bg-surface-muted text-ink-tertiary"}`}>
                {done ? <Icon icon="mdi:check" className="text-sm" aria-hidden /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13.5px] font-semibold ${on || done ? "text-ink" : "text-ink-tertiary"}`}>{step.title}</span>
                <span className={`block text-[11.5px] ${on || done ? "text-ink-tertiary" : "text-ink-tertiary"}`}>{step.sub}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

const ANALYZE_MESSAGES = [
  "正在读取素材…",
  "正在理解画面内容…",
  "正在识别主体与卖点…",
  "正在归纳商品洞察…",
  "视频分析稍慢，马上就好…",
];
const SCRIPT_MESSAGES = [
  "正在构思分镜结构…",
  "正在编排镜头与运镜…",
  "正在打磨口播与字幕…",
  "正在配置音效与 BGM…",
  "马上就好…",
];

// 不确定进度动画：双层旋转弧 + 脉冲图标 + 循环文案 + 已用秒数。避免"卡在某个百分比"的观感。
function WizardLoader({ messages, hint, icon = "mdi:auto-fix" }: { messages: string[]; hint: string; icon?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const msg = messages[Math.min(Math.floor(elapsed / 5), messages.length - 1)];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="relative grid h-[132px] w-[132px] place-items-center">
        <span className="absolute inset-0 rounded-full border-[7px] border-hairline-subtle" />
        <span className="absolute inset-0 animate-spin rounded-full border-[7px] border-transparent border-t-brand" style={{ animationDuration: "1s" }} />
        <span className="absolute inset-[10px] animate-spin rounded-full border-[3px] border-transparent border-b-brand/35" style={{ animationDuration: "1.6s", animationDirection: "reverse" }} />
        <Icon icon={icon} className="animate-pulse text-3xl text-brand" aria-hidden />
      </div>
      <div className="text-center">
        <p className="text-[15px] font-medium text-ink">{msg}</p>
        <p className="mt-1.5 text-xs text-ink-tertiary">已用时 {elapsed}s · {hint}</p>
      </div>
    </div>
  );
}

// 可增删改的 chip 列表编辑器（产品特性/核心卖点/目标人群/使用场景）。
function ChipListEditor({ title, items, onChange }: { title: string; items: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="rounded-[14px] border border-hairline-subtle bg-surface-subtle p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="h-3.5 w-[3px] rounded-full bg-brand" aria-hidden />
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <span className="ml-auto text-[11px] font-medium text-ink-tertiary">{items.length}</span>
      </div>
      <div className="grid gap-1.5">
        {items.map((item, i) => (
          <div key={`${item}-${i}`} className="group flex items-center gap-2 rounded-[8px] border border-hairline-subtle bg-white px-3 py-2 transition focus-within:border-brand">
            <input
              value={item}
              onChange={(e) => onChange(items.map((it, idx) => (idx === i ? e.target.value : it)))}
              className="min-w-0 flex-1 rounded-none border-0 bg-transparent text-[13px] leading-5 text-ink outline-none"
            />
            <button type="button" aria-label={`删除 ${item}`} onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="shrink-0 text-ink-tertiary opacity-100 transition group-focus-within:opacity-100">
              <Icon icon="mdi:close" className="text-sm" aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1.5 rounded-[8px] border border-dashed border-hairline-subtle px-3 py-2 text-left text-[13px] text-ink-tertiary transition "
        >
          <Icon icon="mdi:plus" className="text-base" aria-hidden />
          <input
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="添加一项"
            className="min-w-0 flex-1 rounded-none border-0 bg-transparent leading-5 text-ink outline-none placeholder:text-ink-tertiary"
          />
        </button>
      </div>
    </div>
  );
}

function PillGroup({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 shrink-0 text-[13px] text-ink-secondary">{label}</span>
      {options.map((opt) => {
        const on = opt === value;
        return (
          <button key={opt} type="button" onClick={() => onChange(opt)}
            className={`relative rounded-[8px] border px-3.5 py-2 text-[13px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-secondary "}`}>
            {opt}
            {on && <Icon icon="mdi:check-circle" className="absolute -right-1.5 -top-1.5 text-sm text-ink" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

export function HelpWriteWizard({ token, open, materials, durationSec, onClose, onApply }: HelpWriteWizardProps) {
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("confirm");
  const [pricing, setPricing] = useState<AnalyzePricing | null>(null);
  const [insight, setInsight] = useState<MaterialInsight | null>(null);
  const [business, setBusiness] = useState(BUSINESS[0]);
  const [language, setLanguage] = useState(LANGUAGE[0]);
  const [mode, setMode] = useState<"config" | "reference">("config");
  const [contentType, setContentType] = useState(CONTENT_TYPES[0]);
  const [shootType, setShootType] = useState(SHOOT_TYPES[0]);
  const [hasNarration, setHasNarration] = useState(true);
  const [note, setNote] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);

  // 打开时只重置状态 + 拉拆解价（用于成本预估）；不自动开始拆分，等用户确认。
  useEffect(() => {
    if (!open) return;
    setStage("confirm");
    setInsight(null);
    setScript("");
    setMode("config");
    setPricing(null);
    void listAnalyzePricing(token).then(setPricing).catch(() => setPricing(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  if (!open) return null;

  // 预估拆解消耗（PER_UNIT: ceil(rate×units/perUnits)），并判断价格是否已配置可用。
  const imageCount = materials.filter((m) => !m.mime.startsWith("video/")).length;
  const videoSeconds = materials.filter((m) => m.mime.startsWith("video/")).reduce((s, m) => s + Math.ceil(m.durationSec || 0), 0);
  const imageCost = imageCount > 0 && pricing ? Math.ceil((pricing.image.rate * imageCount) / pricing.image.perUnits) : 0;
  const videoCost = videoSeconds > 0 && pricing ? Math.ceil((pricing.videoSec.rate * videoSeconds) / pricing.videoSec.perUnits) : 0;
  const estimatedCost = imageCost + videoCost;
  const priceReady = !!pricing && (imageCount === 0 || pricing.image.enabled) && (videoSeconds === 0 || pricing.videoSec.enabled);
  const canAnalyze = materials.length > 0 && priceReady;

  const startAnalyze = async () => {
    setStage("analyzing");
    try {
      const requestId = `analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const res = await analyzeMaterialsApi(token, { requestId, materials: materials.map((m) => ({ url: m.url, mime: m.mime })) });
      setInsight(res);
      setStage("insight");
    } catch (e) {
      toast.show("err", e instanceof Error ? e.message : "素材分析失败");
      setStage("confirm"); // 失败不关窗，回到确认步
    }
  };

  const setInsightField = (key: keyof MaterialInsight["insight"], value: string | string[]) =>
    setInsight((cur) => (cur ? { ...cur, insight: { ...cur.insight, [key]: value } } : cur));

  const runGenerate = async (ref?: ReferenceBreakdown) => {
    if (!insight) return;
    setBusy(true);
    setStage("generating");
    try {
      const s = await generateScriptApi(token, {
        insight: insight.insight,
        business, language, contentType, shootType, note, hasNarration,
        durationSec: durationSec > 0 ? durationSec : 15,
        materials: {
          image: materials.filter((m) => m.mime.startsWith("image/")).length,
          video: materials.filter((m) => m.mime.startsWith("video/")).length,
          audio: materials.filter((m) => m.mime.startsWith("audio/")).length,
        },
        reference: ref,
      });
      setScript(s);
      setStage("preview");
    } catch (e) {
      toast.show("err", e instanceof Error ? e.message : "脚本生成失败");
      setStage("creating");
    } finally {
      setBusy(false);
    }
  };

  const handleReferenceUpload = async (file: File) => {
    if (file.size > REF_MAX_BYTES) { toast.show("err", "参考视频不能超过 50MB"); return; }
    setBusy(true);
    try {
      const ref = await analyzeReferenceApi(token, file);
      await runGenerate(ref);
    } catch (e) {
      toast.show("err", e instanceof Error ? e.message : "参考视频拆解失败");
      setBusy(false);
    }
  };

  const active = stepIndexOf(stage);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true">
      <div className="flex h-[760px] max-h-[90vh] w-full max-w-[1040px] overflow-hidden rounded-[18px] bg-white shadow-[0_24px_70px_rgba(0,0,0,0.28)]">
        <StepRail active={active} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-hairline-subtle px-5">
            <span className="text-[15px] font-semibold text-ink">{STEPS[active].title}</span>
            <button type="button" aria-label="关闭" onClick={onClose} className="text-ink-tertiary transition ">
              <Icon icon="mdi:close" className="text-xl" aria-hidden />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {stage === "confirm" && (
              <div className="grid gap-4">
                <section className="rounded-[14px] border border-hairline-subtle p-4">
                  <p className="mb-3 text-sm font-semibold text-ink">待分析素材（{materials.length}）</p>
                  {materials.length === 0 ? (
                    <p className="rounded-[10px] bg-surface-subtle px-3 py-8 text-center text-xs text-ink-tertiary">请先在左侧上传素材，再使用「帮我写」。</p>
                  ) : (
                    <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-5">
                      {materials.map((m, i) => (
                        <div key={m.url} className="relative">
                          {m.mime.startsWith("image/") ? (
                            <img src={m.url} alt={m.name} className="aspect-square w-full rounded-[10px] object-cover" />
                          ) : (
                            <span className="grid aspect-square w-full place-items-center rounded-[10px] bg-[#20202a] text-white">
                              <Icon icon={m.mime.startsWith("video/") ? "mdi:play-circle-outline" : "mdi:music-note-outline"} className="text-2xl" aria-hidden />
                            </span>
                          )}
                          <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-[11px] font-semibold text-white">{i + 1}</span>
                          {m.durationSec > 0 && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1 text-[10px] text-white">{Math.ceil(m.durationSec)}s</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
                <section className="rounded-[14px] border border-hairline-subtle p-4">
                  <p className="mb-2 text-sm font-semibold text-ink">预计消耗</p>
                  {!pricing ? (
                    <p className="text-[13px] text-ink-tertiary">加载价格中…</p>
                  ) : !priceReady ? (
                    <p className="rounded-[10px] bg-amber-50 px-3 py-2.5 text-[13px] leading-6 text-amber-700">拆解价格未配置或未启用，请联系管理员在后台设置并启用「帮我写-图片拆解 / 视频拆解」价格后再试。</p>
                  ) : (
                    <div className="text-[13px] leading-7 text-ink-secondary">
                      {imageCount > 0 && <p>图片拆解：{imageCount} 张 × {pricing.image.rate} = <b className="text-ink">{imageCost}</b> 算力点</p>}
                      {videoSeconds > 0 && <p>视频拆解：{videoSeconds} 秒 × {pricing.videoSec.rate} = <b className="text-ink">{videoCost}</b> 算力点</p>}
                      <p className="mt-1 text-[14px] text-ink">预计合计 <b className="text-brand-ink">{estimatedCost}</b> 算力点</p>
                    </div>
                  )}
                </section>
              </div>
            )}

            {stage === "analyzing" && <WizardLoader messages={ANALYZE_MESSAGES} hint="视频较大时约需 20–60 秒" />}

            {stage === "insight" && insight && (
              <div className="grid gap-5">
                <section className="rounded-[16px] border border-hairline-subtle p-5">
                  <p className="mb-3.5 text-sm font-semibold text-ink">素材分析</p>
                  <div className="grid gap-3">
                    {materials.map((m, i) => (
                      <div key={m.url} className="flex items-stretch gap-3">
                        {m.mime.startsWith("image/") ? (
                          <img src={m.url} alt={m.name} className="h-[68px] w-[68px] shrink-0 rounded-[12px] object-cover" />
                        ) : (
                          <span className="grid h-[68px] w-[68px] shrink-0 place-items-center rounded-[12px] bg-gradient-to-br from-[#3a3a44] to-[#20202a] text-white">
                            <Icon icon={m.mime.startsWith("video/") ? "mdi:play-circle-outline" : "mdi:music-note-outline"} className="text-2xl" aria-hidden />
                          </span>
                        )}
                        <p className="flex flex-1 items-center rounded-[8px] bg-surface-subtle px-3.5 py-2.5 text-[13px] leading-6 text-ink-secondary">
                          {insight.materials.find((x) => x.index === i + 1)?.description ?? insight.materials[i]?.description ?? "—"}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-[16px] border border-hairline-subtle p-5">
                  <p className="mb-4 text-sm font-semibold text-ink">商品洞察</p>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="grid gap-1.5">
                      <span className="text-[11px] font-medium text-ink-tertiary">商品名称</span>
                      <input value={insight.insight.productName} onChange={(e) => setInsightField("productName", e.target.value)}
                        className="rounded-[8px] border border-hairline-subtle px-3.5 py-2.5 text-[13px] text-ink outline-none transition focus:border-brand" />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-[11px] font-medium text-ink-tertiary">商品类目</span>
                      <input value={insight.insight.category} onChange={(e) => setInsightField("category", e.target.value)}
                        className="rounded-[8px] border border-hairline-subtle px-3.5 py-2.5 text-[13px] text-ink outline-none transition focus:border-brand" />
                    </label>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    {([["features", "产品特性"], ["sellingPoints", "核心卖点"], ["audience", "目标人群"], ["scenes", "使用场景"]] as Array<[InsightKey, string]>).map(([key, label]) => (
                      <ChipListEditor key={key} title={label} items={insight.insight[key]} onChange={(next) => setInsightField(key, next)} />
                    ))}
                  </div>
                </section>
              </div>
            )}

            {stage === "creating" && (
              <div className="grid gap-4">
                <section className="rounded-[14px] border border-hairline-subtle p-4">
                  <p className="mb-3 text-sm font-semibold text-ink">业务场景</p>
                  <div className="grid gap-3">
                    <PillGroup label="业务" options={BUSINESS} value={business} onChange={setBusiness} />
                    <PillGroup label="语言" options={LANGUAGE} value={language} onChange={setLanguage} />
                  </div>
                </section>

                <section className="rounded-[14px] border border-hairline-subtle p-4">
                  <p className="mb-3 text-sm font-semibold text-ink">脚本生成方式</p>
                  <div className="grid grid-cols-2 gap-3">
                    {([["config", "mdi:auto-fix", "按配置生成脚本", "基于商品卖点、内容方向和拍摄偏好，生成适合当前商品的原创短视频脚本"], ["reference", "mdi:video-outline", "参考视频生成脚本", "上传参考视频，提取结构、节奏与创意亮点，为当前商品生成新的原创脚本"]] as Array<["config" | "reference", string, string, string]>).map(([m, icon, title, desc]) => {
                      const on = mode === m;
                      return (
                        <button key={m} type="button" onClick={() => setMode(m)}
                          className={`relative rounded-[8px] border p-3.5 text-left transition ${on ? "border-ink" : "border-hairline-subtle "}`}>
                          <span className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                            <Icon icon={icon} className="text-base" aria-hidden />{title}
                          </span>
                          <span className="mt-1.5 block text-[11.5px] leading-5 text-ink-tertiary">{desc}</span>
                          {on && <Icon icon="mdi:check-circle" className="absolute right-2.5 top-2.5 text-base text-ink" aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-[14px] border border-hairline-subtle p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-14 shrink-0 text-[13px] text-ink-secondary">旁白</span>
                    {([[true, "有旁白/口播"], [false, "无旁白"]] as Array<[boolean, string]>).map(([val, label]) => {
                      const on = hasNarration === val;
                      return (
                        <button key={label} type="button" onClick={() => setHasNarration(val)}
                          className={`relative rounded-[8px] border px-3.5 py-2 text-[13px] transition ${on ? "border-ink font-semibold text-ink" : "border-hairline-subtle text-ink-secondary "}`}>
                          {label}
                          {on && <Icon icon="mdi:check-circle" className="absolute -right-1.5 -top-1.5 text-sm text-ink" aria-hidden />}
                        </button>
                      );
                    })}
                    <span className="ml-1 text-[11px] text-ink-tertiary">有旁白时脚本按约每秒 2-3 字生成口播词</span>
                  </div>
                </section>

                {mode === "config" ? (
                  <section className="grid gap-4 rounded-[14px] border border-hairline-subtle p-4">
                    <PillGroup label="内容类型" options={CONTENT_TYPES} value={contentType} onChange={setContentType} />
                    <PillGroup label="拍摄方式" options={SHOOT_TYPES} value={shootType} onChange={setShootType} />
                    <label className="grid gap-1.5">
                      <span className="text-[13px] text-ink-secondary">补充说明</span>
                      <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
                        placeholder="可选：可补充商品卖点、使用场景、目标人群、脚本风格、结尾引导等"
                        className="min-h-[110px] resize-none rounded-[8px] border border-hairline-subtle p-3 text-[13px] leading-6 text-ink outline-none focus:border-hairline" />
                    </label>
                  </section>
                ) : (
                  <section className="grid gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <label className={`flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed p-5 text-center transition ${busy ? "opacity-60" : "border-hairline-subtle bg-surface-subtle "}`}>
                        <span className="grid h-11 w-11 place-items-center rounded-[10px] bg-white shadow-[0_1px_3px_rgba(20,20,40,0.08)]">
                          <Icon icon="mdi:tray-arrow-up" className="text-xl text-ink" aria-hidden />
                        </span>
                        <span className="text-[13px] font-medium text-ink">{busy ? "分析中…" : "点击上传参考视频"}</span>
                        <span className="max-w-[220px] text-[11.5px] leading-5 text-ink-tertiary">支持上传 30 秒以内视频，系统将分析结构、节奏和表达亮点，生成新的脚本灵感</span>
                        <input type="file" accept="video/*" disabled={busy} className="sr-only"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleReferenceUpload(f); e.target.value = ""; }} />
                      </label>
                      <div className="rounded-[14px] border border-hairline-subtle p-4">
                        <p className="text-[13px] font-semibold text-ink">上传后将为你分析</p>
                        <p className="mt-1 text-[11.5px] leading-5 text-ink-tertiary">系统会从参考视频中提取结构、节奏和创意亮点，生成更贴合当前商品的新脚本。</p>
                        <p className="mb-2 mt-3 text-[12px] font-semibold text-ink-secondary">参考视频要求</p>
                        <div className="grid gap-2">
                          {REF_REQUIREMENTS.map((r) => (
                            <div key={r.title} className="flex items-center gap-2.5 rounded-[9px] border border-hairline-subtle px-2.5 py-2">
                              <Icon icon={r.icon} className="shrink-0 text-base text-ink-tertiary" aria-hidden />
                              <span className="text-[12px] font-medium text-ink">{r.title}</span>
                              <span className="text-[11px] text-ink-tertiary">{r.desc}</span>
                            </div>
                          ))}
                        </div>
                        <p className="mb-2 mt-3 text-[12px] font-semibold text-ink-secondary">适合上传的视频</p>
                        <div className="flex flex-wrap gap-1.5">
                          {REF_TAGS.map((t) => (
                            <span key={t} className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] text-ink-secondary">{t}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <label className="grid gap-1.5">
                      <span className="text-[13px] text-ink-secondary">补充说明</span>
                      <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
                        placeholder="可选：可补充商品卖点、使用场景、目标人群、脚本风格、结尾引导等"
                        className="min-h-[90px] resize-none rounded-[8px] border border-hairline-subtle p-3 text-[13px] leading-6 text-ink outline-none focus:border-hairline" />
                    </label>
                  </section>
                )}
              </div>
            )}

            {stage === "generating" && <WizardLoader messages={SCRIPT_MESSAGES} hint="生成脚本约需 10–30 秒" icon="mdi:script-text-outline" />}

            {stage === "preview" && (
              <section className="rounded-[16px] border border-hairline-subtle p-5">
                <p className="mb-3.5 text-sm font-semibold text-ink">视频脚本</p>
                <MarkdownMessage content={script} variant="report" />
              </section>
            )}
          </div>

          <footer className="flex h-16 shrink-0 items-center justify-between border-t border-hairline-subtle px-5">
            {stage === "confirm" && (
              <>
                <button type="button" onClick={onClose} className="text-[13px] font-medium text-ink-tertiary ">取消</button>
                <button type="button" onClick={() => void startAnalyze()} disabled={!canAnalyze}
                  className="h-10 rounded-[10px] bg-surface-inverse px-6 text-[13px] font-semibold text-ink-inverse transition disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-tertiary">
                  {materials.length === 0 ? "请先上传素材" : estimatedCost > 0 ? `开始分析 · 预计 ${estimatedCost} 点` : "开始分析"}
                </button>
              </>
            )}
            {stage === "insight" && (
              <>
                <button type="button" onClick={onClose} className="text-[13px] font-medium text-ink-tertiary ">重新分析</button>
                <button type="button" onClick={() => setStage("creating")} disabled={!insight}
                  className="h-10 rounded-[10px] bg-surface-inverse px-6 text-[13px] font-semibold text-ink-inverse transition disabled:bg-hairline disabled:text-ink-tertiary">下一步</button>
              </>
            )}
            {stage === "creating" && (
              <>
                <button type="button" onClick={() => setStage("insight")} className="text-[13px] font-medium text-ink-tertiary ">返回上一步</button>
                {mode === "config" ? (
                  <button type="button" onClick={() => void runGenerate(undefined)} disabled={busy}
                    className="h-10 rounded-[10px] bg-surface-inverse px-6 text-[13px] font-semibold text-ink-inverse transition disabled:bg-hairline disabled:text-ink-tertiary">生成脚本</button>
                ) : (
                  <span className="text-[12px] text-ink-tertiary">{busy ? "分析并生成中…" : "上传参考视频后自动分析并生成脚本"}</span>
                )}
              </>
            )}
            {stage === "preview" && (
              <>
                <button type="button" onClick={() => setStage("creating")} className="text-[13px] font-medium text-ink-tertiary ">返回上一步</button>
                <div className="flex gap-2.5">
                  <button type="button" onClick={() => void runGenerate(undefined)} disabled={busy}
                    className="h-10 rounded-[10px] border border-hairline-subtle px-5 text-[13px] font-semibold text-ink transition disabled:opacity-50">重新生成脚本</button>
                  <button type="button" onClick={() => { onApply(script, { hasNarration }); onClose(); }} disabled={!script}
                    className="h-10 rounded-[10px] bg-surface-inverse px-6 text-[13px] font-semibold text-ink-inverse transition disabled:bg-hairline disabled:text-ink-tertiary">应用脚本</button>
                </div>
              </>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
