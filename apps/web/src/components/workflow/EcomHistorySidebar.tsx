import { useEffect, useState } from "react";
import { listEcomMainHistory, type EcomMainJob } from "../../workflowEcomMainApi";
import * as workflowEcomApi from "../../workflowEcomApi";
import type { WorkflowEcomWorkflow } from "../../workflowEcomApi";

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

  return (
    <div>
      <p className="text-[13px] font-semibold text-[#1d1d1f]">任务历史</p>
      <div className="mt-3 grid gap-4">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-[#a1a1a6]">商品主图</p>
          <div className="grid gap-1.5">
            {mainHistory.length === 0 ? (
              <p className="text-xs text-[#8a8a8f]">暂无</p>
            ) : (
              mainHistory.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => onSelectMain(h)}
                  className="flex items-center gap-2 rounded-[8px] border border-[#eef1f3] px-2 py-1.5 text-left "
                >
                  <span className="grid h-8 w-8 flex-none place-items-center overflow-hidden rounded-[6px] bg-[#f5f5f7]">
                    {h.images.find((i) => i.thumbnailUrl)?.thumbnailUrl ? (
                      <img
                        src={h.images.find((i) => i.thumbnailUrl)!.thumbnailUrl!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-[#424245]">
                      {h.count} 张 · {h.style}
                    </span>
                    <span className="block text-[10px] text-[#8a8a8f]">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-[#a1a1a6]">商品详情图</p>
          <div className="grid gap-1.5">
            {detailHistory.length === 0 ? (
              <p className="text-xs text-[#8a8a8f]">暂无</p>
            ) : (
              detailHistory.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => onSelectDetail(w)}
                  className="flex items-center gap-2 rounded-[8px] border border-[#eef1f3] px-2 py-1.5 text-left "
                >
                  <span className="grid h-8 w-8 flex-none place-items-center overflow-hidden rounded-[6px] bg-[#f5f5f7]">
                    {w.masterAsset?.thumbnailUrl ? (
                      <img
                        src={w.masterAsset.thumbnailUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-[#424245]">
                      {w.segmentCount} 段 · {w.resolution}
                    </span>
                    <span className="block text-[10px] text-[#8a8a8f]">
                      {new Date(w.createdAt).toLocaleString()}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
