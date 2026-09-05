import { useMemo, useState } from "react";
import { errorMessage } from "../../apiError";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "@iconify/react";
import type { AgentOption, Session } from "../../api";
import { deleteAgent, regenerateAgentAvatar, renameAgent, uploadAgentAvatar } from "../../api";
import { filterSessions } from "../../chatState";
import { useToast } from "../../motion";
import {
  agentIdOfSession,
  buildAgentRail,
  filterAgents,
  loadSelectedAgentId,
  saveSelectedAgentId,
  type AgentRailItem,
} from "../../shellState";
import { cx } from "../ui";
import { AgentAvatar } from "../AgentAvatar";
import { AgentActionMenu } from "./AgentActionMenu";
import { DeleteAgentDialog } from "./DeleteAgentDialog";
import { HoverPopover } from "./HoverPopover";

const RAIL = "hidden w-[220px] flex-none flex-col overflow-hidden border-r border-hairline-subtle bg-surface lg:flex";
const PANE = "flex min-h-0 flex-1 flex-col";
const PANE_HEAD = "flex-none border-b border-hairline-subtle p-4";
const PANE_BODY = "min-h-0 flex-1 overflow-y-auto px-2.5 py-3";
const PRIMARY =
  "flex w-full items-center justify-center space-x-2 rounded-full bg-brand px-4 py-2.5 text-sm font-medium text-white transition-all";
const SEARCH =
  "h-9 w-full rounded-lg border border-hairline-subtle bg-surface-subtle pl-9 pr-3 text-xs text-ink outline-none focus:border-brand/40 focus:bg-surface";
const EMPTY = "mt-12 text-center text-xs text-ink-tertiary";
const GROUP_TITLE = "mb-2 px-2 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary";

interface AgentRailProps {
  token: string;
  agents: { presets: AgentOption[]; custom: AgentOption[] };
  sessions: Session[];
  currentSessionId?: string;
  runningSessionIds: Set<string>;
  onSelectSession?: (id: string) => void;
  onNewSession?: (agentId: string) => void;
  onDeleteSession?: (id: string) => void;
  onOpenAgentPicker: () => void;
  onAgentsChanged: () => void;
  onRequestCollapse?: () => void;
}

/** 一行 Agent 能做的事。token 与「做完刷新」都在 AgentRail 那层绑好，行里只管调。 */
interface AgentOps {
  /** 正在跑接口的那个 Agent，同一时刻只允许一个 */
  readonly busyId: string | null;
  readonly open: (id: string) => void;
  readonly regenerate: (agent: AgentRailItem) => void;
  readonly upload: (agent: AgentRailItem, file: File) => void;
  readonly rename: (agent: AgentRailItem, name: string) => void;
  readonly askDelete: (agent: AgentRailItem) => void;
}

/** 两个面板左右滑着换：进来的从 dir 方向推入，出去的往反方向退出。 */
function slide(reduce: boolean, dir: 1 | -1) {
  if (reduce) return {};
  return {
    initial: { opacity: 0, x: 16 * dir },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -16 * dir },
    transition: { duration: 0.18 },
  };
}
/** 带放大镜的搜索框。两个面板各有一个，占位文案不同。 */
function SearchBox({
  value,
  placeholder,
  onChange,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (next: string) => void;
}) {
  return (
    <div className="relative mt-3">
      <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-ink-tertiary" aria-hidden />
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={SEARCH} />
    </div>
  );
}

/** 一行 Agent。⋯ 只给自建 Agent —— 预设助手的头像与名字是全局资源，改不动。 */
function AgentRow({ agent, ops }: { readonly agent: AgentRailItem; readonly ops: AgentOps }) {
  return (
    <div data-agent-row className="group flex items-center gap-2 rounded-lg px-2 py-2">
      <button type="button" onClick={() => ops.open(agent.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <AgentAvatar avatarUrl={agent.avatarUrl} avatarSvg={agent.avatarSvg} icon={agent.icon} size={32} name={agent.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink">{agent.name}</span>
          <span className="block text-[10px] text-ink-tertiary">{agent.sessionCount} 个对话</span>
        </span>
      </button>
      {agent.type === "custom" && (
        <HoverPopover
          content={
            <AgentActionMenu
              agent={agent}
              busy={ops.busyId === agent.id}
              onRegenerate={() => ops.regenerate(agent)}
              onUpload={(file) => ops.upload(agent, file)}
              onRename={(name) => ops.rename(agent, name)}
              onDelete={() => ops.askDelete(agent)}
            />
          }
        >
          <button type="button" aria-label="更多操作" className="flex-none rounded p-1 text-ink-tertiary transition-opacity">
            <Icon icon="mdi:dots-horizontal" className="text-base" />
          </button>
        </HoverPopover>
      )}
    </div>
  );
}

/** 分组标题 + 若干行。整组空了就整块不出现，不留一个孤零零的标题。 */
function AgentGroup({
  title,
  items,
  ops,
}: {
  readonly title: string;
  readonly items: AgentRailItem[];
  readonly ops: AgentOps;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      <p className={GROUP_TITLE}>{title}</p>
      {items.map((agent) => (
        <AgentRow key={agent.id} agent={agent} ops={ops} />
      ))}
    </div>
  );
}
/** 一行对话。整行可点进对话，行内的「删除」要拦掉冒泡，否则会顺手把它打开。 */
function SessionRow({
  session,
  agent,
  current,
  running,
  onOpen,
  onDelete,
}: {
  readonly session: Session;
  readonly agent: AgentRailItem;
  readonly current: boolean;
  readonly running: boolean;
  readonly onOpen: () => void;
  readonly onDelete?: () => void;
}) {
  return (
    <div onClick={onOpen} className={cx("group cursor-pointer rounded-lg p-2.5 transition-colors", current && "bg-surface-muted")}>
      <div className="flex items-center gap-2">
        <AgentAvatar avatarUrl={agent.avatarUrl} avatarSvg={agent.avatarSvg} icon={agent.icon} size={26} name={agent.name} />
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{session.title}</p>
        {running && <Icon icon="mdi:loading" className="flex-none animate-spin text-sm text-brand" aria-label="运行中" />}
      </div>
      {/* 左边距对齐上一行的标题：26px 头像 + 8px 间距 */}
      <div className="mt-1 flex items-center justify-between gap-2 pl-[34px]">
        <p className="text-[10px] text-ink-tertiary">{new Date(session.updatedAt).toLocaleDateString("zh-CN")}</p>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete?.();
          }}
          className="text-[10px] text-ink-tertiary"
        >
          删除
        </button>
      </div>
    </div>
  );
}
/**
 * 对话页左侧第二栏。两个面板轮流占满：没选 Agent 时列 Agent，选了就列它名下的对话，
 * 选择结果落 localStorage —— 刷新回来还停在同一个 Agent 上。
 */
export function AgentRail({
  token,
  agents,
  sessions,
  currentSessionId,
  runningSessionIds,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onOpenAgentPicker,
  onAgentsChanged,
  onRequestCollapse,
}: AgentRailProps) {
  const rail = useMemo(() => buildAgentRail(agents, sessions), [agents, sessions]);
  const allItems = useMemo(() => [...rail.mine, ...rail.used], [rail]);

  // 存的 id 可能指向已删掉的 Agent（别的设备删的），认不出就退回列表态
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const saved = loadSelectedAgentId();
    return saved && allItems.some((agent) => agent.id === saved) ? saved : null;
  });
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentRailItem | null>(null);
  const reduce = useReducedMotion() ?? false;
  const toast = useToast();

  const selected = allItems.find((agent) => agent.id === selectedId) ?? null;

  const select = (id: string | null) => {
    setSelectedId(id);
    saveSelectedAgentId(id);
    setQuery(""); // 上一面板的关键词留到下一面板只会让人以为「怎么少了几条」
  };

  const openAgent = (id: string) => {
    select(id);
    onNewSession?.(id);
    onRequestCollapse?.();
  };

  /** 头像 / 重命名 / 删除都走这里：跑的时候锁住该行，成了就让上层重取，失败弹 toast。 */
  const runAction = async (id: string, call: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await call();
      onAgentsChanged();
    } catch (error) {
      toast.show("err", errorMessage(error, "操作失败"));
    } finally {
      setBusyId(null);
    }
  };

  const ops: AgentOps = {
    busyId,
    open: openAgent,
    regenerate: (agent) => void runAction(agent.id, () => regenerateAgentAvatar(token, agent.id)),
    upload: (agent, file) => void runAction(agent.id, () => uploadAgentAvatar(token, agent.id, file)),
    rename: (agent, name) => void runAction(agent.id, () => renameAgent(token, agent.id, name)),
    askDelete: setPendingDelete,
  };

  const confirmDelete = async () => {
    if (pendingDelete === null) return;
    const target = pendingDelete;
    setPendingDelete(null);
    // 正看着这个 Agent 的对话就先退回列表，否则删完面板会指向一个不存在的 Agent
    if (selectedId === target.id) select(null);
    await runAction(target.id, () => deleteAgent(token, target.id));
  };
  const ownSessions = selected
    ? filterSessions(
        sessions.filter((session) => agentIdOfSession(session) === selected.id),
        query,
      )
    : [];

  return (
    <section className={RAIL}>
      <AnimatePresence mode="wait">
        {selected === null ? (
          <motion.div key="agents" {...slide(reduce, 1)} className={PANE}>
            <div className={PANE_HEAD}>
              <button type="button" onClick={onOpenAgentPicker} className={PRIMARY}>
                <Icon icon="mdi:plus" className="text-lg" aria-hidden />
                <span>新建 Agent</span>
              </button>
              <SearchBox value={query} placeholder="搜索 Agent" onChange={setQuery} />
            </div>
            <div className={PANE_BODY}>
              <AgentGroup title="我的 Agent" items={filterAgents(rail.mine, query)} ops={ops} />
              <AgentGroup title="用过的助手" items={filterAgents(rail.used, query)} ops={ops} />
              {allItems.length === 0 && <p className={EMPTY}>还没有 Agent</p>}
            </div>
          </motion.div>
        ) : (
          <motion.div key="sessions" {...slide(reduce, -1)} className={PANE}>
            <div className={PANE_HEAD}>
              <button type="button" onClick={() => select(null)} aria-label="返回 Agent 列表" className="mb-3 flex w-full items-center gap-2 text-left">
                <Icon icon="mdi:chevron-left" className="flex-none text-lg text-brand-ink" aria-hidden />
                <AgentAvatar avatarUrl={selected.avatarUrl} avatarSvg={selected.avatarSvg} icon={selected.icon} size={24} name={selected.name} />
                <span className="truncate text-sm font-semibold text-ink">{selected.name}</span>
              </button>
              <button type="button" onClick={() => onNewSession?.(selected.id)} className={PRIMARY}>
                <Icon icon="mdi:plus" className="text-lg" aria-hidden />
                <span>新对话</span>
              </button>
              <SearchBox value={query} placeholder="搜索对话" onChange={setQuery} />
            </div>
            <div className={PANE_BODY}>
              {ownSessions.length === 0 ? (
                <p className={EMPTY}>暂无对话</p>
              ) : (
                <div className="space-y-1">
                  {ownSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      agent={selected}
                      current={currentSessionId === session.id}
                      running={runningSessionIds.has(session.id)}
                      onOpen={() => {
                        onSelectSession?.(session.id);
                        onRequestCollapse?.();
                      }}
                      onDelete={onDeleteSession && (() => onDeleteSession(session.id))}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <DeleteAgentDialog
        open={pendingDelete !== null}
        agentName={pendingDelete?.name ?? ""}
        sessionCount={pendingDelete?.sessionCount ?? 0}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </section>
  );
}

