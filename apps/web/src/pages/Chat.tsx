import { Fragment, useState, useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  listModels,
  listKb,
  listInstalledTools,
  type ChatAttachmentPayload,
  type InstalledTool,
  type KnowledgeBase,
} from "../api";
import { AgentAvatar } from "../components/AgentAvatar";
import { AssistantMessageActions } from "../components/AssistantMessageActions";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { pickInitialModel, type ChatMessage, type ToolActivity } from "../chatState";
import {
  CHAT_ATTACHMENT_ACCEPT,
  filesToChatAttachments,
  stripAttachmentForApi,
  type ChatAttachment,
} from "../chatAttachments";
import { msgIn, RippleButton } from "../motion";

interface Citation {
  docs: Array<{ docName: string; ordinal: number }>;
}

// 流式生成中：在正在输出的助手消息末尾显示一个品牌色闪烁光标，
// 让用户清楚「还在生成」，而不是卡住或已结束。
function StreamingCaret() {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-label="正在生成"
      className="ml-0.5 inline-block h-[1.05em] w-[3px] translate-y-[2px] rounded-full bg-brand align-baseline"
      animate={reduced ? undefined : { opacity: [1, 0.15, 1] }}
      transition={reduced ? undefined : { duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

function TypingIndicator({ agentIcon, agentAvatarSvg, agentAvatarUrl, agentName }: {
  agentIcon: string;
  agentAvatarSvg?: string | null;
  agentAvatarUrl?: string | null;
  agentName: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      variants={msgIn}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      className="flex items-start space-x-3"
    >
      <AgentAvatar avatarUrl={agentAvatarUrl} avatarSvg={agentAvatarSvg} icon={agentIcon} size={40} name={agentName} />
      <div className="rounded-2xl rounded-tl-none p-4 bg-gray-50 border border-gray-100">
        <div className="flex space-x-1">
          <motion.span
            className="w-2 h-2 bg-gray-400 rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.span
            className="w-2 h-2 bg-gray-400 rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
          />
          <motion.span
            className="w-2 h-2 bg-gray-400 rounded-full"
            animate={reduced ? undefined : { y: [0, -3, 0] }}
            transition={reduced ? undefined : { duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
          />
        </div>
      </div>
    </motion.div>
  );
}

interface ChatProps {
  token: string;
  sessionId?: string;
  sessionTitle?: string;
  agentName?: string;
  agentIcon?: string;
  agentAvatarSvg?: string | null;
  agentAvatarUrl?: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string;
  citations?: Citation[];
  toolActivities?: ToolActivity[];
  selectedModel: string;
  preferredModel?: string;
  onModelChange: (model: string) => void;
  onOpenToolMarket: () => void;
  onSend: (payload: {
    message: string;
    model?: string;
    kbIds?: string[];
    attachAllOwn?: boolean;
    toolIds?: string[];
    attachments?: ChatAttachmentPayload[];
  }) => void;
  agentPanelCollapsed?: boolean;
  onToggleAgentPanel?: () => void;
}

export default function Chat({
  token,
  sessionId,
  sessionTitle,
  agentName = "默认助手",
  agentIcon = "mdi:robot-outline",
  agentAvatarSvg = null,
  agentAvatarUrl = null,
  messages,
  isLoading,
  error = "",
  citations = [],
  toolActivities = [],
  selectedModel,
  preferredModel,
  onModelChange,
  onOpenToolMarket,
  onSend,
  agentPanelCollapsed = false,
  onToggleAgentPanel,
}: ChatProps) {
  const [input, setInput] = useState("");
  const [models, setModels] = useState<Array<{ model: string; displayName: string }>>([]);
  const [kbList, setKbList] = useState<KnowledgeBase[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [attachAllOwn, setAttachAllOwn] = useState(false);
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [draftAttachAllOwn, setDraftAttachAllOwn] = useState(false);
  const [draftSelectedKbIds, setDraftSelectedKbIds] = useState<string[]>([]);
  const [installedTools, setInstalledTools] = useState<InstalledTool[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [draftSelectedToolIds, setDraftSelectedToolIds] = useState<string[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [toolError, setToolError] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [toolGroupExpanded, setToolGroupExpanded] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());

  const selectedKbNames = selectedKbIds
    .map((id) => kbList.find((kb) => kb.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const ownKbCount = kbList.filter((kb) => kb.ownerType === "USER").length;
  const knowledgeLabel = attachAllOwn
    ? "我的全库搜索"
    : selectedKbNames.length === 0
      ? "知识库"
      : selectedKbNames.length === 1
        ? selectedKbNames[0]
        : `${selectedKbNames.length} 个知识库`;
  const selectedToolNames = selectedToolIds
    .map((id) => installedTools.find((tool) => tool.toolName === id)?.name)
    .filter((name): name is string => Boolean(name));
  const toolLabel = selectedToolNames.length === 0
    ? "工具"
    : selectedToolNames.length === 1
      ? selectedToolNames[0]
      : `${selectedToolNames.length} 个工具`;
  const selectedModelLabel = models.find((m) => m.model === selectedModel)?.displayName || selectedModel || "选择模型";
  const statusLabel = (status: ToolActivity["status"]) => {
    if (status === "started") return "执行中";
    if (status === "failed") return "失败";
    return "完成";
  };
  const toolDuration = (elapsedMs?: number) => {
    if (elapsedMs === undefined) return "";
    if (elapsedMs < 1000) return `${elapsedMs}ms`;
    return `${(elapsedMs / 1000).toFixed(1)}s`;
  };
  const toolStatusVerb = (status: ToolActivity["status"]) => {
    if (status === "started") return "正在运行";
    if (status === "failed") return "运行失败";
    return "已运行";
  };
  const toolStatusIcon = (status: ToolActivity["status"]) => {
    if (status === "started") return "mdi:loading";
    if (status === "failed") return "mdi:close";
    return "mdi:check";
  };
  const toolStatusClassName = (status: ToolActivity["status"]) => {
    if (status === "started") return "text-brand-ink";
    if (status === "failed") return "text-red-600";
    return "text-gray-500";
  };
  const isCommandTool = (tool: ToolActivity) => tool.name === "terminal_exec" || tool.label === "执行命令";
  const stripToolDetailPrefix = (detail: string) =>
    detail.trim().replace(/^(命令|路径|文件|操作)[：:]\s*/, "");
  const toolCommandText = (tool: ToolActivity) => {
    const detail = stripToolDetailPrefix(tool.detail);
    if (isCommandTool(tool)) return detail || tool.label || tool.name;
    if (!detail) return tool.label || tool.name;
    return `${tool.label || tool.name} ${detail}`;
  };
  const toolGroupUnit = toolActivities.every(isCommandTool) ? "条命令" : "次操作";
  const toolGroupVerb = toolActivities.some((tool) => tool.status === "started") ? "正在运行" : "已运行";
  const toggleExpandedTool = (id: string) => {
    setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const openKbPicker = () => {
    setDraftAttachAllOwn(attachAllOwn);
    setDraftSelectedKbIds(selectedKbIds);
    setKbPickerOpen(true);
  };

  const applyKbSelection = () => {
    setAttachAllOwn(draftAttachAllOwn);
    setSelectedKbIds(draftAttachAllOwn ? [] : draftSelectedKbIds);
    setKbPickerOpen(false);
  };

  const disableKnowledge = () => {
    setDraftAttachAllOwn(false);
    setDraftSelectedKbIds([]);
    setAttachAllOwn(false);
    setSelectedKbIds([]);
    setKbPickerOpen(false);
  };

  const toggleDraftKb = (id: string) => {
    setDraftAttachAllOwn(false);
    setDraftSelectedKbIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const refreshInstalledTools = async () => {
    const data = await listInstalledTools(token);
    const availableTools = data.installed.filter((tool) => tool.availableOnCurrentDevice);
    const availableToolNames = new Set(availableTools.map((tool) => tool.toolName));
    setInstalledTools(availableTools);
    setSelectedToolIds((prev) => prev.filter((toolName) => availableToolNames.has(toolName)));
    setDraftSelectedToolIds((prev) => prev.filter((toolName) => availableToolNames.has(toolName)));
  };

  const loadToolData = async () => {
    setToolLoading(true);
    setToolError("");
    try {
      await refreshInstalledTools();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : "加载工具失败");
    } finally {
      setToolLoading(false);
    }
  };

  const openToolPicker = () => {
    setDraftSelectedToolIds(selectedToolIds);
    setToolPickerOpen(true);
    void loadToolData();
  };

  const applyToolSelection = () => {
    setSelectedToolIds(draftSelectedToolIds);
    setToolPickerOpen(false);
  };

  const disableTools = () => {
    setDraftSelectedToolIds([]);
    setSelectedToolIds([]);
    setToolPickerOpen(false);
  };

  const toggleDraftTool = (toolName: string) => {
    setDraftSelectedToolIds((prev) =>
      prev.includes(toolName) ? prev.filter((item) => item !== toolName) : [...prev, toolName]
    );
  };

  const openMarketFromPicker = () => {
    setToolPickerOpen(false);
    onOpenToolMarket();
  };

  const installedToolCount = installedTools.length;

  const scrollToBottom = () => {
    const scroller = messagesScrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, toolActivities]);

  useEffect(() => {
    if (toolActivities.length === 0) {
      setToolGroupExpanded(false);
      setExpandedToolIds(new Set());
    }
  }, [toolActivities.length]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const modelsData = await listModels();
        setModels(modelsData);
        const kbsData = await listKb(token);
        setKbList(kbsData);
      } catch (err) {
        console.warn("chat init failed", err);
      }
    };
    init();
  }, [token]);

  useEffect(() => {
    if (models.length === 0) return;
    if (!selectedModel || !models.some((m) => m.model === selectedModel)) {
      onModelChange(pickInitialModel(models, preferredModel));
    }
  }, [models, selectedModel, preferredModel, onModelChange]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      setAttachmentError("");
      const next = await filesToChatAttachments(files, attachments.length);
      setAttachments((prev) => [...prev, ...next]);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "附件读取失败");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const item = prev.find((attachment) => attachment.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((attachment) => attachment.id !== id);
    });
  };

  const handleSend = async () => {
    const msg = input.trim();
    if ((!msg && attachments.length === 0) || isLoading) return;

    const outgoingAttachments = attachments;
    setInput("");
    setAttachments([]);
    onSend({
      message: msg,
      model: selectedModel,
      kbIds: attachAllOwn ? undefined : selectedKbIds,
      attachAllOwn: attachAllOwn ? true : undefined,
      toolIds: selectedToolIds,
      attachments: outgoingAttachments.map(stripAttachmentForApi),
    });
    outgoingAttachments.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  };

  const composerCard = (
    <div className="mx-auto w-full max-w-5xl">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      <div className="rounded-2xl border border-gray-200 bg-surface shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-all focus-within:border-brand/40 focus-within:shadow-[0_12px_32px_rgba(15,23,42,0.09)]">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="输入问题..."
          className="block w-full min-h-[78px] max-h-36 resize-none rounded-t-2xl border-0 bg-transparent px-4 pt-4 pb-2 text-sm leading-6 text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-0"
        />

        {attachments.length > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="h-11 max-w-60 rounded-xl border border-gray-200 bg-gray-50 px-2 py-1.5 flex items-center gap-2"
              >
                {attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="w-8 h-8 rounded-lg object-cover bg-surface flex-none"
                  />
                ) : (
                  <span className="w-8 h-8 rounded-lg bg-surface text-gray-500 flex items-center justify-center flex-none">
                    <Icon icon="mdi:file-document-outline" className="text-lg" aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-gray-700 truncate">{attachment.name}</span>
                  <span className="block text-[10px] text-gray-400">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="w-6 h-6 rounded-md text-gray-400 flex items-center justify-center flex-none"
                  aria-label="移除附件"
                >
                  <Icon icon="mdi:close" className="text-sm" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="px-3 pb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex w-full items-center gap-2 sm:w-auto">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-9 h-9 flex-none rounded-full text-gray-500 flex items-center justify-center transition-colors"
              aria-label="添加附件"
              title="添加附件"
            >
              <Icon icon="mdi:plus" className="text-xl" aria-hidden />
            </button>
            <button
              type="button"
              onClick={openKbPicker}
              className={`h-9 min-w-0 flex-1 max-w-48 px-3 rounded-xl border text-xs font-medium flex items-center gap-2 transition-colors sm:flex-none ${
                attachAllOwn || selectedKbIds.length > 0
                  ? "bg-brand-soft border-brand/20 text-brand-ink"
                  : "bg-surface border-gray-200 text-gray-600 "
              }`}
            >
              <Icon icon="mdi:database-search-outline" className="text-base flex-none" aria-hidden />
              <span className="truncate">{knowledgeLabel}</span>
            </button>
            <button
              type="button"
              onClick={openToolPicker}
              className={`h-9 min-w-0 flex-1 max-w-48 px-3 rounded-xl border text-xs font-medium flex items-center gap-2 transition-colors sm:flex-none ${
                selectedToolIds.length > 0
                  ? "bg-brand-soft border-brand/30 text-brand-ink"
                  : "bg-surface border-gray-200 text-gray-600 "
              }`}
            >
              <Icon icon="mdi:wrench-outline" className="text-base flex-none" aria-hidden />
              <span className="truncate">{toolLabel}</span>
            </button>
          </div>

          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <div className="relative">
              {modelPickerOpen && (
                <button
                  type="button"
                  className="fixed inset-0 z-40 cursor-default"
                  aria-label="关闭模型选择"
                  onClick={() => setModelPickerOpen(false)}
                />
              )}
              <button
                type="button"
                onClick={() => setModelPickerOpen(true)}
                className="h-9 max-w-[calc(100vw-10rem)] px-3 rounded-xl border border-gray-200 bg-surface text-xs font-medium text-gray-700 flex items-center gap-2 transition-colors sm:max-w-48"
                aria-label="选择模型"
              >
                <Icon icon="mdi:chip" className="text-base text-gray-500 flex-none" aria-hidden />
                <span className="truncate">{selectedModelLabel}</span>
                <Icon icon="mdi:chevron-down" className="text-base text-gray-400 flex-none" aria-hidden />
              </button>
              {modelPickerOpen && (
                <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl bg-surface border border-gray-100 shadow-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100">
                    <h4 className="text-sm font-bold text-gray-900">选择模型</h4>
                    <p className="text-xs text-gray-400 mt-0.5">切换后下一条消息生效</p>
                  </div>
                  <div className="p-2 max-h-72 overflow-y-auto">
                    {models.map((m) => {
                      const checked = m.model === selectedModel;
                      return (
                        <button
                          key={m.model}
                          type="button"
                          onClick={() => {
                            onModelChange(m.model);
                            setModelPickerOpen(false);
                          }}
                          className={`w-full px-3 py-2.5 rounded-lg text-left flex items-center gap-3 transition-colors ${
                            checked
                              ? "bg-brand-soft text-brand-ink"
                              : "text-gray-700 "
                          }`}
                        >
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-none ${
                            checked ? "bg-brand text-white" : "border border-gray-200 text-transparent"
                          }`}>
                            <Icon icon="mdi:check" className="text-sm" aria-hidden />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium truncate">{m.displayName}</span>
                          </span>
                        </button>
                      );
                    })}
                    {models.length === 0 && (
                      <div className="px-3 py-6 text-center text-xs text-gray-400">暂无可用模型</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <RippleButton
              onClick={handleSend}
              disabled={isLoading || (!input.trim() && attachments.length === 0)}
              className="w-10 h-10 flex-none rounded-full bg-brand text-white disabled:bg-gray-200 disabled:text-gray-400 flex items-center justify-center transition-colors"
              aria-label="发送"
            >
              <Icon icon="mdi:arrow-up" className="text-xl" aria-hidden />
            </RippleButton>
          </div>
        </div>
      </div>
    </div>
  );

  const renderToolActivities = () => toolActivities.length > 0 ? (
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
          onClick={() => setToolGroupExpanded((prev) => !prev)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium text-gray-500 transition-colors "
        >
          <Icon icon="mdi:console-line" className="text-sm flex-none text-gray-400" aria-hidden />
          <span className="truncate">{toolGroupVerb} {toolActivities.length} {toolGroupUnit}</span>
          <Icon
            icon={toolGroupExpanded ? "mdi:chevron-down" : "mdi:chevron-right"}
            className="text-sm flex-none text-gray-400"
            aria-hidden
          />
        </button>

        {toolGroupExpanded && (
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
                    onClick={() => canExpand && toggleExpandedTool(tool.id)}
                    className={`flex w-full min-w-0 items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left text-xs leading-5 text-gray-500 transition-colors ${
                      canExpand ? " " : "cursor-default"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {toolStatusVerb(tool.status)} {toolCommandText(tool)}
                    </span>
                    <span className="flex items-center gap-1 flex-none text-[11px] text-gray-400">
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
                    <div className="mt-1 rounded-lg bg-gray-100 px-3 py-2.5 text-xs shadow-inner">
                      <div className="mb-2 text-[11px] font-medium text-gray-500">
                        {isCommandTool(tool) ? "Shell" : tool.label || tool.name}
                      </div>
                      <div className="font-mono text-[11px] leading-5 text-gray-800">
                        {isCommandTool(tool) && (
                          <div className="whitespace-pre-wrap break-words">$ {toolCommandText(tool)}</div>
                        )}
                        {tool.outputPreview && (
                          <div className="mt-1 whitespace-pre-wrap break-words text-gray-500">{tool.outputPreview}</div>
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
  ) : null;

  const shouldRenderToolsBeforeMessage = (message: ChatMessage, index: number) =>
    toolActivities.length > 0 && index === messages.length - 1 && message.role === "assistant";

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="h-16 px-6 border-b border-gray-100 flex items-center justify-between flex-none">
        <div className="flex items-center min-w-0 gap-3">
          {onToggleAgentPanel && (
            <button
              type="button"
              onClick={onToggleAgentPanel}
              aria-label={agentPanelCollapsed ? "展开对话列表" : "收起对话列表"}
              className="flex-none w-9 h-9 rounded-lg text-gray-400 flex items-center justify-center transition-colors"
            >
              <Icon icon="mdi:dock-left" className="text-xl" aria-hidden />
            </button>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-800">
              {sessionId ? (sessionTitle?.trim() || "对话") : "新对话"}
            </h3>
            <div className="flex items-center space-x-2 mt-1">
              <span className="px-2 py-0.5 bg-gray-50 text-gray-600 text-[10px] font-medium rounded">
                {agentName}
              </span>
              {selectedModel && (
                <span className="px-2 py-0.5 bg-brand-soft text-brand-ink text-[10px] font-medium rounded">
                  {models.find((m) => m.model === selectedModel)?.displayName || selectedModel}
                </span>
              )}
              {(selectedKbIds.length > 0 || attachAllOwn) && (
                <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-[10px] font-medium rounded">
                  已挂载 {attachAllOwn ? "全部库" : `${selectedKbIds.length} 库`}
                </span>
              )}
              {selectedToolIds.length > 0 && (
                <span className="px-2 py-0.5 bg-brand-soft text-brand-ink text-[10px] font-medium rounded">
                  已挂载 {selectedToolIds.length} 工具
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesScrollRef} className="flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center px-6">
            <h2 className="text-2xl font-semibold text-gray-800 mb-8 text-center">需要 {agentName} 为您做什么？</h2>
            <div className="w-full max-w-2xl">
              {(error || attachmentError) && (
                <div className="mb-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg">
                  {error || attachmentError}
                </div>
              )}
              {composerCard}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 不用 mode="popLayout"：本列表直接子节点多为普通 div（非 motion 组件），
                popLayout 会把布局动画中的元素设为 position:absolute 脱离文档流，导致工具调用块与正文重叠。 */}
            <AnimatePresence>
              {messages.map((msg, idx) => (
                <Fragment key={idx}>
                  {shouldRenderToolsBeforeMessage(msg, idx) && renderToolActivities()}
                  <div
                    className={`flex items-start space-x-3 ${
                      msg.role === "user" ? "justify-end" : ""
                    }`}
                  >
                  {msg.role === "assistant" && (
                    <AgentAvatar avatarUrl={agentAvatarUrl} avatarSvg={agentAvatarSvg} icon={agentIcon} size={40} name={agentName} />
                  )}

                  <div className="max-w-[70%]">
                    <div
                      className={`rounded-2xl p-4 ${
                        msg.role === "user"
                          ? "bg-brand text-white rounded-tr-none"
                          : "bg-gray-50 text-gray-800 border border-gray-100 rounded-tl-none"
                      }`}
                    >
                      {msg.role === "assistant" ? (
                        <>
                          <MarkdownMessage content={msg.content} />
                          {isLoading && idx === messages.length - 1 && <StreamingCaret />}
                        </>
                      ) : (
                        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                      )}
                    </div>

                    {msg.role === "assistant" && citations.length > 0 && idx === messages.length - 1 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {citations.map((citation, cidx) =>
                          citation.docs.map((doc, didx) => (
                            <div
                              key={`${cidx}-${didx}`}
                              className="px-2 py-1 bg-surface border border-gray-200 rounded-full text-[10px] text-gray-600 flex items-center space-x-1"
                            >
                              <Icon icon="mdi:file-document" className="text-sm" />
                              <span>引用 {doc.docName}#{doc.ordinal}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {msg.role === "assistant" && (
                      <AssistantMessageActions content={msg.content} />
                    )}
                  </div>

                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded-lg bg-gray-200 flex items-center justify-center flex-none">
                      <Icon icon="mdi:account-outline" className="text-lg text-gray-600" aria-hidden />
                    </div>
                  )}
                  </div>
                </Fragment>
              ))}

              {toolActivities.length > 0 && messages[messages.length - 1]?.role !== "assistant" && renderToolActivities()}

              {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
                <TypingIndicator agentIcon={agentIcon} agentAvatarSvg={agentAvatarSvg} agentAvatarUrl={agentAvatarUrl} agentName={agentName} />
              )}
            </AnimatePresence>

            <div />
          </div>
        )}
      </div>

      {/* Input */}
      {messages.length > 0 && (
        <div className="border-t border-gray-100 bg-surface px-6 py-5 flex-none">
          {(error || attachmentError) && (
            <div className="mx-auto mb-3 max-w-5xl p-3 bg-red-50 text-red-700 text-sm rounded-lg">
              {error || attachmentError}
            </div>
          )}
          {composerCard}
        </div>
      )}

      {toolPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/20 p-4"
          onClick={() => setToolPickerOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-surface border border-gray-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
              <div>
                <h4 className="text-base font-bold text-gray-900">挂载工具</h4>
                <p className="text-xs text-gray-500 mt-1">
                  {draftSelectedToolIds.length} 个已选择，{installedToolCount} 个可挂载
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openMarketFromPicker}
                  className="h-8 rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-700 "
                >
                  工具市场
                </button>
                <button
                  type="button"
                  onClick={() => setToolPickerOpen(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500"
                  aria-label="关闭"
                >
                  <Icon icon="mdi:close" className="text-lg" />
                </button>
              </div>
            </div>

            <div className="p-5">
              {toolError && (
                <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{toolError}</div>
              )}
              {toolLoading ? (
                <div className="flex min-h-56 items-center justify-center text-sm text-gray-400">
                  <Icon icon="mdi:loading" className="mr-2 text-lg animate-spin" aria-hidden />
                  正在加载已安装工具
                </div>
              ) : installedTools.length > 0 ? (
                <div className="max-h-[28rem] overflow-y-auto space-y-2 pr-1">
                  {installedTools.map((tool) => {
                    const checked = draftSelectedToolIds.includes(tool.toolName);
                    return (
                      <button
                        key={tool.toolName}
                        type="button"
                        onClick={() => toggleDraftTool(tool.toolName)}
                        className={`w-full rounded-lg border px-3 py-3 text-left transition-colors flex items-start gap-3 ${
                          checked
                            ? "border-brand/30 bg-brand-soft text-brand-ink"
                            : "border-gray-100 text-gray-700 "
                        }`}
                      >
                        <span
                          className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-none ${
                            checked ? "bg-brand border-brand text-white" : "border-gray-300"
                          }`}
                        >
                          {checked && <Icon icon="mdi:check" className="text-xs" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{tool.name}</span>
                          <span className="mt-1 block line-clamp-2 text-xs leading-5 text-gray-400">{tool.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 px-6 text-center">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 text-gray-500">
                    <Icon icon="mdi:toolbox-outline" className="text-xl" aria-hidden />
                  </div>
                  <p className="text-sm font-semibold text-gray-900">暂无已安装工具</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">先到工具市场安装 skill，再回到对话中挂载使用。</p>
                  <button
                    type="button"
                    onClick={openMarketFromPicker}
                    className="mt-4 h-9 rounded-lg bg-gray-900 px-4 text-xs font-medium text-white "
                  >
                    打开工具市场
                  </button>
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={disableTools}
                className="px-3 py-2 rounded-lg text-sm text-red-600 "
              >
                关闭工具
              </button>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setToolPickerOpen(false)}
                  className="px-4 py-2 rounded-lg text-sm text-gray-600 "
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={applyToolSelection}
                  className="px-4 py-2 rounded-lg text-sm bg-brand text-white"
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {kbPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/20 p-4"
          onClick={() => setKbPickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-surface border border-gray-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h4 className="text-base font-bold text-gray-900">选择知识库</h4>
                <p className="text-xs text-gray-500 mt-1">全库只检索我的库；指定知识库可包含官方库</p>
              </div>
              <button
                type="button"
                onClick={() => setKbPickerOpen(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500"
                aria-label="关闭"
              >
                <Icon icon="mdi:close" className="text-lg" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <button
                type="button"
                onClick={() => {
                  setDraftAttachAllOwn(true);
                  setDraftSelectedKbIds([]);
                }}
                className={`w-full p-4 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                  draftAttachAllOwn
                    ? "border-brand/30 bg-brand-soft text-brand-ink"
                    : "border-gray-100 text-gray-700"
                }`}
              >
                <span className="mt-0.5 w-7 h-7 rounded-lg bg-brand/10 text-brand flex items-center justify-center flex-none">
                  <Icon icon="mdi:creation-outline" className="text-base" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold">全库智能搜索</span>
                    <span className="px-2 py-0.5 rounded-full bg-surface/70 text-[10px] text-brand-ink border border-brand/10">
                      仅我的库
                    </span>
                  </span>
                  <span className="block text-xs opacity-70 mt-1">
                    对话时自动检索你自己创建的 {ownKbCount} 个知识库
                  </span>
                </span>
              </button>

              <div>
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-px bg-gray-100 flex-1" />
                  <p className="text-xs font-medium text-gray-400">或指定知识库</p>
                  <div className="h-px bg-gray-100 flex-1" />
                </div>
                {kbList.length > 0 ? (
                  <div className="max-h-56 overflow-y-auto space-y-2">
                    {kbList.map((kb) => {
                      const checked = !draftAttachAllOwn && draftSelectedKbIds.includes(kb.id);
                      const isOfficial = kb.ownerType === "OFFICIAL";
                      return (
                        <button
                          key={kb.id}
                          type="button"
                          onClick={() => toggleDraftKb(kb.id)}
                          className={`w-full px-3 py-2.5 rounded-lg border text-left flex items-center gap-3 transition-colors ${
                            checked
                              ? "bg-surface-muted text-gray-900 border-gray-200"
                              : "text-gray-700 border-gray-100"
                          }`}
                        >
                          <span
                            className={`w-4 h-4 rounded border flex items-center justify-center flex-none ${
                              checked ? "bg-brand border-brand text-white" : "border-gray-300"
                            }`}
                          >
                            {checked && <Icon icon="mdi:check" className="text-xs" aria-hidden />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{kb.name}</span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] flex-none ${
                                  isOfficial
                                    ? "bg-blue-50 text-blue-700"
                                    : "bg-brand-soft text-brand-ink"
                                }`}
                              >
                                {isOfficial ? "官方" : "我的"}
                              </span>
                            </span>
                            {kb.description && (
                              <span className="block text-xs text-gray-400 truncate mt-0.5">{kb.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-6 text-center text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg">
                    暂无可选知识库
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={disableKnowledge}
                className="px-3 py-2 rounded-lg text-sm text-red-600 "
              >
                关闭知识库
              </button>
              <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setKbPickerOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-600 "
              >
                取消
              </button>
              <button
                type="button"
                onClick={applyKbSelection}
                className="px-4 py-2 rounded-lg text-sm bg-brand text-white"
              >
                确定
              </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
