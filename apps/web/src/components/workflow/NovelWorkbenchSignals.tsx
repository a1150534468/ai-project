import { Icon } from "@iconify/react";
import type { NovelWorkbenchPayload } from "../../api";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function dueCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function NovelWorkbenchSignals({ workbench }: { readonly workbench: NovelWorkbenchPayload | null }) {
  const highlights = workbench?.workbenchHighlights ?? {};
  const workflowGate = asRecord(highlights.workflowGate);
  const quality = asRecord(highlights.qualitySnapshot);
  const items = [
    { icon: "mdi:target", label: "焦点章节", value: `第 ${text(highlights.focusChapterNumber) || "-"} 章` },
    { icon: "mdi:gate", label: "闸门", value: text(workflowGate?.status) || "ok" },
    { icon: "mdi:book-open-variant-outline", label: "到期伏笔", value: `${dueCount(highlights.dueForeshadowItems)} 条` },
    { icon: "mdi:chart-box-outline", label: "质量风险", value: text(quality?.styleRisk) || "low" },
  ];

  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 items-center gap-2 rounded-lg border border-[#e8e8ed] bg-[#f7faf9] px-3 py-2">
          <Icon icon={item.icon} className="shrink-0 text-base text-brand-ink" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-semibold text-[#8a8a8f]">{item.label}</span>
            <span className="block truncate text-sm font-semibold text-[#1d1d1f]">{item.value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
