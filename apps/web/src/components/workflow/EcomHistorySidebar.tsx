import { useEffect, useState } from "react";
import { listEcomMainHistory, type EcomMainJob } from "../../workflowEcomMainApi";
import * as workflowEcomApi from "../../workflowEcomApi";
import type { WorkflowEcomWorkflow } from "../../workflowEcomApi";
import { WorkflowHistoryStrip, type WorkflowHistoryGroup } from "./ImageHistoryStrip";

interface EcomHistorySidebarProps {
  readonly token: string;
  readonly refreshKey: number;
  readonly onSelectMain: (job: EcomMainJob) => void;
  readonly onSelectDetail: (workflow: WorkflowEcomWorkflow) => void;
}

export function EcomHistorySidebar({
  token,
  refreshKey,
  onSelectMain,
  onSelectDetail,
}: EcomHistorySidebarProps) {
  const [mainHistory, setMainHistory] = useState<readonly EcomMainJob[]>([]);
  const [detailHistory, setDetailHistory] = useState<readonly WorkflowEcomWorkflow[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const mainResult = await listEcomMainHistory(token);
        setMainHistory(mainResult.jobs);
      } catch {
        // 忽略
      }
    })();
    void (async () => {
      try {
        const detailResult = await workflowEcomApi.listWorkflowEcomHistory(token);
        setDetailHistory(detailResult);
      } catch {
        // 忽略
      }
    })();
  }, [token, refreshKey]);

  const groups: readonly WorkflowHistoryGroup[] = [
    ...mainHistory.map((job) => ({
      id: `main-${job.id}`,
      title: `商品主图 · ${job.count} 张 · ${job.style}`,
      meta: new Date(job.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      items: job.images.length > 0
        ? job.images.map((image) => ({
            id: `main-${job.id}-${image.index}`,
            imageUrl: image.thumbnailUrl || image.originalUrl,
            alt: `商品主图第 ${image.index + 1} 张`,
            placeholderIcon: image.status === "failed" ? "mdi:image-off-outline" : "mdi:image-outline",
            onSelect: () => onSelectMain(job),
          }))
        : [{
            id: `main-${job.id}-placeholder`,
            alt: "商品主图任务",
            placeholderIcon: "mdi:image-outline",
            onSelect: () => onSelectMain(job),
          }],
    })),
    ...detailHistory.map((workflow) => ({
      id: `detail-${workflow.id}`,
      title: `商品详情图 · ${workflow.segmentCount} 段 · ${workflow.resolution}`,
      meta: new Date(workflow.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      items: workflow.masterAsset || workflow.segments.length > 0 ? [
        ...(workflow.masterAsset ? [{
          id: `detail-${workflow.id}-master`,
          imageUrl: workflow.masterAsset.thumbnailUrl || workflow.masterAsset.originalUrl,
          alt: "商品详情图母版",
          onSelect: () => onSelectDetail(workflow),
        }] : []),
        ...workflow.segments.map((segment) => ({
          id: `detail-${workflow.id}-segment-${segment.index}`,
          imageUrl: segment.thumbnailUrl || segment.originalUrl,
          alt: `商品详情图第 ${segment.index + 1} 段`,
          onSelect: () => onSelectDetail(workflow),
        })),
      ] : [{
        id: `detail-${workflow.id}-placeholder`,
        alt: "商品详情图任务",
        placeholderIcon: "mdi:image-outline",
        onSelect: () => onSelectDetail(workflow),
      }],
    })),
  ];

  return (
    <WorkflowHistoryStrip
      ariaLabel="电商图生成历史"
      summary={`${mainHistory.length + detailHistory.length} 个任务`}
      emptyText="暂无生成记录"
      groups={groups}
    />
  );
}
