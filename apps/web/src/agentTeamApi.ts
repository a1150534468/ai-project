import type { ChatAttachmentPayload } from "./api";
import { request } from "./http";

export interface AgentTeamMemberDto {
  readonly id?: string;
  readonly name: string;
  readonly role: string;
  readonly responsibility: string;
  readonly systemPrompt: string;
  readonly skills: readonly string[];
  readonly isCore: boolean;
  readonly position?: number;
}

export interface AgentTeamDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mainAgentPrompt: string;
  readonly members: readonly AgentTeamMemberDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecommendedAgentTeam {
  readonly teamName: string;
  readonly teamDescription: string;
  readonly mainAgentPrompt: string;
  readonly members: readonly AgentTeamMemberDto[];
}

export interface AgentWorkflowStepDto {
  readonly id: string;
  readonly memberName: string;
  readonly memberSnapshot: unknown;
  readonly title: string;
  readonly goal: string;
  readonly input: unknown;
  readonly output: string;
  readonly status: string;
  readonly position: number;
  readonly retryCount: number;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AgentWorkflowEventDto {
  readonly id: string;
  readonly stepId: string | null;
  readonly memberName: string;
  readonly type: string;
  readonly message: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface AgentWorkflowRunDto {
  readonly id: string;
  readonly teamId: string | null;
  readonly taskGoal: string;
  readonly status: string;
  readonly teamSnapshot: unknown;
  readonly planSnapshot: unknown;
  readonly finalReport: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly steps: readonly AgentWorkflowStepDto[];
  readonly events: readonly AgentWorkflowEventDto[];
}

export interface AgentTeamTaskOptions {
  readonly model?: string;
  readonly kbIds?: readonly string[];
  readonly attachAllOwn?: boolean;
  readonly attachments?: readonly ChatAttachmentPayload[];
}

/** 任务请求体在推荐团队与直接建任务两处形状一致，抽出来避免两边改漏。 */
function taskBody(taskGoal: string, options: AgentTeamTaskOptions): Record<string, unknown> {
  return {
    taskGoal,
    model: options.model || undefined,
    kbIds: options.attachAllOwn ? undefined : options.kbIds ?? [],
    attachAllOwn: options.attachAllOwn ? true : undefined,
    attachments: options.attachments ?? [],
  };
}

export async function listAgentTeams(token: string): Promise<readonly AgentTeamDto[]> {
  const data = await request<{ teams: AgentTeamDto[] }>("/api/agent-teams", {
    token,
    fallback: "获取 Agent 团队失败",
  });
  return data.teams;
}

export async function deleteAgentTeam(token: string, teamId: string): Promise<void> {
  await request<{ deletedTeamId: string }>(`/api/agent-teams/${encodeURIComponent(teamId)}`, {
    method: "DELETE",
    token,
    fallback: "删除 Agent 团队失败",
  });
}

export async function recommendAgentTeam(
  token: string,
  taskGoal: string,
  options: AgentTeamTaskOptions = {},
): Promise<{ recommendation: RecommendedAgentTeam; run: AgentWorkflowRunDto }> {
  return request("/api/agent-teams/recommend", {
    method: "POST",
    token,
    body: taskBody(taskGoal, options),
    fallback: "生成 Agent 团队失败",
  });
}

export async function confirmAgentTeam(
  token: string,
  runId: string,
  recommendation: RecommendedAgentTeam,
): Promise<{ team: AgentTeamDto; run: AgentWorkflowRunDto }> {
  return request(`/api/agent-teams/runs/${encodeURIComponent(runId)}/confirm-team`, {
    method: "POST",
    token,
    body: recommendation,
    fallback: "确认 Agent 团队失败",
  });
}

export async function createRunFromAgentTeam(
  token: string,
  teamId: string,
  taskGoal: string,
  options: AgentTeamTaskOptions = {},
): Promise<AgentWorkflowRunDto> {
  const data = await request<{ run: AgentWorkflowRunDto }>(`/api/agent-teams/${encodeURIComponent(teamId)}/runs`, {
    method: "POST",
    token,
    body: taskBody(taskGoal, options),
    fallback: "创建 Agent 团队任务失败",
  });
  return data.run;
}

export async function getAgentWorkflowRun(token: string, runId: string): Promise<AgentWorkflowRunDto> {
  const data = await request<{ run: AgentWorkflowRunDto }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}`, {
    token,
    fallback: "获取 Agent 团队任务失败",
  });
  return data.run;
}

export async function listAgentWorkflowRuns(token: string): Promise<readonly AgentWorkflowRunDto[]> {
  const data = await request<{ runs: AgentWorkflowRunDto[] }>("/api/agent-teams/runs", {
    token,
    fallback: "获取 Agent 团队历史记录失败",
  });
  return data.runs;
}

export async function cancelAgentWorkflowRun(token: string, runId: string): Promise<AgentWorkflowRunDto> {
  const data = await request<{ run: AgentWorkflowRunDto }>(`/api/agent-teams/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    token,
    fallback: "取消 Agent 团队任务失败",
  });
  return data.run;
}
