import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { generateAgent, listAgents, type AgentOption } from "../api";
import { Modal, RippleButton } from "../motion";

interface AgentPickerProps {
  token: string;
  open: boolean;
  onClose: () => void;
  onSelect: (agent: AgentOption) => void;
}

type Mode = "list" | "create" | "creating" | "success";

export function AgentPicker({ token, open, onClose, onSelect }: AgentPickerProps) {
  const [mode, setMode] = useState<Mode>("list");
  const [presets, setPresets] = useState<AgentOption[]>([]);
  const [custom, setCustom] = useState<AgentOption[]>([]);
  const [query, setQuery] = useState("");
  const [requirement, setRequirement] = useState("");
  const [created, setCreated] = useState<AgentOption | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("list");
    setError("");
    setQuery("");
    setRequirement("");
    setCreated(null);
    setLoading(true);
    listAgents(token)
      .then((data) => {
        setPresets(data.presets);
        setCustom(data.custom);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [open, token]);

  const visiblePresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((agent) =>
      `${agent.name} ${agent.description}`.toLowerCase().includes(q)
    );
  }, [presets, query]);

  const createAgent = async () => {
    const text = requirement.trim();
    if (!text) {
      setError("请先描述想创建的智能体");
      return;
    }
    setError("");
    setMode("creating");
    try {
      const agent = await generateAgent(token, text);
      setCreated(agent);
      setMode("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
      setMode("create");
    }
  };

  const choose = (agent: AgentOption) => {
    onSelect(agent);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="w-full max-w-2xl max-h-[86vh] bg-surface rounded-2xl shadow-xl border border-hairline-subtle flex flex-col overflow-hidden mx-4"
    >
        <div className="px-5 py-4 border-b border-hairline-subtle flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-ink">
              {mode === "create" ? "创建智能体" : mode === "creating" ? "正在创建智能体" : mode === "success" ? "创建成功" : "选择 Agent"}
            </h3>
            <p className="text-xs text-ink-tertiary mt-1">
              {mode === "list" ? "选择后将开启一段新的对话" : "生成过程会自动使用备用模型兜底"}
            </p>
          </div>
          <RippleButton
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-secondary"
            aria-label="关闭"
          >
            <Icon icon="mdi:close" className="text-lg" />
          </RippleButton>
        </div>

        {error && (
          <div className="mx-5 mt-4 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm">
            {error}
          </div>
        )}

        {mode === "list" && (
          <>
            <div className="p-5 pb-3">
              <div className="relative">
                <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary text-lg" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索 Agent"
                  className="w-full h-10 pl-10 pr-3 border border-hairline-subtle rounded-xl text-sm focus:outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
              {loading ? (
                <div className="py-16 text-center text-sm text-ink-tertiary">加载中...</div>
              ) : (
                <div className="space-y-5">
                  {custom.length > 0 && (
                    <section>
                      <p className="text-xs font-medium text-ink-tertiary mb-2">我的智能体</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {custom.map((agent) => (
                          <AgentCard key={agent.id} agent={agent} onClick={() => choose(agent)} />
                        ))}
                      </div>
                    </section>
                  )}

                  <section>
                    <p className="text-xs font-medium text-ink-tertiary mb-2">预设 Agent</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {visiblePresets.map((agent) => (
                        <AgentCard key={agent.id} agent={agent} onClick={() => choose(agent)} />
                      ))}
                    </div>
                    {visiblePresets.length === 0 && (
                      <div className="py-10 text-center text-sm text-ink-tertiary">没有匹配的 Agent</div>
                    )}
                  </section>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-hairline-subtle">
              <RippleButton
                type="button"
                onClick={() => {
                  setError("");
                  setMode("create");
                }}
                className="w-full rounded-xl border border-dashed border-brand/40 bg-brand-soft/50 px-4 py-3 text-left flex items-center gap-3 transition-colors"
              >
                <span className="w-9 h-9 rounded-lg bg-brand text-white flex items-center justify-center flex-none">
                  <Icon icon="mdi:creation-outline" className="text-lg" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-brand-ink">创建智能体</span>
                  <span className="block text-xs text-ink-secondary mt-0.5">根据你的描述生成新的专属 Agent</span>
                </span>
              </RippleButton>
            </div>
          </>
        )}

        {mode === "create" && (
          <div className="p-5 space-y-4">
            <textarea
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="例如：帮我创建一个能做项目复盘、拆解风险、输出下一步行动清单的智能体"
              className="w-full h-40 rounded-xl border border-hairline-subtle p-4 text-sm resize-none focus:outline-none focus:border-brand"
            />
            <div className="flex justify-end gap-2">
              <RippleButton type="button" onClick={() => setMode("list")} className="px-4 py-2 rounded-lg text-sm text-ink-secondary ">
                返回
              </RippleButton>
              <RippleButton type="button" onClick={createAgent} className="px-4 py-2 rounded-lg text-sm bg-brand text-white">
                开始创建
              </RippleButton>
            </div>
          </div>
        )}

        {mode === "creating" && (
          <div className="p-8 min-h-72 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
            <p className="text-sm font-semibold text-ink mt-5">正在创建智能体</p>
            <p className="text-xs text-ink-tertiary mt-2">如果主模型不可用，会自动切换备用模型</p>
          </div>
        )}

        {mode === "success" && created && (
          <div className="p-8 min-h-72 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-full bg-brand-soft text-brand flex items-center justify-center">
              <Icon icon="mdi:check" className="text-2xl" />
            </div>
            <p className="text-base font-bold text-ink mt-5">{created.name}</p>
            <p className="text-sm text-ink-secondary mt-2 max-w-md">{created.description || "智能体已创建完成"}</p>
            <RippleButton
              type="button"
              onClick={() => choose(created)}
              className="mt-6 px-5 py-2.5 rounded-lg bg-brand text-white text-sm font-medium"
            >
              确定并开始对话
            </RippleButton>
          </div>
        )}
    </Modal>
  );
}

function AgentCard({ agent, onClick }: { agent: AgentOption; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="p-3 rounded-xl border border-hairline-subtle text-left transition-colors"
    >
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-lg bg-brand-soft text-brand flex items-center justify-center flex-none">
          <Icon icon={agent.icon || (agent.type === "custom" ? "mdi:account-star-outline" : "mdi:robot-outline")} className="text-lg" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink truncate">{agent.name}</span>
          <span className="block text-xs text-ink-tertiary mt-1 line-clamp-2">{agent.description || "通用智能体"}</span>
        </span>
      </div>
    </button>
  );
}
