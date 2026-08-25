import { useRef } from "react";
import { Icon } from "@iconify/react";
import type { KnowledgeBase } from "../../api";
import type { AgentTeamDto } from "../../agentTeamApi";
import type { ModelOption } from "../../chatState";
import { CHAT_ATTACHMENT_ACCEPT, type ChatAttachment } from "../../chatAttachments";
import { RippleButton } from "../../motion";
import { InAppSelect, type SelectOption } from "./InAppSelect";
import { KnowledgePicker, type KnowledgeSelection } from "./KnowledgePicker";

interface TaskComposerProps {
  readonly taskGoal: string;
  readonly teams: readonly AgentTeamDto[];
  readonly selectedTeamId: string;
  readonly models: readonly ModelOption[];
  readonly selectedModel: string;
  readonly knowledgeBases: readonly KnowledgeBase[];
  readonly selectedKbIds: readonly string[];
  readonly attachAllOwn: boolean;
  readonly attachments: readonly ChatAttachment[];
  readonly attachmentError: string;
  readonly isSubmitting: boolean;
  readonly onTaskGoalChange: (value: string) => void;
  readonly onSelectedTeamChange: (value: string) => void;
  readonly onModelChange: (value: string) => void;
  readonly onKnowledgeSelectionChange: (selection: KnowledgeSelection) => void;
  readonly onAddFiles: (files: File[]) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onSubmit: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskComposer({
  taskGoal,
  teams,
  selectedTeamId,
  models,
  selectedModel,
  knowledgeBases,
  selectedKbIds,
  attachAllOwn,
  attachments,
  attachmentError,
  isSubmitting,
  onTaskGoalChange,
  onSelectedTeamChange,
  onModelChange,
  onKnowledgeSelectionChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
}: TaskComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const usingSavedTeam = selectedTeamId.length > 0;
  const teamOptions: SelectOption[] = [
    { value: "", label: "智能推荐新团队", description: "主 Agent 会先创建团队，确认后再生成工作流" },
    ...teams.map((team) => ({
      value: team.id,
      label: team.name,
      description: team.description || `${team.members.length} 个 Agent`,
    })),
  ];
  const modelOptions: SelectOption[] = models.map((model) => ({
    value: model.model,
    label: model.displayName,
    description: model.model,
  }));
  const effectiveModelOptions = modelOptions.length > 0
    ? modelOptions
    : selectedModel
      ? [{ value: selectedModel, label: selectedModel }]
      : [];

  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-surface p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)] sm:p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-ink">Agent 团队</p>
          <h1 className="mt-1 text-[28px] font-bold leading-tight text-ink">智能任务发起</h1>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-brand-soft text-brand-ink">
          <Icon icon="mdi:account-group-outline" className="text-2xl" aria-hidden />
        </span>
      </div>

      <div className="rounded-[10px] border border-hairline bg-surface p-3 focus-within:border-brand/50">
        <textarea
          value={taskGoal}
          onChange={(event) => onTaskGoalChange(event.target.value)}
          placeholder="用大白话描述任务目标，例如：帮我审查一份采购合同，识别潜在法律风险，并给出修改建议..."
          className="min-h-[132px] w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-ink outline-none placeholder:text-ink-tertiary"
        />

        {attachments.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 px-1">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-[10px] bg-surface-subtle px-2.5 py-2">
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" className="h-8 w-8 flex-none rounded-[8px] object-cover" />
                ) : (
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-surface text-ink-secondary">
                    <Icon icon="mdi:file-document-outline" className="text-lg" aria-hidden />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-ink-secondary">{attachment.name}</span>
                  <span className="block text-[10px] text-ink-tertiary">{formatSize(attachment.sizeBytes)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] text-ink-tertiary transition "
                  aria-label="移除附件"
                >
                  <Icon icon="mdi:close" className="text-sm" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <p className="mb-3 px-1 text-xs text-danger-ink">{attachmentError}</p>}

        <div className="flex flex-col gap-3 border-t border-hairline-subtle pt-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="grid min-w-0 flex-1 gap-2 lg:grid-cols-3">
            <InAppSelect
              icon="mdi:robot-outline"
              label="选择团队"
              value={selectedTeamId}
              options={teamOptions}
              onChange={onSelectedTeamChange}
            />
            <InAppSelect
              icon="mdi:chip"
              label="选择模型"
              value={selectedModel}
              options={effectiveModelOptions}
              disabled={effectiveModelOptions.length === 0}
              onChange={onModelChange}
            />
            <KnowledgePicker
              knowledgeBases={knowledgeBases}
              selectedKbIds={selectedKbIds}
              attachAllOwn={attachAllOwn}
              onChange={onKnowledgeSelectionChange}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={CHAT_ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                onAddFiles(files);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] border border-hairline bg-surface px-4 text-sm font-semibold text-ink-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20"
            >
              <Icon icon="mdi:paperclip" className="text-lg" aria-hidden />
              上传文件
            </button>
            <RippleButton
              type="button"
              disabled={isSubmitting}
              onClick={onSubmit}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-brand px-5 text-sm font-semibold text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Icon icon={isSubmitting ? "mdi:loading" : "mdi:play"} className={isSubmitting ? "animate-spin text-xl" : "text-lg"} aria-hidden />
              {isSubmitting ? "正在启动…" : usingSavedTeam ? "使用该团队执行" : "开始执行"}
            </RippleButton>
          </div>
        </div>
      </div>
    </section>
  );
}
