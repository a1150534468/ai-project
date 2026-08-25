import { Icon } from "@iconify/react";
import type { WorkflowModule, WorkflowModuleId } from "../../workflowState";

interface WorkflowModulesProps {
  readonly modules: readonly WorkflowModule[];
  readonly activeModuleId: WorkflowModuleId;
  readonly onSelectModule: (module: WorkflowModule) => void;
}

export function WorkflowModules({ modules, activeModuleId, onSelectModule }: WorkflowModulesProps) {
  return (
    <nav className="flex flex-col gap-0.5" aria-label="工作流模块">
      {modules.map((module) => {
        const active = module.id === activeModuleId;
        const available = module.status === "available";

        return (
          <button
            key={module.id}
            type="button"
            disabled={!available}
            onClick={() => onSelectModule(module)}
            title={module.description}
            className={`flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              active
                ? "bg-brand-soft font-semibold text-brand-ink"
                : available
                  ? "text-ink-secondary "
                  : "cursor-not-allowed text-[#a1a1a6]"
            }`}
          >
            <Icon icon={module.icon} className="flex-none text-lg" aria-hidden />
            <span className="truncate">{module.title}</span>
            {!available && <span className="ml-auto flex-none text-[10px] font-medium text-[#a1a1a6]">开发中</span>}
          </button>
        );
      })}
    </nav>
  );
}
