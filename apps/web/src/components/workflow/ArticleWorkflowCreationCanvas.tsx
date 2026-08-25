import type {
  ArticleWorkflowTopicPreset,
  ArticleWorkflowTopicStyle,
} from "@ai-assistant/article-workflow";
import { ArticleWorkflowSourceCanvas } from "./ArticleWorkflowSourceCanvas";
import {
  type ArticleWorkflowCreationDraft,
} from "./articleWorkflowCreationDraft";

interface ArticleWorkflowCreationCanvasProps {
  readonly draft: ArticleWorkflowCreationDraft;
  readonly onChange: (draft: ArticleWorkflowCreationDraft) => void;
  readonly onModeChange: (mode: ArticleWorkflowCreationDraft["mode"]) => void;
  readonly variant?: "workspace" | "panel";
}

const STYLE_SOURCES: readonly { key: ArticleWorkflowTopicStyle["mode"]; label: string }[] = [
  { key: "preset", label: "预设风格" },
  { key: "custom", label: "自定义风格" },
  { key: "imitate", label: "模仿文案" },
];

const PRESETS: readonly { key: ArticleWorkflowTopicPreset; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "experience", label: "经验分享" },
  { key: "recommendation", label: "种草推荐" },
  { key: "tutorial", label: "教程攻略" },
  { key: "opinion", label: "观点表达" },
  { key: "healing", label: "情感治愈" },
];

function nextStyle(mode: ArticleWorkflowTopicStyle["mode"]): ArticleWorkflowTopicStyle {
  if (mode === "custom") return { mode, instruction: "" };
  if (mode === "imitate") return { mode, referenceText: "" };
  return { mode, preset: "general" };
}

export function ArticleWorkflowCreationCanvas(props: ArticleWorkflowCreationCanvasProps) {
  const draft = props.draft;
  const panel = props.variant === "panel";
  const updateTopic = (patch: Partial<Extract<ArticleWorkflowCreationDraft, { mode: "topic" }>>) => {
    if (draft.mode !== "topic") return;
    props.onChange({ ...draft, ...patch });
  };

  return (
    <section
      className={panel ? "grid gap-4 bg-white" : "flex h-full min-h-[520px] flex-col bg-[#f7f8fa]"}
      aria-label="创作内容"
    >
      <div className={panel
        ? "flex items-center justify-between gap-3"
        : "flex h-12 flex-none items-center justify-between border-b border-[#e5e7eb] bg-white px-4 lg:px-5"}
      >
        <span className="text-xs font-semibold text-ink">创作方式</span>
        <div className="grid grid-cols-2 rounded-lg bg-[#ececf0] p-1" role="tablist" aria-label="创作方式">
          {(["source", "topic"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={draft.mode === mode}
              onClick={() => props.onModeChange(mode)}
              className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                draft.mode === mode ? "bg-white text-ink shadow-sm" : "text-ink-secondary"
              }`}
            >
              {mode === "source" ? "原文改编" : "主题创作"}
            </button>
          ))}
        </div>
      </div>

      {draft.mode === "source" ? (
        <ArticleWorkflowSourceCanvas
          sourceFormat={draft.sourceFormat}
          sourceText={draft.sourceText}
          onSourceFormatChange={(sourceFormat) => props.onChange({ ...draft, sourceFormat })}
          onSourceTextChange={(sourceText) => props.onChange({ ...draft, sourceText })}
          compact={panel}
        />
      ) : (
        <div className={panel ? "grid gap-4" : "min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6"}>
          <div className={panel ? "grid gap-4" : "mx-auto grid max-w-[760px] gap-5"}>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-ink">主题 / 关键词</span>
              <input
                value={draft.topic}
                onChange={(event) => updateTopic({ topic: event.target.value })}
                maxLength={200}
                className="h-11 rounded-lg border border-hairline bg-white px-3.5 text-sm text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/10"
                placeholder="例如：夏天在家做一杯清爽咖啡"
              />
            </label>

            <fieldset>
              <legend className="mb-2 text-xs font-semibold text-ink">文案风格</legend>
              <div className="grid grid-cols-3 rounded-lg bg-[#ececf0] p-1" role="tablist" aria-label="文案风格来源">
                {STYLE_SOURCES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={draft.style.mode === item.key}
                    onClick={() => updateTopic({ style: nextStyle(item.key) })}
                    className={`h-9 min-w-0 rounded-md px-2 text-xs font-semibold transition ${
                      draft.style.mode === item.key ? "bg-white text-ink shadow-sm" : "text-ink-secondary"
                    }`}
                  >
                    <span className="block truncate">{item.label}</span>
                  </button>
                ))}
              </div>
              {draft.style.mode === "preset" && (
                <select
                  aria-label="预设风格"
                  value={draft.style.preset}
                  onChange={(event) => updateTopic({ style: { mode: "preset", preset: event.target.value as ArticleWorkflowTopicPreset } })}
                  className="mt-3 h-11 w-full rounded-lg border border-hairline bg-white px-3 text-sm text-ink outline-none focus:border-brand"
                >
                  {PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
                </select>
              )}
              {draft.style.mode === "custom" && (
                <textarea
                  aria-label="自定义风格"
                  value={draft.style.instruction}
                  onChange={(event) => updateTopic({ style: { mode: "custom", instruction: event.target.value } })}
                  maxLength={2000}
                  rows={5}
                  className="mt-3 w-full resize-y rounded-lg border border-hairline bg-white px-3.5 py-3 text-sm leading-6 text-ink outline-none focus:border-brand"
                  placeholder="例如：像朋友聊天，开头直接给结论，结尾自然提问"
                />
              )}
              {draft.style.mode === "imitate" && (
                <textarea
                  aria-label="参考文案"
                  value={draft.style.referenceText}
                  onChange={(event) => updateTopic({ style: { mode: "imitate", referenceText: event.target.value } })}
                  maxLength={20000}
                  rows={8}
                  className="mt-3 w-full resize-y rounded-lg border border-hairline bg-white px-3.5 py-3 text-sm leading-6 text-ink outline-none focus:border-brand"
                  placeholder="粘贴一篇用于参考表达风格的文案"
                />
              )}
            </fieldset>

            <details className="group border-t border-[#e5e7eb] pt-4">
              <summary className="cursor-pointer list-none text-xs font-semibold text-ink-secondary marker:content-none">
                更多设置
              </summary>
              <div className="mt-4 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-xs font-semibold text-ink">核心要点</span>
                  <textarea value={draft.keyPoints} onChange={(event) => updateTopic({ keyPoints: event.target.value })} maxLength={4000} rows={5} className="resize-y rounded-lg border border-hairline bg-white px-3.5 py-3 text-sm leading-6 outline-none focus:border-brand" />
                </label>
                <label className="grid gap-2">
                  <span className="text-xs font-semibold text-ink">目标受众</span>
                  <input value={draft.audience} onChange={(event) => updateTopic({ audience: event.target.value })} maxLength={500} className="h-11 rounded-lg border border-hairline bg-white px-3.5 text-sm outline-none focus:border-brand" />
                </label>
                <label className="grid gap-2">
                  <span className="text-xs font-semibold text-ink">禁写内容</span>
                  <textarea value={draft.avoid} onChange={(event) => updateTopic({ avoid: event.target.value })} maxLength={2000} rows={4} className="resize-y rounded-lg border border-hairline bg-white px-3.5 py-3 text-sm leading-6 outline-none focus:border-brand" />
                </label>
              </div>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}
