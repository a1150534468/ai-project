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
import { usePanelVisibility } from "./panelVisibility";
import { wfShell } from "./workflowLayout";
import { useCodexPetStudio, type CodexPetStudioProps } from "./useCodexPetStudio";

export type { CodexPetStudioClient } from "./codexPetStudioClient";
export type { CodexPetStudioProps };

export function CodexPetStudio(props: CodexPetStudioProps) {
  const studio = useCodexPetStudio(props);
  const panels = usePanelVisibility();
  const { error, notice } = studio.state;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3.5 xl:h-full" data-testid="codex-pet-studio">
      {/* 原来这里还有一张「[图标] Codex 桌宠工坊 / 参考图或文字生成，可直接安装到 Codex」+ 两枚状态
          胶囊的头卡。模块名现在归顶栏的模块胶囊；那两枚胶囊（模型 · 质检开关、最多 N 次计划内调用）
          在左边设置栏的「生成选项」里逐字写着，删掉不丢信息。 */}

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

      {/* 三区几何与另外三个模块共用 `workflowLayout` 那一份：留缝 14px、左右 300 / 280，
          三块都是圆角卡。原来这里是 `grid gap-3 xl:grid-cols-[300px_1fr_280px]` —— 与生图/图文
          的「通栏直角面板」是两套几何，同一产品里切模块就得重新认一遍边界。
          左右两栏由顶栏「面板开关」控制：收起的那一列连缝一起从栅格里消失，工作区吃掉那份宽度。 */}
      <div className={wfShell(panels.left, panels.right)}>
        {panels.left && <CodexPetStudioInputPanel studio={studio} />}
        <CodexPetStudioWorkbench studio={studio} />
        {panels.right && <CodexPetStudioRunSidebar studio={studio} />}
      </div>
    </section>
  );
}
