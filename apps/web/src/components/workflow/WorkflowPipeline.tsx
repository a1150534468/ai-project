import { Icon } from "@iconify/react";
import type { WorkflowModuleId } from "../../workflowState";

const IMAGE_PIPELINE_STEPS = [
  { label: "输入主题", icon: "mdi:file-document-outline", className: "text-blue-600 bg-blue-50 border-blue-200" },
  { label: "优化提示词", icon: "mdi:creation-outline", className: "text-indigo-600 bg-indigo-50 border-indigo-200" },
  { label: "批量生成", icon: "mdi:layers-triple-outline", className: "text-violet-600 bg-violet-50 border-violet-200" },
  { label: "风格筛选", icon: "mdi:tune-variant", className: "text-amber-600 bg-amber-50 border-amber-200" },
  { label: "导出", icon: "mdi:download-box-outline", className: "text-brand-ink bg-brand-soft border-brand/30" },
] as const;

const NOVEL_PIPELINE_STEPS = [
  { label: "基础设定", icon: "mdi:book-edit-outline", className: "text-sky-600 bg-sky-50 border-sky-200" },
  { label: "宏观架构", icon: "mdi:graph-outline", className: "text-indigo-600 bg-indigo-50 border-indigo-200" },
  { label: "世界观", icon: "mdi:earth", className: "text-brand-ink bg-brand-soft border-brand/30" },
  { label: "角色设定", icon: "mdi:account-group-outline", className: "text-rose-600 bg-rose-50 border-rose-200" },
  { label: "卷纲章节", icon: "mdi:format-list-numbered", className: "text-amber-600 bg-amber-50 border-amber-200" },
] as const;

const ECOM_PIPELINE_STEPS = [
  { label: "参考图", icon: "mdi:image-plus-outline", className: "text-sky-600 bg-sky-50 border-sky-200" },
  { label: "商品信息", icon: "mdi:tag-text-outline", className: "text-indigo-600 bg-indigo-50 border-indigo-200" },
  { label: "母版生成", icon: "mdi:image-filter-center-focus", className: "text-brand-ink bg-brand-soft border-brand/30" },
  { label: "三段长图", icon: "mdi:view-sequential-outline", className: "text-rose-600 bg-rose-50 border-rose-200" },
  { label: "拼接保存", icon: "mdi:download-box-outline", className: "text-amber-600 bg-amber-50 border-amber-200" },
] as const;

const LOCAL_BUSINESS_PROMO_PIPELINE_STEPS = [
  { label: "填写资料", icon: "mdi:form-select", className: "text-sky-600 bg-sky-50 border-sky-200" },
  { label: "生成文案", icon: "mdi:text-box-edit-outline", className: "text-indigo-600 bg-indigo-50 border-indigo-200" },
  { label: "多段视频", icon: "mdi:filmstrip-box-multiple", className: "text-brand-ink bg-brand-soft border-brand/30" },
  { label: "任务轮询", icon: "mdi:progress-clock", className: "text-rose-600 bg-rose-50 border-rose-200" },
  { label: "成片拼接", icon: "mdi:content-cut", className: "text-amber-600 bg-amber-50 border-amber-200" },
] as const;

export function WorkflowPipeline({ moduleId }: { readonly moduleId: WorkflowModuleId }) {
  const steps = moduleId === "novel"
    ? NOVEL_PIPELINE_STEPS
    : moduleId === "commerce-long-image"
      ? ECOM_PIPELINE_STEPS
      : moduleId === "local-business-promo"
        ? LOCAL_BUSINESS_PROMO_PIPELINE_STEPS
        : IMAGE_PIPELINE_STEPS;

  return (
    <ol className="flex flex-col" aria-label="工作流链路">
      {steps.map((step, index) => (
        <li key={step.label} className="flex gap-2.5">
          <div className="flex flex-col items-center">
            <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">
              {index + 1}
            </span>
            {index < steps.length - 1 && <span className="my-0.5 w-px flex-1 bg-[#e8e8ed]" />}
          </div>
          <div className="flex items-center gap-1.5 pb-3 pt-0.5">
            <Icon icon={step.icon} className="flex-none text-base text-[#a1a1a6]" aria-hidden />
            <p className="text-[13px] text-ink-secondary">{step.label}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
