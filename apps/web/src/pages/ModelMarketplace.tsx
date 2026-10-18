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
 *
 * 版面（2026-10-15 改版）：原来这屏是「H1 28px + 说明句 '查看当前账号可用的模型' + 小字 '8 个模型可用'
 * + 2 列 66px 只写名字的白条」，三处都在说同一件事，铺满整屏却给不出任何可比较的信息。
 * 现在：页名进上下文条（`PageHeader`），报数改成条带右侧的一行弱信息、只在拉到之后出现，
 * 说明句删掉；卡片换成 `sm` 内距 + `md` 圆角的紧凑档，宽屏 4 列 —— 卡片上仍然只有展示名，
 * 额外给一枚首字符徽标当视觉锚点（由展示名派生，不编造数据）。
 */
import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import { useModelCatalog } from "../app/useModelCatalog";
import type { ModelOption } from "../api";
import { Alert, PageHeader, cardClass } from "../components/ui";
import { Stagger, staggerItem } from "../motion/PageTransition";

/**
 * 模型卡。卡片体单独导出是给测试用的（`ModelMarketplace.test.tsx` 断言缺省文案），
 * 网格里那一份挂 `variants={staggerItem}` 参与依次入场 —— 同一个函数、两处调用，
 * 不复制两份实现。
 */
export function ModelCard({ model }: { readonly model: ModelOption }) {
  const name = model.displayName || "未命名模型";

  return (
    <article className={cardClass({ padding: "sm", radius: "md", className: "flex items-center gap-3" })}>
      <ModelCardBadge name={name} />
      <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{name}</h3>
    </article>
  );
}

/** 首字符徽标：一屏八张卡、卡上又只有一个词，给枚头像位才能被人眼分开。取展示名首字符，不引入新数据 */
function ModelCardBadge({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="grid h-7 w-7 flex-none place-items-center rounded-[10px] bg-surface-subtle text-xs font-semibold text-ink-secondary"
    >
      {name.slice(0, 1)}
    </span>
  );
}

export default function ModelMarketplace() {
  const catalog = useModelCatalog();
  const ready = catalog.status === "ready" && catalog.models.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-muted">
      {/* 报数只在拉到了之后出现：加载中写「0 个模型可用」是上一版的毛病。
          宽度档与下面的网格一致，页名与首张卡片同一个左起点 */}
      <PageHeader title="模型广场" meta={ready ? `${catalog.models.length} 个模型可用` : undefined} maxWidth="max-w-6xl" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
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
              // 依次入场由 `Stagger` 下发 staggerChildren，卡片自己挂 `variants={staggerItem}`。
              // 第 7 项之后不再累加延迟 —— 账号里模型多时，后面的不能等到天荒地老。
              <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {catalog.models.map((model) => (
                  // `staggerItem` 的 y 只有 12px、曲线 bouncy：卡片是新长出来的一批，
                  // 幅度可以比整页转场大，但比聊天气泡小 —— 一屏四到八张一起动，晃大了会散。
                  <motion.article
                    key={model.model}
                    variants={staggerItem}
                    className={cardClass({ padding: "sm", radius: "md", className: "flex items-center gap-3" })}
                  >
                    <ModelCardBadge name={model.displayName || "未命名模型"} />
                    <h3 className="min-w-0 truncate text-sm font-semibold text-ink">
                      {model.displayName || "未命名模型"}
                    </h3>
                  </motion.article>
                ))}
              </Stagger>
            ))}
        </div>
      </div>
    </div>
  );
}
