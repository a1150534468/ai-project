import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { listModels } from "../api";
import { Alert, cardClass } from "../components/ui";

export interface MarketplaceModel {
  readonly model: string;
  readonly displayName: string;
}

export default function ModelMarketplace() {
  const [models, setModels] = useState<readonly MarketplaceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage("");
    listModels()
      .then((rows) => {
        if (!cancelled) setModels(rows);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "模型广场加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex-1 overflow-auto bg-surface-muted">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-6">
          <h1 className="text-[28px] font-bold tracking-tight text-ink">模型广场</h1>
          <p className="mt-1 text-sm text-ink-secondary">查看当前账号可用的模型</p>
        </div>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-tertiary">{models.length} 个模型可用</p>
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-ink-tertiary">
              <Icon icon="mdi:loading" className="animate-spin text-sm" aria-hidden />
              加载中
            </span>
          )}
        </div>

        {message && <Alert bordered className="mb-4">{message}</Alert>}

        {models.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {models.map((model) => (
              <ModelCard key={model.model} model={model} />
            ))}
          </div>
        ) : !loading && !message ? (
          <div className="rounded-xl border border-dashed border-hairline-subtle bg-surface p-8 text-center text-sm text-ink-tertiary">
            暂无可用模型
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 卡片只展示展示名：内部模型 id 不出现在页面上。 */
export function ModelCard({ model }: { model: MarketplaceModel }) {
  return (
    <article className={cardClass()}>
      <h3 className="truncate text-base font-semibold text-ink">{model.displayName || "未命名模型"}</h3>
    </article>
  );
}
