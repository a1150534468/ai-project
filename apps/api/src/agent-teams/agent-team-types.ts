import { z } from "zod";

export const AGENT_TEAM_MIN_MEMBERS = 3;
export const AGENT_TEAM_MAX_MEMBERS = 10;
export const AGENT_WORKFLOW_MAX_STEPS = 12;
export const AGENT_TEAM_MEMBER_INVALID = "AGENT_TEAM_MEMBER_INVALID";

export const AGENT_TEAM_RUN_STATUS = {
  draft: "draft",
  draftingTeam: "drafting_team",
  awaitingTeamConfirmation: "awaiting_team_confirmation",
  teamConfirmed: "team_confirmed",
  teamRejected: "team_rejected",
  planning: "planning",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

export const AGENT_WORKFLOW_STEP_STATUS = {
  pending: "pending",
  running: "running",
  reviewing: "reviewing",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
} as const;

export type AgentTeamRunStatus = (typeof AGENT_TEAM_RUN_STATUS)[keyof typeof AGENT_TEAM_RUN_STATUS];
export type AgentWorkflowStepStatus = (typeof AGENT_WORKFLOW_STEP_STATUS)[keyof typeof AGENT_WORKFLOW_STEP_STATUS];

export const recommendedAgentMemberSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  responsibility: z.string().trim().min(1),
  systemPrompt: z.string().trim().default(""),
  skills: z.array(z.string()).default([]),
  isCore: z.boolean().default(false),
});

export const confirmedAgentMemberSchema = recommendedAgentMemberSchema.extend({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(80),
  responsibility: z.string().trim().min(1).max(500),
  systemPrompt: z.string().trim().min(10).max(4000),
  skills: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
}).strict();

export const recommendedTeamSchema = z.object({
  teamName: z.string().trim().min(1),
  teamDescription: z.string().trim().default(""),
  mainAgentPrompt: z.string().trim().default(""),
  members: z.array(recommendedAgentMemberSchema),
});

export const agentTeamAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  kind: z.enum(["image", "file"]),
  dataBase64: z.string().min(1).max(14 * 1024 * 1024),
}).strict();

export const recommendTeamBodySchema = z.object({
  taskGoal: z.string().trim().min(2).max(8000),
  model: z.string().trim().min(1).max(128).optional(),
  kbIds: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
  attachAllOwn: z.boolean().default(false),
  attachments: z.array(agentTeamAttachmentSchema).max(8).default([]),
}).strict();

export const confirmTeamBodySchema = recommendedTeamSchema.extend({
  teamName: z.string().trim().min(1).max(80),
  teamDescription: z.string().trim().max(500).default(""),
  mainAgentPrompt: z.string().trim().max(4000).default(""),
  members: z.array(confirmedAgentMemberSchema).min(AGENT_TEAM_MIN_MEMBERS).max(AGENT_TEAM_MAX_MEMBERS),
}).strict();

export const createRunBodySchema = z.object({
  taskGoal: z.string().trim().min(2).max(8000),
  model: z.string().trim().min(1).max(128).optional(),
  kbIds: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
  attachAllOwn: z.boolean().default(false),
  attachments: z.array(agentTeamAttachmentSchema).max(8).default([]),
}).strict();

export type RecommendedAgentMember = z.infer<typeof recommendedAgentMemberSchema>;
export type RecommendedTeam = z.infer<typeof recommendedTeamSchema>;
export type AgentTeamAttachment = z.infer<typeof agentTeamAttachmentSchema>;
export type RecommendTeamBody = z.infer<typeof recommendTeamBodySchema>;
export type ConfirmTeamBody = z.infer<typeof confirmTeamBodySchema>;
export type CreateRunBody = z.infer<typeof createRunBodySchema>;
