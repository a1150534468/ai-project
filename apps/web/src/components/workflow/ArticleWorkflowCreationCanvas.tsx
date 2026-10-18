import type {
  ArticleWorkflowTopicPreset,
  ArticleWorkflowTopicStyle,
} from "@ai-assistant/article-workflow";
import { ArticleWorkflowSourceCanvas } from "./ArticleWorkflowSourceCanvas";
import {
  SETTINGS_CONTROL,
  SETTINGS_LABEL,
  SETTINGS_SEGMENT,
  SETTINGS_SEGMENT_OFF,
  SETTINGS_SEGMENT_ON,
  SETTINGS_TEXTAREA,
  SettingsField,
} from "./SettingsSlots";
import { cx } from "../ui/cx";
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
      className={panel ? "grid gap-4 bg-surface" : "flex h-full min-h-[520px] flex-col bg-surface-subtle"}
      aria-label="创作内容"
    >
      <div className={panel
        ? "flex items-center justify-between gap-3"
        : "flex h-12 flex-none items-center justify-between border-b border-hairline-subtle bg-surface px-4 lg:px-5"}
      >
        <span className={SETTINGS_LABEL}>创作方式</span>
        <div className={cx(SETTINGS_SEGMENT, "grid-cols-2")} role="tablist" aria-label="创作方式">
          {(["source", "topic"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={draft.mode === mode}
              onClick={() => props.onModeChange(mode)}
              className={cx(
                "h-8 border-r border-hairline-subtle px-3 text-xs last:border-r-0",
                draft.mode === mode ? SETTINGS_SEGMENT_ON : SETTINGS_SEGMENT_OFF,
              )}
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
            <SettingsField label="主题 / 关键词" htmlFor="article-topic">
              <input
                id="article-topic"
                value={draft.topic}
                onChange={(event) => updateTopic({ topic: event.target.value })}
                maxLength={200}
                className={SETTINGS_CONTROL}
                placeholder="例如：夏天在家做一杯清爽咖啡"
              />
            </SettingsField>

            <fieldset>
              <legend className={cx(SETTINGS_LABEL, "mb-1.5")}>文案风格</legend>
              <div className={cx(SETTINGS_SEGMENT, "grid-cols-3")} role="tablist" aria-label="文案风格来源">
                {STYLE_SOURCES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={draft.style.mode === item.key}
                    onClick={() => updateTopic({ style: nextStyle(item.key) })}
                    className={cx(
                      "h-9 min-w-0 border-r border-hairline-subtle px-2 text-xs last:border-r-0",
                      draft.style.mode === item.key ? SETTINGS_SEGMENT_ON : SETTINGS_SEGMENT_OFF,
                    )}
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
                  className={cx(SETTINGS_CONTROL, "mt-3")}
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
                  className={cx(SETTINGS_TEXTAREA, "mt-3")}
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
                  className={cx(SETTINGS_TEXTAREA, "mt-3")}
                  placeholder="粘贴一篇用于参考表达风格的文案"
                />
              )}
            </fieldset>

            <details className="group border-t border-hairline-subtle pt-4">
              <summary className="cursor-pointer list-none text-sm font-medium text-ink-secondary marker:content-none">
                更多设置
              </summary>
              <div className="mt-4 grid gap-4">
                <SettingsField label="核心要点" htmlFor="article-key-points">
                  <textarea id="article-key-points" value={draft.keyPoints} onChange={(event) => updateTopic({ keyPoints: event.target.value })} maxLength={4000} rows={5} className={SETTINGS_TEXTAREA} />
                </SettingsField>
                <SettingsField label="目标受众" htmlFor="article-audience">
                  <input id="article-audience" value={draft.audience} onChange={(event) => updateTopic({ audience: event.target.value })} maxLength={500} className={SETTINGS_CONTROL} />
                </SettingsField>
                <SettingsField label="禁写内容" htmlFor="article-avoid">
                  <textarea id="article-avoid" value={draft.avoid} onChange={(event) => updateTopic({ avoid: event.target.value })} maxLength={2000} rows={4} className={SETTINGS_TEXTAREA} />
                </SettingsField>
              </div>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}
