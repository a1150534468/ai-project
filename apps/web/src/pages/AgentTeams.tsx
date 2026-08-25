import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { listKb, listModels, type KnowledgeBase } from "../api";
import {
  cancelAgentWorkflowRun,
  confirmAgentTeam,
  createRunFromAgentTeam,
  deleteAgentTeam,
  getAgentWorkflowRun,
  listAgentWorkflowRuns,
  listAgentTeams,
  recommendAgentTeam,
  type AgentTeamDto,
  type AgentWorkflowRunDto,
  type RecommendedAgentTeam,
} from "../agentTeamApi";
import { AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY, recommendationFromRunSnapshot } from "../agentTeamRunState";
import { filesToChatAttachments, stripAttachmentForApi, type ChatAttachment } from "../chatAttachments";
import { pickInitialModel, type ModelOption } from "../chatState";
import { RunningBanner } from "../components/agent-teams/RunningBanner";
import { RunStatusCard } from "../components/agent-teams/RunStatusCard";
import { TaskComposer } from "../components/agent-teams/TaskComposer";
import { TeamCardGrid } from "../components/agent-teams/TeamCardGrid";
import { TeamRecommendationPanel } from "../components/agent-teams/TeamRecommendationPanel";
import { WorkflowRunHistoryPanel } from "../components/agent-teams/WorkflowRunHistoryPanel";
import { WorkflowRunPanel } from "../components/agent-teams/WorkflowRunPanel";

const POLL_MS = 3000;
const ACTIVE_STATUSES = new Set(["team_confirmed", "planning", "running"]);

interface AgentTeamsProps {
  readonly token: string;
  readonly selectedModel: string;
  readonly preferredModel?: string;
  readonly onBalanceRefresh?: () => void;
  readonly onModelChange: (model: string) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function AgentTeams({ token, selectedModel, preferredModel, onBalanceRefresh, onModelChange }: AgentTeamsProps) {
  const [taskGoal, setTaskGoal] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<readonly KnowledgeBase[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [attachAllOwn, setAttachAllOwn] = useState(false);
  const [teams, setTeams] = useState<readonly AgentTeamDto[]>([]);
  const [runHistory, setRunHistory] = useState<readonly AgentWorkflowRunDto[]>([]);
  const [recommendation, setRecommendation] = useState<RecommendedAgentTeam | null>(null);
  const [activeRun, setActiveRun] = useState<AgentWorkflowRunDto | null>(null);
  const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([]);
  const attachmentsRef = useRef<readonly ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [pendingDeleteTeamId, setPendingDeleteTeamId] = useState<string | null>(null);
  const [deletingTeamId, setDeletingTeamId] = useState<string | null>(null);
  const isActiveRun = useMemo(() => Boolean(activeRun && ACTIVE_STATUSES.has(activeRun.status)), [activeRun]);

  const refreshTeams = useCallback(async () => {
    setTeams(await listAgentTeams(token));
  }, [token]);

  const refreshRunHistory = useCallback(async () => {
    setRunHistory(await listAgentWorkflowRuns(token));
  }, [token]);

  const refreshRun = useCallback(async (runId: string) => {
    const run = await getAgentWorkflowRun(token, runId);
    setActiveRun(run);
    if (!ACTIVE_STATUSES.has(run.status)) {
      void refreshRunHistory().catch(() => undefined);
    }
  }, [refreshRunHistory, token]);

  useEffect(() => {
    void refreshTeams().catch(() => setTeams([]));
  }, [refreshTeams]);

  useEffect(() => {
    void refreshRunHistory().catch(() => setRunHistory([]));
  }, [refreshRunHistory]);

  useEffect(() => {
    void listModels().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    void listKb(token).then(setKnowledgeBases).catch(() => setKnowledgeBases([]));
  }, [token]);

  useEffect(() => {
    const savedRunId = window.localStorage.getItem(AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY);
    if (!savedRunId) return undefined;
    let cancelled = false;
    void getAgentWorkflowRun(token, savedRunId)
      .then((run) => {
        if (cancelled) return;
        setActiveRun(run);
        setTaskGoal(run.taskGoal);
        setRecommendation(recommendationFromRunSnapshot(run));
        if (run.teamId) setSelectedTeamId(run.teamId);
      })
      .catch(() => {
        if (!cancelled) window.localStorage.removeItem(AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!activeRun) return;
    window.localStorage.setItem(AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY, activeRun.id);
    if (activeRun.status !== "awaiting_team_confirmation") {
      setRecommendation(null);
    }
  }, [activeRun]);

  useEffect(() => {
    if (models.length === 0) return;
    if (!selectedModel || !models.some((model) => model.model === selectedModel)) {
      onModelChange(pickInitialModel([...models], preferredModel));
    }
  }, [models, onModelChange, preferredModel, selectedModel]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
  }, []);

  useEffect(() => {
    if (!activeRun || !isActiveRun) return undefined;
    const timer = window.setInterval(() => {
      void refreshRun(activeRun.id).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeRun, isActiveRun, refreshRun]);

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
      return [];
    });
  }, []);

  const handleAddFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError("");
    void filesToChatAttachments(files, attachments.length)
      .then((next) => setAttachments((current) => [...current, ...next]))
      .catch((err) => setAttachmentError(errorMessage(err, "附件读取失败")));
  }, [attachments.length]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handleSubmit = () => {
    const goal = taskGoal.trim();
    if (!goal) {
      setError("请输入任务目标");
      return;
    }
    setError("");
    setNotice("");
    setIsSubmitting(true);
    const taskOptions = {
      model: selectedModel || undefined,
      kbIds: selectedKbIds,
      attachAllOwn,
      attachments: attachments.map(stripAttachmentForApi),
    };
    void (async () => {
      try {
        if (selectedTeamId) {
          const run = await createRunFromAgentTeam(token, selectedTeamId, goal, taskOptions);
          setActiveRun(run);
          setRecommendation(null);
          setNotice("已使用保存团队创建工作流");
          clearAttachments();
        } else {
          const result = await recommendAgentTeam(token, goal, taskOptions);
          setRecommendation(result.recommendation);
          setActiveRun(result.run);
          setNotice("已生成推荐团队，请确认后开始工作流");
        }
        void refreshRunHistory().catch(() => undefined);
        onBalanceRefresh?.();
      } catch (err) {
        setError(errorMessage(err, "创建 Agent 团队任务失败"));
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  const handleConfirmTeam = () => {
    if (!activeRun || !recommendation) return;
    setError("");
    setNotice("");
    setIsConfirming(true);
    void (async () => {
      try {
        const result = await confirmAgentTeam(token, activeRun.id, recommendation);
        setActiveRun(result.run);
        setSelectedTeamId(result.team.id);
        setRecommendation(null);
        setNotice("团队已保存，工作流已开始执行");
        clearAttachments();
        await refreshTeams();
        void refreshRunHistory().catch(() => undefined);
        onBalanceRefresh?.();
      } catch (err) {
        setError(errorMessage(err, "确认 Agent 团队失败"));
      } finally {
        setIsConfirming(false);
      }
    })();
  };

  const handleCancel = () => {
    if (!activeRun) return;
    setIsCancelling(true);
    void (async () => {
      try {
        setActiveRun(await cancelAgentWorkflowRun(token, activeRun.id));
        setNotice("已取消当前工作流");
        void refreshRunHistory().catch(() => undefined);
      } catch (err) {
        setError(errorMessage(err, "取消 Agent 团队任务失败"));
      } finally {
        setIsCancelling(false);
      }
    })();
  };

  const handleSelectHistoryRun = useCallback((run: AgentWorkflowRunDto) => {
    setActiveRun(run);
    setTaskGoal(run.taskGoal);
    setRecommendation(run.status === "awaiting_team_confirmation" ? recommendationFromRunSnapshot(run) : null);
    setSelectedTeamId(run.teamId ?? "");
    setError("");
    setNotice("");
  }, []);

  const handleRequestDeleteTeam = useCallback((teamId: string) => {
    setPendingDeleteTeamId(teamId);
    setError("");
    setNotice("");
  }, []);

  const handleCancelDeleteTeam = useCallback(() => {
    if (deletingTeamId) return;
    setPendingDeleteTeamId(null);
  }, [deletingTeamId]);

  const handleConfirmDeleteTeam = useCallback((teamId: string) => {
    if (deletingTeamId) return;
    setDeletingTeamId(teamId);
    setError("");
    setNotice("");
    void (async () => {
      try {
        await deleteAgentTeam(token, teamId);
        setTeams((current) => current.filter((team) => team.id !== teamId));
        if (selectedTeamId === teamId) setSelectedTeamId("");
        setActiveRun((run) => run && run.teamId === teamId ? { ...run, teamId: null } : run);
        setPendingDeleteTeamId(null);
        setNotice("团队已删除，历史任务已保留");
        void refreshRunHistory().catch(() => undefined);
      } catch (err) {
        setError(errorMessage(err, "删除 Agent 团队失败"));
      } finally {
        setDeletingTeamId(null);
      }
    })();
  }, [deletingTeamId, refreshRunHistory, selectedTeamId, token]);

  return (
    <div className="min-h-full bg-surface-muted px-4 py-6 lg:px-6 lg:py-6">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 lg:flex-row lg:items-start">
        <aside className="lg:sticky lg:top-6 lg:w-[300px] lg:flex-none">
          <WorkflowRunHistoryPanel runs={runHistory} activeRunId={activeRun?.id} onSelectRun={handleSelectHistoryRun} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <TaskComposer
            taskGoal={taskGoal}
            teams={teams}
            selectedTeamId={selectedTeamId}
            models={models}
            selectedModel={selectedModel}
            knowledgeBases={knowledgeBases}
            selectedKbIds={selectedKbIds}
            attachAllOwn={attachAllOwn}
            attachments={attachments}
            attachmentError={attachmentError}
            isSubmitting={isSubmitting}
            onTaskGoalChange={(value) => {
              setTaskGoal(value);
              setError("");
            }}
            onSelectedTeamChange={setSelectedTeamId}
            onModelChange={onModelChange}
            onKnowledgeSelectionChange={(selection) => {
              setAttachAllOwn(selection.attachAllOwn);
              setSelectedKbIds([...selection.kbIds]);
            }}
            onAddFiles={handleAddFiles}
            onRemoveAttachment={handleRemoveAttachment}
            onSubmit={handleSubmit}
          />
          {notice && <div className="rounded-[10px] border border-brand/10 bg-brand-soft px-4 py-3 text-sm text-brand-ink">{notice}</div>}
          {error && <div className="rounded-[10px] border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          <AnimatePresence>
            {(isSubmitting || isActiveRun) && (
              <RunningBanner isSubmitting={isSubmitting} runStatus={activeRun?.status} />
            )}
          </AnimatePresence>
          <TeamRecommendationPanel recommendation={recommendation} isConfirming={isConfirming} onConfirm={handleConfirmTeam} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
            <WorkflowRunPanel run={activeRun} isCancelling={isCancelling} onCancel={handleCancel} />
            <div className="flex flex-col gap-4">
              <RunStatusCard run={activeRun} />
              <TeamCardGrid
                teams={teams}
                selectedTeamId={selectedTeamId}
                pendingDeleteTeamId={pendingDeleteTeamId}
                deletingTeamId={deletingTeamId}
                onSelectTeam={setSelectedTeamId}
                onRequestDelete={handleRequestDeleteTeam}
                onConfirmDelete={handleConfirmDeleteTeam}
                onCancelDelete={handleCancelDeleteTeam}
                variant="column"
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
