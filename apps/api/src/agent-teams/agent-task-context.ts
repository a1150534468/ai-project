import type Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { localTools } from "@ai-assistant/connector-protocol";
import { prepareChatAttachments, type ChatAttachmentPayload } from "../chat/attachments.js";
import {
  describeKnowledgeBaseContext,
  emptyKnowledgeBaseContext,
  knowledgeBaseContextToJson,
  readKnowledgeBaseContext,
  type AgentKnowledgeBaseContext,
} from "./agent-knowledge-context.js";

export interface AgentTaskAttachmentSummary {
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "file";
}

export interface AgentTaskComputerToolSummary {
  readonly name: string;
  readonly description: string;
}

export interface AgentTaskContext {
  readonly selectedModel?: string;
  readonly knowledgeBase: AgentKnowledgeBaseContext;
  readonly attachments: readonly AgentTaskAttachmentSummary[];
  readonly attachmentLabel: string;
  readonly attachmentText: string;
  readonly hasImageAttachment: boolean;
  readonly computerTools: readonly AgentTaskComputerToolSummary[];
}

export interface AgentTaskContextInput {
  readonly model?: string;
  readonly attachments?: readonly ChatAttachmentPayload[];
  readonly knowledgeBase?: AgentKnowledgeBaseContext;
}

function toolDescription(tool: Anthropic.Tool): string {
  return typeof tool.description === "string" ? tool.description : "";
}

function toComputerToolSummary(tool: Anthropic.Tool): AgentTaskComputerToolSummary {
  return {
    name: tool.name,
    description: toolDescription(tool),
  };
}

function emptyTaskContext(model?: string, knowledgeBase: AgentKnowledgeBaseContext = emptyKnowledgeBaseContext()): AgentTaskContext {
  return {
    selectedModel: model?.trim() || undefined,
    knowledgeBase,
    attachments: [],
    attachmentLabel: "",
    attachmentText: "",
    hasImageAttachment: false,
    computerTools: localTools.map(toComputerToolSummary),
  };
}

export async function buildAgentTaskContext(input: AgentTaskContextInput): Promise<AgentTaskContext> {
  const model = input.model?.trim() || undefined;
  const knowledgeBase = input.knowledgeBase ?? emptyKnowledgeBaseContext();
  const attachments = [...(input.attachments ?? [])];
  if (attachments.length === 0) return emptyTaskContext(model, knowledgeBase);

  const prepared = await prepareChatAttachments(attachments);
  return {
    selectedModel: model,
    knowledgeBase,
    attachments: attachments.map((attachment) => ({
      name: attachment.name,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
    })),
    attachmentLabel: prepared.storedLabel,
    attachmentText: prepared.searchableText,
    hasImageAttachment: prepared.hasImage,
    computerTools: localTools.map(toComputerToolSummary),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isJsonObject(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentSummaries(value: unknown): AgentTaskAttachmentSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Prisma.JsonObject => isJsonObject(item as Prisma.JsonValue))
    .map((item) => ({
      name: stringValue(item.name),
      mime: stringValue(item.mime),
      sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : 0,
      kind: item.kind === "image" ? "image" as const : "file" as const,
    }))
    .filter((item) => item.name.length > 0 && item.sizeBytes > 0);
}

function computerToolSummaries(value: unknown): AgentTaskComputerToolSummary[] {
  if (!Array.isArray(value)) return localTools.map(toComputerToolSummary);
  const tools = value
    .filter((item): item is Prisma.JsonObject => isJsonObject(item as Prisma.JsonValue))
    .map((item) => ({
      name: stringValue(item.name),
      description: stringValue(item.description),
    }))
    .filter((item) => item.name.length > 0);
  return tools.length > 0 ? tools : localTools.map(toComputerToolSummary);
}

export function taskContextToJson(context: AgentTaskContext): Prisma.InputJsonObject {
  return {
    selectedModel: context.selectedModel ?? "",
    knowledgeBase: knowledgeBaseContextToJson(context.knowledgeBase),
    attachments: context.attachments.map((attachment) => ({
      name: attachment.name,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
    })),
    attachmentLabel: context.attachmentLabel,
    attachmentText: context.attachmentText,
    hasImageAttachment: context.hasImageAttachment,
    computerTools: context.computerTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  };
}

export function readTaskContextFromSnapshot(snapshot: Prisma.JsonValue): AgentTaskContext {
  if (!isJsonObject(snapshot) || !isJsonObject(snapshot.taskContext as Prisma.JsonValue)) {
    return emptyTaskContext();
  }
  const taskContext = snapshot.taskContext as Prisma.JsonObject;
  const selectedModel = stringValue(taskContext.selectedModel).trim() || undefined;
  return {
    selectedModel,
    knowledgeBase: readKnowledgeBaseContext(taskContext.knowledgeBase),
    attachments: attachmentSummaries(taskContext.attachments),
    attachmentLabel: stringValue(taskContext.attachmentLabel),
    attachmentText: stringValue(taskContext.attachmentText),
    hasImageAttachment: taskContext.hasImageAttachment === true,
    computerTools: computerToolSummaries(taskContext.computerTools),
  };
}

export function describeTaskContext(context: AgentTaskContext): string {
  const sections: string[] = [];
  if (context.selectedModel) sections.push(`本次任务指定模型：${context.selectedModel}`);
  const knowledgeText = describeKnowledgeBaseContext(context.knowledgeBase);
  if (knowledgeText) sections.push(knowledgeText);
  if (context.attachments.length > 0) {
    sections.push([
      "用户上传的文件：",
      ...context.attachments.map((attachment) => (
        `- ${attachment.name}（${attachment.kind === "image" ? "图片" : "文件"}，${Math.ceil(attachment.sizeBytes / 1024)}KB，${attachment.mime}）`
      )),
    ].join("\n"));
  }
  if (context.attachmentText.trim()) {
    sections.push(`附件可检索内容：\n${context.attachmentText}`);
  }
  if (context.computerTools.length > 0) {
    sections.push([
      "可操作用户电脑的工具已完整暴露给工作流 Agent，按需调用；若没有在线桌面设备，执行器会降级为纯文本任务。",
      ...context.computerTools.map((tool) => `- ${tool.name}: ${tool.description}`),
    ].join("\n"));
  }
  return sections.join("\n\n");
}
