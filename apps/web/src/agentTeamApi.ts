import type { ChatAttachmentPayload } from "./api";

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

async function readError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error ?? fallback);
}

async function readData<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await readError(response, fallback);
  const body = await response.json() as { data: T };
  return body.data;
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

export async function listAgentTeams(token: string): Promise<readonly AgentTeamDto[]> {
  const response = await fetch("/api/agent-teams", { headers: authHeaders(token) });
  const data = await readData<{ teams: AgentTeamDto[] }>(response, "获取 Agent 团队失败");
  return data.teams;
}

export async function deleteAgentTeam(token: string, teamId: string): Promise<void> {
  const response = await fetch(`/api/agent-teams/${encodeURIComponent(teamId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  await readData<{ deletedTeamId: string }>(response, "删除 Agent 团队失败");
}

export async function recommendAgentTeam(
  token: string,
  taskGoal: string,
  options: AgentTeamTaskOptions = {},
): Promise<{ recommendation: RecommendedAgentTeam; run: AgentWorkflowRunDto }> {
  const response = await fetch("/api/agent-teams/recommend", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({
      taskGoal,
      model: options.model || undefined,
      kbIds: options.attachAllOwn ? undefined : options.kbIds ?? [],
      attachAllOwn: options.attachAllOwn ? true : undefined,
      attachments: options.attachments ?? [],
    }),
  });
  return readData(response, "生成 Agent 团队失败");
}

export async function confirmAgentTeam(
  token: string,
  runId: string,
  recommendation: RecommendedAgentTeam,
): Promise<{ team: AgentTeamDto; run: AgentWorkflowRunDto }> {
  const response = await fetch(`/api/agent-teams/runs/${encodeURIComponent(runId)}/confirm-team`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(recommendation),
  });
  return readData(response, "确认 Agent 团队失败");
}

export async function createRunFromAgentTeam(
  token: string,
  teamId: string,
  taskGoal: string,
  options: AgentTeamTaskOptions = {},
): Promise<AgentWorkflowRunDto> {
  const response = await fetch(`/api/agent-teams/${encodeURIComponent(teamId)}/runs`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({
      taskGoal,
      model: options.model || undefined,
      kbIds: options.attachAllOwn ? undefined : options.kbIds ?? [],
      attachAllOwn: options.attachAllOwn ? true : undefined,
      attachments: options.attachments ?? [],
    }),
  });
  const data = await readData<{ run: AgentWorkflowRunDto }>(response, "创建 Agent 团队任务失败");
  return data.run;
}

export async function getAgentWorkflowRun(token: string, runId: string): Promise<AgentWorkflowRunDto> {
  const response = await fetch(`/api/agent-teams/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders(token),
  });
  const data = await readData<{ run: AgentWorkflowRunDto }>(response, "获取 Agent 团队任务失败");
  return data.run;
}

export async function listAgentWorkflowRuns(token: string): Promise<readonly AgentWorkflowRunDto[]> {
  const response = await fetch("/api/agent-teams/runs", {
    headers: authHeaders(token),
  });
  const data = await readData<{ runs: AgentWorkflowRunDto[] }>(response, "获取 Agent 团队历史记录失败");
  return data.runs;
}

export async function cancelAgentWorkflowRun(token: string, runId: string): Promise<AgentWorkflowRunDto> {
  const response = await fetch(`/api/agent-teams/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: authHeaders(token),
  });
  const data = await readData<{ run: AgentWorkflowRunDto }>(response, "取消 Agent 团队任务失败");
  return data.run;
}
