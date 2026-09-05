import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../apiError";
import { Icon } from "@iconify/react";
import { generateAgent, listAgents, type AgentOption } from "../api";
import { Modal, RippleButton } from "../motion";
import { cx } from "./ui";

const SHELL =
  "mx-4 flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline-subtle bg-surface shadow-xl";
const HEAD = "flex items-center justify-between border-b border-hairline-subtle px-5 py-4";
const BANNER = "mx-5 mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger-ink";
const SEARCH = "h-10 w-full rounded-xl border border-hairline-subtle pl-10 pr-3 text-sm focus:border-brand focus:outline-none";
const GRID = "grid grid-cols-1 gap-2 sm:grid-cols-2";
const GROUP_TITLE = "mb-2 text-xs font-medium text-ink-tertiary";
const HINT = "text-center text-sm text-ink-tertiary";
/** 中间那种「只有一句话 + 一个图形」的整屏状态（正在创建 / 创建成功） */
const STAGE = "flex min-h-72 flex-col items-center justify-center p-8 text-center";
const CARD = "rounded-xl border border-hairline-subtle p-3 text-left transition-colors";
const TEXTAREA = "h-40 w-full resize-none rounded-xl border border-hairline-subtle p-4 text-sm focus:border-brand focus:outline-none";

/** 四种模样轮流占满弹窗：挑一个 / 描述需求 / 等生成 / 生成好了 */
type Mode = "list" | "create" | "creating" | "success";

const HEADING: Record<Mode, string> = {
  list: "选择 Agent",
  create: "创建智能体",
  creating: "正在创建智能体",
  success: "创建成功",
};

interface Catalog {
  readonly presets: AgentOption[];
  readonly custom: AgentOption[];
}

const EMPTY_CATALOG: Catalog = { presets: [], custom: [] };

/** 预设有 83 个，靠关键词收窄；名字和简介一起搜。 */
function matches(agent: AgentOption, keyword: string): boolean {
  return `${agent.name} ${agent.description}`.toLowerCase().includes(keyword);
}

function fallbackIcon(agent: AgentOption): string {
  return agent.type === "custom" ? "mdi:account-star-outline" : "mdi:robot-outline";
}
function AgentCard({ agent, onPick }: { readonly agent: AgentOption; readonly onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} className={CARD}>
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Icon icon={agent.icon || fallbackIcon(agent)} className="text-lg" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-ink">{agent.name}</span>
          <span className="mt-1 block line-clamp-2 text-xs text-ink-tertiary">{agent.description || "通用智能体"}</span>
        </span>
      </div>
    </button>
  );
}

/** 一组卡片。「我的智能体」在没有自建 Agent 时整组不出现，预设那组留着放搜不到的提示。 */
function AgentGroup({
  title,
  agents,
  emptyNote,
  onPick,
}: {
  readonly title: string;
  readonly agents: AgentOption[];
  readonly emptyNote?: string;
  readonly onPick: (agent: AgentOption) => void;
}) {
  return (
    <section>
      <p className={GROUP_TITLE}>{title}</p>
      <div className={GRID}>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onPick={() => onPick(agent)} />
        ))}
      </div>
      {agents.length === 0 && emptyNote !== undefined && <p className={cx(HINT, "py-10")}>{emptyNote}</p>}
    </section>
  );
}
function PickerHead({ mode, onClose }: { readonly mode: Mode; readonly onClose: () => void }) {
  return (
    <div className={HEAD}>
      <div>
        <h3 className="text-base font-bold text-ink">{HEADING[mode]}</h3>
        <p className="mt-1 text-xs text-ink-tertiary">
          {mode === "list" ? "选择后将开启一段新的对话" : "生成过程会自动使用备用模型兜底"}
        </p>
      </div>
      <RippleButton
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-secondary"
      >
        <Icon icon="mdi:close" className="text-lg" />
      </RippleButton>
    </div>
  );
}

/** 描述需求那一屏。文字为空时的拦截放在提交那侧，这里只管收字。 */
function CreateForm({
  value,
  onChange,
  onBack,
  onSubmit,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="space-y-4 p-5">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：帮我创建一个能做项目复盘、拆解风险、输出下一步行动清单的智能体"
        className={TEXTAREA}
      />
      <div className="flex justify-end gap-2">
        <RippleButton type="button" onClick={onBack} className="rounded-lg px-4 py-2 text-sm text-ink-secondary">
          返回
        </RippleButton>
        <RippleButton type="button" onClick={onSubmit} className="rounded-lg bg-brand px-4 py-2 text-sm text-white">
          开始创建
        </RippleButton>
      </div>
    </div>
  );
}
function Creating() {
  return (
    <div className={STAGE}>
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-brand/20 border-t-brand" />
      <p className="mt-5 text-sm font-semibold text-ink">正在创建智能体</p>
      <p className="mt-2 text-xs text-ink-tertiary">如果主模型不可用，会自动切换备用模型</p>
    </div>
  );
}

function Created({ agent, onStart }: { readonly agent: AgentOption; readonly onStart: () => void }) {
  return (
    <div className={STAGE}>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
        <Icon icon="mdi:check" className="text-2xl" />
      </div>
      <p className="mt-5 text-base font-bold text-ink">{agent.name}</p>
      <p className="mt-2 max-w-md text-sm text-ink-secondary">{agent.description || "智能体已创建完成"}</p>
      <RippleButton
        type="button"
        onClick={onStart}
        className="mt-6 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white"
      >
        确定并开始对话
      </RippleButton>
    </div>
  );
}
/** 挑一个的那一屏：搜索框 + 两组卡片 + 底部「换成自己造一个」的入口。 */
function PickList({
  query,
  onQuery,
  loading,
  custom,
  presets,
  onPick,
  onCreate,
}: {
  readonly query: string;
  readonly onQuery: (next: string) => void;
  readonly loading: boolean;
  readonly custom: AgentOption[];
  readonly presets: AgentOption[];
  readonly onPick: (agent: AgentOption) => void;
  readonly onCreate: () => void;
}) {
  return (
    <>
      <div className="p-5 pb-3">
        <div className="relative">
          <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-lg text-ink-tertiary" />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索 Agent" className={SEARCH} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {loading ? (
          <p className={cx(HINT, "py-16")}>加载中...</p>
        ) : (
          <div className="space-y-5">
            {custom.length > 0 && <AgentGroup title="我的智能体" agents={custom} onPick={onPick} />}
            <AgentGroup title="预设 Agent" agents={presets} emptyNote="没有匹配的 Agent" onPick={onPick} />
          </div>
        )}
      </div>

      <div className="border-t border-hairline-subtle p-5">
        <RippleButton
          type="button"
          onClick={onCreate}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-brand/40 bg-brand-soft/50 px-4 py-3 text-left transition-colors"
        >
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand text-white">
            <Icon icon="mdi:creation-outline" className="text-lg" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-brand-ink">创建智能体</span>
            <span className="mt-0.5 block text-xs text-ink-secondary">根据你的描述生成新的专属 Agent</span>
          </span>
        </RippleButton>
      </div>
    </>
  );
}
interface AgentPickerProps {
  readonly token: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (agent: AgentOption) => void;
}

/**
 * 开新对话前先挑一个 Agent：预设里选，或者描述一句让模型现造一个。
 * 造出来的那个直接进入对话，不用回列表里再找一遍。
 */
export function AgentPicker({ token, open, onClose, onSelect }: AgentPickerProps) {
  const [mode, setMode] = useState<Mode>("list");
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [requirement, setRequirement] = useState("");
  const [created, setCreated] = useState<AgentOption | null>(null);
  const [error, setError] = useState("");

  // 每次打开都当第一次用：上回留下的关键词、草稿、报错都不跟过来
  useEffect(() => {
    if (!open) return;
    setMode("list");
    setError("");
    setQuery("");
    setRequirement("");
    setCreated(null);
    setLoading(true);
    void (async () => {
      try {
        const data = await listAgents(token);
        setCatalog({ presets: data.presets, custom: data.custom });
      } catch (failure) {
        setError(errorMessage(failure, "加载失败"));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, token]);

  const visiblePresets = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === "") return catalog.presets;
    return catalog.presets.filter((agent) => matches(agent, keyword));
  }, [catalog.presets, query]);

  const choose = (agent: AgentOption) => {
    onSelect(agent);
    onClose();
  };

  /** 描述为空就别去打模型，直接在原地提示 */
  const generate = async () => {
    const text = requirement.trim();
    if (text === "") {
      setError("请先描述想创建的智能体");
      return;
    }
    setError("");
    setMode("creating");
    try {
      setCreated(await generateAgent(token, text));
      setMode("success");
    } catch (failure) {
      setError(errorMessage(failure, "创建失败"));
      setMode("create");
    }
  };

  return (
    <Modal open={open} onClose={onClose} className={SHELL}>
      <PickerHead mode={mode} onClose={onClose} />
      {error !== "" && <p className={BANNER}>{error}</p>}

      {mode === "list" && (
        <PickList
          query={query}
          onQuery={setQuery}
          loading={loading}
          custom={catalog.custom}
          presets={visiblePresets}
          onPick={choose}
          onCreate={() => {
            setError("");
            setMode("create");
          }}
        />
      )}
      {mode === "create" && (
        <CreateForm
          value={requirement}
          onChange={setRequirement}
          onBack={() => setMode("list")}
          onSubmit={() => void generate()}
        />
      )}
      {mode === "creating" && <Creating />}
      {mode === "success" && created !== null && <Created agent={created} onStart={() => choose(created)} />}
    </Modal>
  );
}
