/**
 * 一轮对话里的工具调用时间线:折叠标题 +(展开后)每个工具一行 + 单行再展开的输出面板。
 * 从 `pages/Chat.tsx` 的 `renderToolActivities()` 原样搬出。
 *
 * **两级展开状态刻意留在 `Chat` 里**,不放进本组件:这块时间线在消息列表中有两个落点
 * (末条是助手消息时插在它前面,否则挂在列表末尾)。流式过程中助手文本一到,落点就会
 * 从后者切到前者 —— React 视作卸载+重挂,状态若在组件内就会被清空,用户刚展开的输出
 * 会自己收起来。
 */
import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import type { ToolActivity } from "../../chatState";
import { msgIn } from "../../motion";
import {
  isCommandTool,
  statusLabel,
  toolCommandText,
  toolDuration,
  toolGroupUnit,
  toolGroupVerb,
  toolStatusClassName,
  toolStatusIcon,
  toolStatusVerb,
} from "./chatToolPresentation";

export function ChatToolTimeline({
  toolActivities,
  groupExpanded,
  onToggleGroup,
  expandedToolIds,
  onToggleTool,
}: {
  readonly toolActivities: readonly ToolActivity[];
  readonly groupExpanded: boolean;
  readonly onToggleGroup: () => void;
  readonly expandedToolIds: ReadonlySet<string>;
  readonly onToggleTool: (id: string) => void;
}) {
  if (toolActivities.length === 0) return null;

  return (
    <motion.div
      variants={msgIn}
      initial="initial"
      animate="animate"
      className="flex items-start space-x-3"
    >
      <div className="w-8 h-8 rounded-lg bg-brand-soft flex items-center justify-center flex-none">
        <Icon icon="mdi:console-line" className="text-base text-brand-ink" aria-hidden />
      </div>
      <div className="min-w-0 max-w-[82%] sm:max-w-[70%]">
        <button
          type="button"
          onClick={onToggleGroup}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-ink-secondary transition-colors "
        >
          <Icon icon="mdi:console-line" className="text-sm flex-none text-ink-tertiary" aria-hidden />
          <span className="truncate">
            {toolGroupVerb(toolActivities)} {toolActivities.length} {toolGroupUnit(toolActivities)}
          </span>
          <Icon
            icon={groupExpanded ? "mdi:chevron-down" : "mdi:chevron-right"}
            className="text-sm flex-none text-ink-tertiary"
            aria-hidden
          />
        </button>

        {groupExpanded && (
          <div className="mt-2 space-y-2">
            <AnimatePresence mode="popLayout">
              {toolActivities.map((tool) => {
                const expanded = expandedToolIds.has(tool.id);
                const canExpand = Boolean(tool.outputPreview) || isCommandTool(tool);
                const duration = toolDuration(tool.elapsedMs);

                return (
                  <motion.div
                    key={tool.id}
                    layout
                    variants={msgIn}
                    initial="initial"
                    animate="animate"
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="min-w-0"
                  >
                  <button
                    type="button"
                    onClick={() => canExpand && onToggleTool(tool.id)}
                    className={`flex w-full min-w-0 items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left text-xs leading-5 text-ink-secondary transition-colors ${
                      canExpand ? " " : "cursor-default"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {toolStatusVerb(tool.status)} {toolCommandText(tool)}
                    </span>
                    <span className="flex items-center gap-1 flex-none text-[11px] text-ink-tertiary">
                      {duration && <span>{duration}</span>}
                      {canExpand && (
                        <Icon
                          icon={expanded ? "mdi:chevron-down" : "mdi:chevron-right"}
                          className="text-sm"
                          aria-hidden
                        />
                      )}
                    </span>
                  </button>

                  {expanded && (
                    <div className="mt-1 rounded-lg bg-surface-muted px-3 py-2.5 text-xs shadow-inner">
                      <div className="mb-2 text-[11px] font-medium text-ink-secondary">
                        {isCommandTool(tool) ? "Shell" : tool.label || tool.name}
                      </div>
                      <div className="font-mono text-[11px] leading-5 text-ink">
                        {isCommandTool(tool) && (
                          <div className="whitespace-pre-wrap break-words">$ {toolCommandText(tool)}</div>
                        )}
                        {tool.outputPreview && (
                          <div className="mt-1 whitespace-pre-wrap break-words text-ink-secondary">{tool.outputPreview}</div>
                        )}
                      </div>
                      <div className={`mt-2 flex items-center justify-end gap-1 text-[11px] ${toolStatusClassName(tool.status)}`}>
                        <Icon
                          icon={toolStatusIcon(tool.status)}
                          className={`text-sm ${tool.status === "started" ? "animate-spin" : ""}`}
                          aria-hidden
                        />
                        <span>{statusLabel(tool.status)}</span>
                      </div>
                    </div>
                  )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.div>
  );
}
