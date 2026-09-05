/**
 * 模型广场：把当前账号能用的模型铺成卡片。
 *
 * 重写时收掉的三处：
 *  - **`models` / `loading` / `message` 三个 flag 收成一档状态**。原来正文是
 *    `models.length > 0 ? 网格 : !loading && !message ? 空态 : null` —— 最后那个 `null`
 *    分支存在的唯一理由就是盖住「还在拉」这一档；而「N 个模型可用」在拉回来之前就已经
 *    写着「0 个模型可用」了。现在三档各说各的话，计数只在拉到了之后出现。
 *  - **effect 开头的 `setLoading(true)` / `setMessage("")` 去掉**：依赖表是空的，这两句
 *    唯一可能执行的时机是首挂，而首挂时两个 state 本来就是这个值 —— 是当初有刷新按钮时的化石。
 *  - **不再另起一份 `MarketplaceModel`**：字段与 `api.ts` 的 `ModelOption` 逐字相同，
 *    多一份类型只是多一个会分叉的地方。
 *
 * 拉取那段与设置页共用 `app/useModelCatalog`，两边只有「失败了怎么说」不一样。
 */
import { Icon } from "@iconify/react";
import { useModelCatalog } from "../app/useModelCatalog";
import type { ModelOption } from "../api";
import { Alert, cardClass } from "../components/ui";

/** 卡片只展示展示名：内部模型 id 不出现在页面上。 */
export function ModelCard({ model }: { readonly model: ModelOption }) {
  return (
    <article className={cardClass()}>
      <h3 className="truncate text-base font-semibold text-ink">{model.displayName || "未命名模型"}</h3>
    </article>
  );
}

export default function ModelMarketplace() {
  const catalog = useModelCatalog();

  return (
    <div className="flex-1 overflow-auto bg-surface-muted">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-6">
          <h1 className="text-[28px] font-bold tracking-tight text-ink">模型广场</h1>
          <p className="mt-1 text-sm text-ink-secondary">查看当前账号可用的模型</p>
        </div>

        {catalog.status === "loading" && (
          <p className="flex items-center gap-2 text-xs text-ink-tertiary">
            <Icon icon="mdi:loading" aria-hidden className="animate-spin text-sm" />
            加载中
          </p>
        )}

        {catalog.status === "failed" && <Alert bordered>模型广场加载失败：{catalog.reason}</Alert>}

        {catalog.status === "ready" &&
          (catalog.models.length === 0 ? (
            <p className="rounded-xl border border-dashed border-hairline-subtle bg-surface p-8 text-center text-sm text-ink-tertiary">
              暂无可用模型
            </p>
          ) : (
            <>
              <p className="mb-4 text-xs text-ink-tertiary">{catalog.models.length} 个模型可用</p>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {catalog.models.map((model) => (
                  <ModelCard key={model.model} model={model} />
                ))}
              </div>
            </>
          ))}
      </div>
    </div>
  );
}
