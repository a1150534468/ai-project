/**
 * 对话页输入侧的全部状态:输入框、附件、知识库挂载、模型下拉,以及这一轮的提交动作。
 * 从 `pages/Chat.tsx` 原样搬出的 11 个 `useState` 与它们的动作 —— 页面本体只留「头部 + 消息列表」。
 *
 * 三条不能动的规则:
 *  - **选择器都是「草稿 → 确定才落地」**:`draft*` 与生效值分开存,「取消」只关弹层。
 *  - **知识库全库与指定库互斥**:提交时 `attachAllOwn` 为真就不带 `kbIds`,反之只带 `kbIds`。
 *  - **附件的 previewUrl 必须回收**:移除、发出、组件卸载三条路径都要 `revokeObjectURL`;
 *    卸载那条走 `attachmentsRef`(effect 的清理函数拿不到最新的 state)。
 */
import { useEffect, useRef, useState } from "react";
import {
  listKb,
  listModels,
  type ChatAttachmentPayload,
  type KnowledgeBase,
} from "../../api";
import {
  filesToChatAttachments,
  stripAttachmentForApi,
  type ChatAttachment,
} from "../../chatAttachments";
import { pickInitialModel } from "../../chatState";

export interface ChatSendPayload {
  message: string;
  model?: string;
  kbIds?: string[];
  attachAllOwn?: boolean;
  attachments?: ChatAttachmentPayload[];
}

export function useChatComposerState(args: {
  readonly token: string;
  readonly isLoading: boolean;
  readonly selectedModel: string;
  readonly preferredModel?: string;
  readonly onModelChange: (model: string) => void;
  readonly onSend: (payload: ChatSendPayload) => void;
}) {
  const { token, isLoading, selectedModel, preferredModel, onModelChange, onSend } = args;
  const [input, setInput] = useState("");
  const [models, setModels] = useState<Array<{ model: string; displayName: string }>>([]);
  const [kbList, setKbList] = useState<KnowledgeBase[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [attachAllOwn, setAttachAllOwn] = useState(false);
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [draftAttachAllOwn, setDraftAttachAllOwn] = useState(false);
  const [draftSelectedKbIds, setDraftSelectedKbIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const attachmentsRef = useRef<ChatAttachment[]>([]);

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
  const selectedModelLabel = models.find((m) => m.model === selectedModel)?.displayName || selectedModel || "选择模型";

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

  /** 「全库智能搜索」是排他项:选它就把逐库勾选清空。 */
  const selectDraftAllOwn = () => {
    setDraftAttachAllOwn(true);
    setDraftSelectedKbIds([]);
  };

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
      attachments: outgoingAttachments.map(stripAttachmentForApi),
    });
    outgoingAttachments.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  };

  return {
    input,
    setInput,
    models,
    kbList,
    ownKbCount,
    knowledgeLabel,
    knowledgeActive: attachAllOwn || selectedKbIds.length > 0,
    selectedKbIds,
    attachAllOwn,
    kbPickerOpen,
    openKbPicker,
    closeKbPicker: () => setKbPickerOpen(false),
    applyKbSelection,
    disableKnowledge,
    toggleDraftKb,
    selectDraftAllOwn,
    draftAttachAllOwn,
    draftSelectedKbIds,
    selectedModelLabel,
    modelPickerOpen,
    setModelPickerOpen,
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    handleSend,
  };
}
