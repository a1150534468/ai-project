import { useState, useMemo } from "react";
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
import { AgentAvatar } from "../AgentAvatar";
import { AgentActionMenu } from "./AgentActionMenu";
import { DeleteAgentDialog } from "./DeleteAgentDialog";
import { HoverPopover } from "./HoverPopover";

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

export function AgentRail(props: AgentRailProps) {
  const { agents, sessions } = props;
  const rail = useMemo(() => buildAgentRail(agents, sessions), [agents, sessions]);
  const allItems = useMemo(() => [...rail.mine, ...rail.used], [rail]);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const saved = loadSelectedAgentId();
    return saved && allItems.some((a) => a.id === saved) ? saved : null;
  });
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentRailItem | null>(null);
  const reduce = useReducedMotion();
  const toast = useToast();

  const selected = allItems.find((a) => a.id === selectedId) ?? null;

  const openAgent = (id: string) => {
    setSelectedId(id);
    saveSelectedAgentId(id);
    setQuery("");
    props.onNewSession?.(id);
    props.onRequestCollapse?.();
  };

  const backToAgents = () => {
    setSelectedId(null);
    saveSelectedAgentId(null);
    setQuery("");
  };

  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      props.onAgentsChanged();
    } catch (e) {
      toast.show("err", e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const slide = (dir: 1 | -1) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, x: 16 * dir },
          animate: { opacity: 1, x: 0 },
          exit: { opacity: 0, x: -16 * dir },
          transition: { duration: 0.18 },
        };

  return (
    <section className="hidden w-[220px] flex-none flex-col overflow-hidden border-r border-gray-100 bg-surface lg:flex">
      <AnimatePresence mode="wait">
        {selected === null ? (
          <motion.div key="agents" {...slide(1)} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-gray-100 p-4">
              <button
                onClick={props.onOpenAgentPicker}
                className="flex w-full items-center justify-center space-x-2 rounded-full bg-brand px-4 py-2.5 text-sm font-medium text-white transition-all "
              >
                <Icon icon="mdi:plus" className="text-lg" aria-hidden />
                <span>新建 Agent</span>
              </button>
              <SearchInput value={query} onChange={setQuery} placeholder="搜索 Agent" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
              <AgentGroup
                title="我的 Agent"
                items={filterAgents(rail.mine, query)}
                busyId={busyId}
                openAgent={openAgent}
                runAction={runAction}
                setPendingDelete={setPendingDelete}
                token={props.token}
              />
              <AgentGroup
                title="用过的助手"
                items={filterAgents(rail.used, query)}
                busyId={busyId}
                openAgent={openAgent}
                runAction={runAction}
                setPendingDelete={setPendingDelete}
                token={props.token}
              />
              {allItems.length === 0 && <p className="mt-12 text-center text-xs text-gray-400">还没有 Agent</p>}
            </div>
          </motion.div>
        ) : (
          <motion.div key="sessions" {...slide(-1)} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-none border-b border-gray-100 p-4">
              <button
                onClick={backToAgents}
                aria-label="返回 Agent 列表"
                className="mb-3 flex w-full items-center gap-2 text-left"
              >
                <Icon icon="mdi:chevron-left" className="flex-none text-lg text-brand-ink" aria-hidden />
                <AgentAvatar
                  avatarUrl={selected.avatarUrl}
                  avatarSvg={selected.avatarSvg}
                  icon={selected.icon}
                  size={24}
                  name={selected.name}
                />
                <span className="truncate text-sm font-semibold text-gray-800">{selected.name}</span>
              </button>
              <button
                onClick={() => props.onNewSession?.(selected.id)}
                className="flex w-full items-center justify-center space-x-2 rounded-full bg-brand px-4 py-2.5 text-sm font-medium text-white transition-all "
              >
                <Icon icon="mdi:plus" className="text-lg" aria-hidden />
                <span>新对话</span>
              </button>
              <SearchInput value={query} onChange={setQuery} placeholder="搜索对话" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
              <SessionList
                sessions={filterSessions(
                  sessions.filter((s) => agentIdOfSession(s) === selected.id),
                  query
                )}
                agent={selected}
                currentSessionId={props.currentSessionId}
                runningSessionIds={props.runningSessionIds}
                onSelectSession={(id) => {
                  props.onSelectSession?.(id);
                  props.onRequestCollapse?.();
                }}
                onDeleteSession={props.onDeleteSession}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <DeleteAgentDialog
        open={pendingDelete !== null}
        agentName={pendingDelete?.name ?? ""}
        sessionCount={pendingDelete?.sessionCount ?? 0}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete!;
          setPendingDelete(null);
          if (selectedId === target.id) backToAgents();
          await runAction(target.id, () => deleteAgent(props.token, target.id));
        }}
      />
    </section>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mt-3">
      <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-gray-400" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-gray-100 bg-gray-50 pl-9 pr-3 text-xs text-gray-700 outline-none focus:border-brand/40 focus:bg-surface"
      />
    </div>
  );
}

function SessionList({
  sessions,
  agent,
  currentSessionId,
  runningSessionIds,
  onSelectSession,
  onDeleteSession,
}: {
  sessions: Session[];
  agent: AgentRailItem;
  currentSessionId?: string;
  runningSessionIds: Set<string>;
  onSelectSession?: (id: string) => void;
  onDeleteSession?: (id: string) => void;
}) {
  if (sessions.length === 0) return <p className="mt-12 text-center text-xs text-gray-400">暂无对话</p>;
  return (
    <div className="space-y-1">
      {sessions.map((session) => (
        <div
          key={session.id}
          onClick={() => onSelectSession?.(session.id)}
          className={`group cursor-pointer rounded-lg p-2.5 transition-colors ${
            currentSessionId === session.id ? "bg-surface-muted" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <AgentAvatar
              avatarUrl={agent.avatarUrl}
              avatarSvg={agent.avatarSvg}
              icon={agent.icon}
              size={26}
              name={agent.name}
            />
            <p className="min-w-0 flex-1 truncate text-xs font-medium text-gray-800">{session.title}</p>
            {runningSessionIds.has(session.id) && (
              <Icon icon="mdi:loading" className="flex-none animate-spin text-sm text-brand" aria-label="运行中" />
            )}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 pl-[34px]">
            <p className="text-[10px] text-gray-400">{new Date(session.updatedAt).toLocaleDateString("zh-CN")}</p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSession?.(session.id);
              }}
              className="text-[10px] text-gray-400 opacity-100 transition-opacity "
            >
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentGroup({
  title,
  items,
  busyId,
  openAgent,
  runAction,
  setPendingDelete,
  token,
}: {
  title: string;
  items: AgentRailItem[];
  busyId: string | null;
  openAgent: (id: string) => void;
  runAction: (id: string, fn: () => Promise<unknown>) => Promise<void>;
  setPendingDelete: (a: AgentRailItem) => void;
  token: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wide text-gray-400">{title}</p>
      {items.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          busyId={busyId}
          openAgent={openAgent}
          runAction={runAction}
          setPendingDelete={setPendingDelete}
          token={token}
        />
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  busyId,
  openAgent,
  runAction,
  setPendingDelete,
  token,
}: {
  agent: AgentRailItem;
  busyId: string | null;
  openAgent: (id: string) => void;
  runAction: (id: string, fn: () => Promise<unknown>) => Promise<void>;
  setPendingDelete: (a: AgentRailItem) => void;
  token: string;
}) {
  return (
    <div data-agent-row className="group flex items-center gap-2 rounded-lg px-2 py-2 ">
      <button onClick={() => openAgent(agent.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <AgentAvatar
          avatarUrl={agent.avatarUrl}
          avatarSvg={agent.avatarSvg}
          icon={agent.icon}
          size={32}
          name={agent.name}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-gray-800">{agent.name}</span>
          <span className="block text-[10px] text-gray-400">{agent.sessionCount} 个对话</span>
        </span>
      </button>
      {agent.type === "custom" && (
        <HoverPopover
          content={
            <AgentActionMenu
              agent={agent}
              busy={busyId === agent.id}
              onRegenerate={() => void runAction(agent.id, () => regenerateAgentAvatar(token, agent.id))}
              onUpload={(file) => void runAction(agent.id, () => uploadAgentAvatar(token, agent.id, file))}
              onRename={(name) => void runAction(agent.id, () => renameAgent(token, agent.id, name))}
              onDelete={() => setPendingDelete(agent)}
            />
          }
        >
          <button
            aria-label="更多操作"
            className="flex-none rounded p-1 text-gray-300 opacity-100 transition-opacity "
          >
            <Icon icon="mdi:dots-horizontal" className="text-base" />
          </button>
        </HoverPopover>
      )}
    </div>
  );
}
