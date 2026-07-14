import type { AgentTeamMemberDto, AgentWorkflowRunDto, RecommendedAgentTeam } from "./agentTeamApi";

export const AGENT_TEAM_ACTIVE_RUN_STORAGE_KEY = "ai_assistant_agent_team_active_run_id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function memberFromSnapshot(value: unknown): AgentTeamMemberDto | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name).trim();
  const role = stringValue(value.role).trim();
  const responsibility = stringValue(value.responsibility).trim();
  if (!name || !role || !responsibility) return null;
  return {
    name,
    role,
    responsibility,
    systemPrompt: stringValue(value.systemPrompt),
    skills: stringArray(value.skills),
    isCore: boolValue(value.isCore),
  };
}

export function recommendationFromRunSnapshot(run: AgentWorkflowRunDto): RecommendedAgentTeam | null {
  if (run.status !== "awaiting_team_confirmation") return null;
  if (!isRecord(run.teamSnapshot)) return null;
  const teamName = stringValue(run.teamSnapshot.teamName).trim();
  const members = Array.isArray(run.teamSnapshot.members)
    ? run.teamSnapshot.members.map(memberFromSnapshot).filter((member): member is AgentTeamMemberDto => Boolean(member))
    : [];
  if (!teamName || members.length === 0) return null;
  return {
    teamName,
    teamDescription: stringValue(run.teamSnapshot.teamDescription),
    mainAgentPrompt: stringValue(run.teamSnapshot.mainAgentPrompt),
    members,
  };
}
