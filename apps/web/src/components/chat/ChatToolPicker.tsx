/**
 * 「挂载工具」弹层。从 `pages/Chat.tsx` 原样搬出。
 *
 * 三条不能动的规则:
 *  - **列表只给当前设备可用的工具**(过滤发生在 `useChatComposerState.refreshInstalledTools`,
 *    本组件拿到的 `tools` 已经是过滤后的)。
 *  - **勾选写的是草稿**,「确定」才落地,「取消」直接丢弃;「关闭工具」把已生效的一起清掉。
 *  - **加载失败要显示错误而不是一直转圈**:`loading` 与 `error` 是两个独立的 props。
 */
import { Icon } from "@iconify/react";
import type { InstalledTool } from "../../api";

export function ChatToolPicker({
  open,
  tools,
  draftSelectedToolIds,
  loading,
  error,
  onToggleTool,
  onClose,
  onApply,
  onDisable,
  onOpenMarket,
}: {
  readonly open: boolean;
  readonly tools: readonly InstalledTool[];
  readonly draftSelectedToolIds: readonly string[];
  readonly loading: boolean;
  readonly error: string;
  readonly onToggleTool: (toolName: string) => void;
  readonly onClose: () => void;
  readonly onApply: () => void;
  readonly onDisable: () => void;
  readonly onOpenMarket: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/20 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-surface border border-hairline-subtle shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-hairline-subtle flex items-center justify-between gap-4">
          <div>
            <h4 className="text-base font-bold text-ink">挂载工具</h4>
            <p className="text-xs text-ink-secondary mt-1">
              {draftSelectedToolIds.length} 个已选择，{tools.length} 个可挂载
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenMarket}
              className="h-8 rounded-lg border border-hairline-subtle px-3 text-xs font-medium text-ink "
            >
              工具市场
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-secondary"
              aria-label="关闭"
            >
              <Icon icon="mdi:close" className="text-lg" />
            </button>
          </div>
        </div>

        <div className="p-5">
          {error && (
            <div className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger-ink">{error}</div>
          )}
          {loading ? (
            <div className="flex min-h-56 items-center justify-center text-sm text-ink-tertiary">
              <Icon icon="mdi:loading" className="mr-2 text-lg animate-spin" aria-hidden />
              正在加载已安装工具
            </div>
          ) : tools.length > 0 ? (
            <div className="max-h-[28rem] overflow-y-auto space-y-2 pr-1">
              {tools.map((tool) => {
                const checked = draftSelectedToolIds.includes(tool.toolName);
                return (
                  <button
                    key={tool.toolName}
                    type="button"
                    onClick={() => onToggleTool(tool.toolName)}
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-colors flex items-start gap-3 ${
                      checked
                        ? "border-brand/30 bg-brand-soft text-brand-ink"
                        : "border-hairline-subtle text-ink "
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-none ${
                        checked ? "bg-brand border-brand text-white" : "border-hairline"
                      }`}
                    >
                      {checked && <Icon icon="mdi:check" className="text-xs" aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{tool.name}</span>
                      <span className="mt-1 block line-clamp-2 text-xs leading-5 text-ink-tertiary">{tool.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-hairline-subtle px-6 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-subtle text-ink-secondary">
                <Icon icon="mdi:toolbox-outline" className="text-xl" aria-hidden />
              </div>
              <p className="text-sm font-semibold text-ink">暂无已安装工具</p>
              <p className="mt-1 text-xs leading-5 text-ink-secondary">先到工具市场安装 skill，再回到对话中挂载使用。</p>
              <button
                type="button"
                onClick={onOpenMarket}
                className="mt-4 h-9 rounded-lg bg-surface-inverse px-4 text-xs font-medium text-ink-inverse "
              >
                打开工具市场
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-hairline-subtle flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onDisable}
            className="px-3 py-2 rounded-lg text-sm text-danger-ink "
          >
            关闭工具
          </button>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-ink-secondary "
            >
              取消
            </button>
            <button
              type="button"
              onClick={onApply}
              className="px-4 py-2 rounded-lg text-sm bg-brand text-white"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
