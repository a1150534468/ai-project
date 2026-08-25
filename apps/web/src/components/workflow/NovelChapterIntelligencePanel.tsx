import { Icon } from "@iconify/react";
import type { ReactNode } from "react";
import type { NovelWorkbenchPayload } from "../../api";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function Panel({ title, icon, children }: { readonly title: string; readonly icon: string; readonly children: ReactNode }) {
  return (
    <section className="rounded-lg border border-hairline-subtle bg-surface p-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon icon={icon} aria-hidden />
        {title}
      </h4>
      <div className="mt-2 min-w-0 text-xs leading-5 text-ink-secondary">{children}</div>
    </section>
  );
}

export function NovelChapterIntelligencePanel({
  chapter,
  workbench,
}: {
  readonly chapter: NovelWorkbenchPayload["chapters"][number] | null;
  readonly workbench: NovelWorkbenchPayload | null;
}) {
  const highlights = workbench?.workbenchHighlights ?? {};
  const focusCard = asRecord(highlights.focusCard);
  const quality = asRecord(chapter?.consistencyJson);
  const qualityDetail = asRecord(quality?.quality);
  const microBeats = asArray(highlights.microBeats).slice(0, 4);
  const alerts = asArray(highlights.continuityAlerts).slice(0, 4);
  const facts = (workbench?.knowledgeFacts ?? []).slice(0, 5);
  const foreshadow = (workbench?.foreshadowItems ?? []).slice(0, 5);

  return (
    <aside data-testid="novel-chapter-intelligence-panel" className="grid min-w-0 content-start gap-3">
      <Panel title="章节情报" icon="mdi:radar">
        <div className="grid gap-1">
          <p>焦点章节：第 {text(highlights.focusChapterNumber) || chapter?.chapterIndex || "-"} 章</p>
          <p>工作流：{text(asRecord(highlights.workflowGate)?.status) || "ok"}</p>
          <p>当前章节：{chapter?.title || "未选择"}</p>
        </div>
      </Panel>
      <Panel title="任务卡" icon="mdi:clipboard-text-outline">
        <div className="grid gap-1 break-words">
          <p>任务：{text(focusCard?.mission) || text(highlights.recommendedFocus) || "推进主线"}</p>
          <p>冲突：{text(focusCard?.conflict) || "保持压力"}</p>
          <p>钩子：{text(focusCard?.endingHook) || "留下下一步问题"}</p>
        </div>
      </Panel>
      <Panel title="微节拍" icon="mdi:metronome">
        <div className="grid gap-2">
          {microBeats.map((beat, index) => (
            <div key={`${text(beat.label)}:${index}`} className="rounded-lg bg-surface-subtle px-2 py-1.5">
              <p className="font-semibold text-ink">{text(beat.index)}. {text(beat.label)} · {text(beat.targetWords)}字</p>
              <p className="break-words">{text(beat.objective)}</p>
            </div>
          ))}
          {microBeats.length === 0 && <p className="text-ink-tertiary">暂无节拍</p>}
        </div>
      </Panel>
      <Panel title="连续性提醒" icon="mdi:alert-circle-outline">
        <div className="grid gap-2">
          {alerts.map((alert, index) => (
            <p key={`${text(alert.title)}:${index}`} className="break-words rounded-lg bg-warning/10 px-2 py-1.5 text-warning-ink">
              {text(alert.title)}：{text(alert.detail)}
            </p>
          ))}
          {alerts.length === 0 && <p className="text-ink-tertiary">暂无提醒</p>}
        </div>
      </Panel>
      <Panel title="稳定事实" icon="mdi:database-check-outline">
        <div className="grid gap-1">
          {facts.map((fact, index) => (
            <p key={`${text(fact.subject)}:${index}`} className="break-words">{text(fact.subject)} {text(fact.predicate)} {text(fact.object)}</p>
          ))}
          {facts.length === 0 && <p className="text-ink-tertiary">暂无事实</p>}
        </div>
      </Panel>
      <Panel title="伏笔账本" icon="mdi:book-open-variant-outline">
        <div className="grid gap-1">
          {foreshadow.map((item, index) => (
            <p key={`${text(item.title)}:${index}`} className="break-words">{text(item.title)} · {text(item.status)} · 第{text(item.expectedPayoffChapter)}章</p>
          ))}
          {foreshadow.length === 0 && <p className="text-ink-tertiary">暂无伏笔</p>}
        </div>
      </Panel>
      <Panel title="质量诊断" icon="mdi:chart-box-outline">
        <div className="grid gap-1">
          <p>质量分：{text(qualityDetail?.score) || "-"}</p>
          <p>风格风险：{text(qualityDetail?.styleRisk) || text(asRecord(highlights.qualitySnapshot)?.styleRisk) || "low"}</p>
          <p>一致性：{text(quality?.status) || text(asRecord(highlights.qualitySnapshot)?.consistencyStatus) || "ok"}</p>
        </div>
      </Panel>
    </aside>
  );
}
