import type { PrismaClient } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";
import { loadLlmConfig, createLlmClient } from "@yc/llm";
import { getPresetAgent, loadAgentPresets } from "./presets.js";
import { CUSTOM_AGENT_ICON } from "./icons.js";
import { generateAvatarSvg } from "./avatar.js";
import { loadS3Config } from "../storage/s3.js";
import { publicObjectUrl } from "../storage/public-url.js";

export interface AgentOption {
  id: string;
  name: string;
  description: string;
  icon: string;
  type: "preset" | "custom";
  createdAt?: string;
  avatarSvg?: string | null;
  avatarUrl?: string | null;
}

export interface AgentRuntime {
  agentId: string;
  agentName: string;
  agentPrompt: string;
  agentIcon: string;
}

const PRIMARY_CREATE_MODEL = "mimo-v2.5-pro-ultraspeed";
const FALLBACK_CREATE_MODEL = "MiniMax-M3";

let cachedAvatarUrlOf: ((key: string) => string) | null = null;

/**
 * object key → 可访问 URL。S3 未配置时原样返回 key（本地/测试不阻断）。
 */
export function avatarPublicUrl(key: string | null): string | null {
  if (!key) return null;
  if (!cachedAvatarUrlOf) {
    try {
      const cfg = loadS3Config();
      cachedAvatarUrlOf = (k) => publicObjectUrl(cfg, k);
    } catch {
      cachedAvatarUrlOf = (k) => k;
    }
  }
  return cachedAvatarUrlOf(key);
}

export function publicPresetAgents(): AgentOption[] {
  return loadAgentPresets().map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    icon: preset.icon,
    type: "preset",
  }));
}

export function iconForAgentId(agentId?: string | null): string {
  if (!agentId) return getPresetAgent("preset-1")?.icon ?? CUSTOM_AGENT_ICON;
  return getPresetAgent(agentId)?.icon ?? CUSTOM_AGENT_ICON;
}

export async function listCustomAgents(prisma: PrismaClient, userId: string): Promise<AgentOption[]> {
  const rows = await prisma.userAgent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, description: true, createdAt: true, avatarSvg: true, avatarUrl: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    icon: CUSTOM_AGENT_ICON,
    type: "custom",
    createdAt: row.createdAt.toISOString(),
    avatarSvg: row.avatarSvg,
    avatarUrl: avatarPublicUrl(row.avatarUrl),
  }));
}

export async function resolveAgent(prisma: PrismaClient, userId: string, agentId?: string | null): Promise<AgentRuntime> {
  const id = agentId || "preset-1";
  const preset = getPresetAgent(id);
  if (preset) {
    return { agentId: preset.id, agentName: preset.name, agentPrompt: preset.prompt, agentIcon: preset.icon };
  }

  const custom = await prisma.userAgent.findFirst({ where: { id, userId } });
  if (!custom) {
    const fallback = getPresetAgent("preset-1");
    if (!fallback) throw new Error("default agent missing");
    return { agentId: fallback.id, agentName: fallback.name, agentPrompt: fallback.prompt, agentIcon: fallback.icon };
  }
  return { agentId: custom.id, agentName: custom.name, agentPrompt: custom.prompt, agentIcon: CUSTOM_AGENT_ICON };
}

function parseGeneratedAgent(text: string): { name: string; description: string; systemPrompt: string } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? jsonMatch[0] : text;
  const parsed = JSON.parse(raw) as Partial<{ name: string; description: string; systemPrompt: string }>;
  const name = parsed.name?.trim();
  const description = parsed.description?.trim() ?? "";
  const systemPrompt = parsed.systemPrompt?.trim();
  if (!name || !systemPrompt) {
    throw new Error("invalid generated agent");
  }
  return {
    name: name.slice(0, 40),
    description: description.slice(0, 160),
    systemPrompt,
  };
}

async function requestGeneratedAgent(client: Anthropic, model: string, requirement: string) {
  const resp = await client.messages.create({
    model,
    max_tokens: 2200,
    system: "你是智能体配置生成器。只输出 JSON，不要 Markdown。",
    messages: [{
      role: "user",
      content: `根据用户需求创建一个可直接作为 system prompt 使用的中文智能体配置。\n\n用户需求：${requirement}\n\n输出 JSON 字段：name、description、systemPrompt。systemPrompt 要完整、清晰、可执行，并默认允许使用平台已开放的全部工具。`,
    }],
  });
  const text = resp.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return parseGeneratedAgent(text);
}

export async function generateCustomAgent(prisma: PrismaClient, userId: string, requirement: string) {
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  let modelUsed = PRIMARY_CREATE_MODEL;
  let generated: { name: string; description: string; systemPrompt: string };
  try {
    generated = await requestGeneratedAgent(client, PRIMARY_CREATE_MODEL, requirement);
  } catch {
    modelUsed = FALLBACK_CREATE_MODEL;
    generated = await requestGeneratedAgent(client, FALLBACK_CREATE_MODEL, requirement);
  }

  const avatarSvg = await generateAvatarSvg(client, modelUsed, generated.name, generated.description);

  const row = await prisma.userAgent.create({
    data: {
      userId,
      name: generated.name,
      description: generated.description,
      prompt: generated.systemPrompt,
      modelUsed,
      avatarSvg,
    },
  });
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: CUSTOM_AGENT_ICON,
    type: "custom" as const,
    modelUsed,
    createdAt: row.createdAt.toISOString(),
    avatarSvg: row.avatarSvg,
    avatarUrl: avatarPublicUrl(row.avatarUrl),
  };
}

/** 重命名。返回 false 表示 agent 不存在或不属于该用户（调用方一律回 404，不泄露存在性）。 */
export async function renameAgent(prisma: PrismaClient, userId: string, id: string, name: string): Promise<boolean> {
  const r = await prisma.userAgent.updateMany({ where: { id, userId }, data: { name } });
  return r.count === 1;
}

/**
 * 删除 Agent 并级联删除其全部对话与消息。
 * Session.agentId 没有外键，必须显式删；Message 靠 Session 的 onDelete: Cascade 连带走。
 * 返回被删 Agent 的 avatarUrl（调用方在事务外 best-effort 删 S3 对象），不存在则返回 undefined。
 */
export async function deleteAgentCascade(
  prisma: PrismaClient, userId: string, id: string,
): Promise<{ avatarUrl: string | null } | undefined> {
  return prisma.$transaction(async (tx) => {
    const agent = await tx.userAgent.findFirst({ where: { id, userId }, select: { avatarUrl: true } });
    if (!agent) return undefined;
    await tx.session.deleteMany({ where: { userId, agentId: id } });
    await tx.userAgent.deleteMany({ where: { id, userId } });
    return { avatarUrl: agent.avatarUrl };
  });
}

/** 重画头像。返回新的 avatarSvg（可能 null，生成失败回落默认图标）；agent 不存在返回 undefined。 */
export async function regenerateAgentAvatar(
  prisma: PrismaClient, userId: string, id: string,
): Promise<{ avatarSvg: string | null } | undefined> {
  const agent = await prisma.userAgent.findFirst({ where: { id, userId }, select: { name: true, description: true } });
  if (!agent) return undefined;
  const cfg = loadLlmConfig();
  const client = createLlmClient(cfg);
  let avatarSvg = await generateAvatarSvg(client, PRIMARY_CREATE_MODEL, agent.name, agent.description);
  if (!avatarSvg) {
    avatarSvg = await generateAvatarSvg(client, FALLBACK_CREATE_MODEL, agent.name, agent.description);
  }
  await prisma.userAgent.updateMany({ where: { id, userId }, data: { avatarSvg } });
  return { avatarSvg };
}

export async function agentAvatarUrlOf(
  prisma: PrismaClient, userId: string, id: string,
): Promise<{ avatarUrl: string | null } | undefined> {
  const row = await prisma.userAgent.findFirst({ where: { id, userId }, select: { avatarUrl: true } });
  return row ?? undefined;
}

export async function setAgentAvatarUrl(
  prisma: PrismaClient, userId: string, id: string, avatarUrl: string,
): Promise<boolean> {
  const r = await prisma.userAgent.updateMany({ where: { id, userId }, data: { avatarUrl } });
  return r.count === 1;
}
