/**
 * 桌宠工坊的门面。原来这个文件有 1991 行,现在只剩"页头 + 两条横幅 + 三栏骨架",
 * 状态在 `useCodexPetStudio`,展示在三个面板文件里。
 *
 * **对外导出面刻意保持不变**:`CodexPetStudio` 与 `type CodexPetStudioClient` 仍然从这里导出,
 * `CodexPetStudio.test.tsx` 与 `pages/Workflow.tsx` 都按这个路径引用;想搬走导出就要同时改测试,
 * 那会让"纯拆分"变成"改契约"。
 */
import { Icon } from "@iconify/react";
import { CodexPetStudioInputPanel } from "./CodexPetStudioInputPanel";
import { CodexPetStudioRunSidebar } from "./CodexPetStudioRunSidebar";
import { CodexPetStudioWorkbench } from "./CodexPetStudioWorkbench";
import { useCodexPetStudio, type CodexPetStudioProps } from "./useCodexPetStudio";

export type { CodexPetStudioClient } from "./codexPetStudioClient";
export type { CodexPetStudioProps };

export function CodexPetStudio(props: CodexPetStudioProps) {
  const studio = useCodexPetStudio(props);
  const { draft, error, notice } = studio.state;
  const { plannedCallLimit } = studio.derived;

  return (
    <section className="flex xl:h-full min-h-0 flex-col gap-3" data-testid="codex-pet-studio">
      <div className="flex flex-none flex-wrap items-start justify-between gap-3 rounded-[16px] border border-hairline-subtle bg-surface px-5 py-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-[12px] bg-brand text-white shadow-sm">
              <Icon icon="mdi:egg-easter" className="text-xl" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-ink">Codex 桌宠工坊</h1>
              <p className="text-xs text-ink-secondary">参考图或文字生成，可直接安装到 Codex</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-brand/30 bg-surface px-3 py-1.5 text-brand-ink">
            GPT Image 2 · Pixel · AI 质检{draft.qualityInspectionEnabled ? "已开启" : "关闭"}
          </span>
          <span className="rounded-full bg-surface-inverse px-3 py-1.5 font-semibold text-ink-inverse">
            最多 {plannedCallLimit} 次计划内调用
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-[12px] border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger-ink">
          <Icon icon="mdi:alert-circle-outline" className="mt-0.5 flex-none text-base" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div aria-live="polite" className="flex items-start gap-2 rounded-[12px] border border-brand/30 bg-brand-soft px-3 py-2.5 text-sm text-brand-ink">
          <Icon icon="mdi:check-circle-outline" className="mt-0.5 flex-none text-base" aria-hidden />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid xl:h-full min-h-0 min-w-0 flex-1 gap-3 xl:grid-cols-[1fr_3fr_1fr]">
        <CodexPetStudioInputPanel studio={studio} />
        <CodexPetStudioWorkbench studio={studio} />
        <CodexPetStudioRunSidebar studio={studio} />
      </div>
    </section>
  );
}
