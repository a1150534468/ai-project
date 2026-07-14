import { Icon } from "@iconify/react";
import type { ArticleWorkflowGenerationMode, ArticleWorkflowSourceFormat } from "@ai-assistant/article-workflow";
import { RippleButton } from "../../motion";
import type { ArticleWorkflowPricing } from "../../workflowArticleApi";
import { articleWorkflowPricingText } from "./articleWorkflowStudioModel";

interface ArticleWorkflowInputPanelProps {
  readonly sourceFormat: ArticleWorkflowSourceFormat;
  readonly generationMode: ArticleWorkflowGenerationMode;
  readonly sourceText: string;
  readonly pricing: ArticleWorkflowPricing | null;
  readonly creating: boolean;
  readonly canGenerate: boolean;
  readonly onSourceFormatChange: (value: ArticleWorkflowSourceFormat) => void;
  readonly onGenerationModeChange: (value: ArticleWorkflowGenerationMode) => void;
  readonly onSourceTextChange: (value: string) => void;
  readonly onGenerate: () => void;
}

const SOURCE_OPTIONS: readonly { key: ArticleWorkflowSourceFormat; label: string }[] = [
  { key: "plain-text", label: "纯文本" },
  { key: "markdown", label: "Markdown" },
];

const MODE_OPTIONS: readonly { key: ArticleWorkflowGenerationMode; label: string; description: string }[] = [
  { key: "preserve-text", label: "保持原文排版", description: "只做排版和配图，不改正文可见文字。" },
  { key: "polish-text", label: "AI 润色后排版", description: "允许先润色再排版，适合重写语气和结构。" },
];

export function ArticleWorkflowInputPanel(props: ArticleWorkflowInputPanelProps) {
  return (
    <section className="grid gap-4">
      <div className="rounded-[18px] border border-[#e7e9f0] bg-white p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)] sm:p-6">
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <h2 className="text-[28px] font-semibold leading-[1.3] text-[#14151a]">公众号图文工作流</h2>
            <p className="text-sm leading-6 text-[#667085]">输入文本或 Markdown，AI 自动配图、排版，生成后可继续编辑并一键复制到公众号。</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {SOURCE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => props.onSourceFormatChange(option.key)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                      props.sourceFormat === option.key
                        ? "bg-brand text-white"
                        : "bg-[#f5f6fa] text-[#475467]"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <textarea
                value={props.sourceText}
                onChange={(event) => props.onSourceTextChange(event.target.value)}
                rows={18}
                className="min-h-[360px] w-full rounded-[16px] border border-[#d7dce5] bg-[#fbfcff] px-4 py-3 text-sm leading-7 text-[#1f2937] outline-none transition focus:border-brand"
                placeholder={props.sourceFormat === "markdown" ? "粘贴 Markdown 内容" : "粘贴文章正文"}
              />
            </div>

            <aside className="grid gap-4 rounded-[16px] border border-[#edf0f5] bg-[#f8f9fc] p-4">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[#14151a]">生成方式</h3>
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => props.onGenerationModeChange(option.key)}
                    className={`w-full rounded-[14px] border px-4 py-3 text-left transition ${
                      props.generationMode === option.key
                        ? "border-brand bg-white shadow-sm"
                        : "border-[#dde3ec] bg-white/70"
                    }`}
                  >
                    <div className="text-sm font-semibold text-[#1d2433]">{option.label}</div>
                    <div className="mt-1 text-xs leading-5 text-[#667085]">{option.description}</div>
                  </button>
                ))}
              </div>

              <div className="rounded-[14px] border border-[#e5e8ef] bg-white p-4">
                <div className="text-sm font-semibold text-[#14151a]">计费说明</div>
                <div className="mt-2 text-xs leading-6 text-[#667085]">
                  文本生成：{articleWorkflowPricingText(props.pricing?.text, "每 1000 字 1 点")}
                  <br />
                  配图生成：{articleWorkflowPricingText(props.pricing?.image1k, "1K 生图价格")}
                  <br />
                  生成失败自动退费。
                </div>
              </div>

              <RippleButton
                type="button"
                onClick={props.onGenerate}
                disabled={!props.canGenerate}
                className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:bg-brand/40"
              >
                <Icon icon={props.creating ? "mdi:loading" : "mdi:auto-fix"} className={props.creating ? "animate-spin" : ""} aria-hidden />
                {props.creating ? "提交中" : "生成图文"}
              </RippleButton>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}
