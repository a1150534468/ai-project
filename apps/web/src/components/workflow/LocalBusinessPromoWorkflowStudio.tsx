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
      <section className="rounded-[14px] border border-[#e8e8ed] bg-white p-8 text-sm text-[#6e6e73]">
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
