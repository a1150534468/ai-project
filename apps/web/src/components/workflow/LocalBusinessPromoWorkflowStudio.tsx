import { LocalBusinessPromoProjectListView } from "./localBusinessPromoWorkflowProjectListView";
import { LocalBusinessPromoStudioPanels } from "./localBusinessPromoWorkflowStudioPanels";
import {
  useLocalBusinessPromoWorkflowStudio,
  type LocalBusinessPromoWorkflowStudioProps,
} from "./useLocalBusinessPromoWorkflowStudio";

export function LocalBusinessPromoWorkflowStudio(props: LocalBusinessPromoWorkflowStudioProps) {
  const studio = useLocalBusinessPromoWorkflowStudio(props);

  if (studio.state.isBootstrapping) {
    return (
      <section className="rounded-[14px] border border-hairline-subtle bg-surface p-8 text-sm text-ink-secondary">
        正在加载工作流...
      </section>
    );
  }

  if (studio.state.viewMode === "list") {
    return <LocalBusinessPromoProjectListView studio={studio} />;
  }

  return (
    <section className="space-y-3">
      <LocalBusinessPromoStudioPanels studio={studio} />
    </section>
  );
}
