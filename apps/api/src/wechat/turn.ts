import type { PrismaClient } from "@yc/db";
import type Anthropic from "@anthropic-ai/sdk";
import type { runTurn as RunTurnFn } from "../agent/run.js";
import type { ResolvedBinding } from "./binding.js";
import {
  prepareChatAttachments,
  buildCurrentUserContent,
  estimateInputTokens,
  resolveChatModel,
  type ChatAttachmentPayload,
} from "../chat/attachments.js";
import {
  buildWechatComputerTools,
  type WechatComputerTools,
} from "./computer-tools.js";
import { buildAgentTaskContext } from "../agent-teams/agent-task-context.js";
import { createRunFromTeam } from "../agent-teams/agent-workflow-service.js";
import { executeTeamRun } from "../agent-teams/execute-run.js";

export const WECHAT_MODEL = "MiniMax-M3";
const RESERVE_OUTPUT_TOKENS = 10_000; // 与 chat 一致

interface BillingLike {
  reserve: (a: {
    operationId: string;
    userId: string;
    type: string;
    model: string;
    inputTokens: number;
    maxOutputTokens: number;
  }) => Promise<unknown>;
  settle: (a: {
    operationId: string;
    userId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<unknown>;
}

export interface RunWechatTurnArgs {
  prisma: PrismaClient;
  billing: BillingLike;
  runTurn: typeof RunTurnFn;
  client: Anthropic;
  binding: ResolvedBinding;
  text: string;
  media?: Array<{
    kind: "image" | "file";
    name: string;
    mime: string;
    dataBase64: string;
  }>;
  buildComputerTools?: (
    binding: ResolvedBinding
  ) => Promise<WechatComputerTools | null>;
  runTeam?: (args: {
    prisma: PrismaClient;
    binding: ResolvedBinding;
    text: string;
  }) => Promise<{ text: string }>;
}

async function runWechatTeamTurn(args: {
  prisma: PrismaClient;
  binding: ResolvedBinding;
  text: string;
}): Promise<{ text: string }> {
  // 安全：微信团队回合的电脑工具经 skipConfirm 无确认在绑定设备执行（owner 已接受完全放开）。
  // a) 用绑定所选模型的 taskContext（默认 M3）
  const taskContext = await buildAgentTaskContext({
    model: args.binding.model || WECHAT_MODEL,
  });

  // b) 建 run
  const run = await createRunFromTeam(
    args.prisma,
    args.binding.userId,
    args.binding.targetId,
    args.text,
    taskContext
  );

  // c) 微信电脑工具（绑定设备 + skipConfirm）
  const computer = await buildWechatComputerTools(args.prisma, args.binding);

  // d) 同步跑团队（注入 computerTools；团队内部自带计费，不走 chat reserve/settle）
  await executeTeamRun(args.binding.userId, run.id, args.text, run.teamSnapshot, {
    computerTools: computer,
  });

  // 回合结束后关掉 agent 可能打开的浏览器（避免残留窗口）
  if (computer?.execTool) {
    await computer.execTool("browser_close", {}).catch(() => {});
  }

  // e) 读 finalReport
  const finalRun = await args.prisma.agentWorkflowRun.findUnique({
    where: { id_userId: { id: run.id, userId: args.binding.userId } },
  });

  return {
    text:
      finalRun?.finalReport?.trim() ||
      finalRun?.error ||
      "团队执行未产生结果，请稍后重试",
  };
}

export async function runWechatTurn(
  a: RunWechatTurnArgs
): Promise<{ text: string }> {
  const session = await a.prisma.session.findUnique({
    where: { id: a.binding.sessionId },
  });
  if (!session || session.userId !== a.binding.userId) {
    throw new Error("会话不存在或不属于绑定用户");
  }

  // Team 分发：绑定到团队时走独立路径
  if (a.binding.targetType === "team") {
    const runTeam = a.runTeam ?? runWechatTeamTurn;
    const res = await runTeam({
      prisma: a.prisma,
      binding: a.binding,
      text: a.text,
    });
    // 落库 assistant 消息
    await a.prisma.message.create({
      data: {
        sessionId: a.binding.sessionId,
        role: "assistant",
        content: res.text,
        model: a.binding.model || WECHAT_MODEL,
      },
    });
    return res;
  }

  // 将 media 转换为 attachment payloads
  const attachmentPayloads: ChatAttachmentPayload[] = (a.media ?? []).map(
    (m) => ({
      name: m.name,
      mime: m.mime,
      sizeBytes: Buffer.from(m.dataBase64, "base64").length,
      kind: m.kind,
      dataBase64: m.dataBase64,
    })
  );

  // 准备 attachments：转换为 blocks、生成存储标签和可搜索文本
  const prepared = await prepareChatAttachments(attachmentPayloads);

  // 持久化用户消息（含媒体标签便于历史/检索）
  const messageContent = `${a.text}${prepared.storedLabel}`.trim() || "[附件]";
  await a.prisma.message.create({
    data: {
      sessionId: a.binding.sessionId,
      role: "user",
      content: messageContent,
    },
  });

  // 载入历史消息
  const rows = await a.prisma.message.findMany({
    where: { sessionId: a.binding.sessionId },
    orderBy: { createdAt: "asc" },
  });

  // 构造 history：当前用户消息用多模态 content，其他消息用纯文字
  const currentMessageId = rows[rows.length - 1]?.id;
  const history: Anthropic.MessageParam[] = rows.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content:
      m.id === currentMessageId
        ? buildCurrentUserContent(a.text, prepared)
        : m.content,
  }));

  // 安全：微信触发的工具经 skipConfirm 无确认在绑定设备执行（owner 已接受完全放开）。
  const buildTools =
    a.buildComputerTools ?? ((b: ResolvedBinding) =>
      buildWechatComputerTools(a.prisma, b)
    );
  const computer = await buildTools(a.binding);

  // 所选模型；若有图片且该模型不支持视觉 → 预先退避到 M3
  const requestedModel = a.binding.model || WECHAT_MODEL;
  const primaryModel = resolveChatModel(requestedModel, prepared.hasImage).model;

  // 用指定模型跑一次：reserve → runTurn → settle（失败结算 0 不泄漏，向上抛）
  const runOnce = async (model: string) => {
    const operationId = `wechat:${a.binding.sessionId}:${model}:${Date.now()}`;
    await a.billing.reserve({
      operationId,
      userId: a.binding.userId,
      type: "chat",
      model,
      inputTokens: estimateInputTokens(a.text, prepared),
      maxOutputTokens: RESERVE_OUTPUT_TOKENS,
    });
    try {
      const r = await a.runTurn({
        client: a.client,
        model,
        history,
        system: session.agentPrompt ?? undefined,
        tools: computer?.tools ?? [],
        execTool: computer?.execTool,
      });
      await a.billing.settle({
        operationId,
        userId: a.binding.userId,
        model,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      });
      return r;
    } catch (e) {
      await a.billing
        .settle({ operationId, userId: a.binding.userId, model, inputTokens: 0, outputTokens: 0 })
        .catch(() => {});
      throw e;
    }
  };

  let usedModel = primaryModel;
  let result;
  try {
    result = await runOnce(primaryModel);
  } catch (e) {
    // 所选模型（含多模态）报错 → 退避到 M3 再试一次；已是 M3 仍失败则抛出
    if (primaryModel === WECHAT_MODEL) throw e;
    usedModel = WECHAT_MODEL;
    result = await runOnce(WECHAT_MODEL);
  }

  // 回合结束后关掉 agent 可能打开的浏览器（避免残留窗口）
  if (computer?.execTool) {
    await computer.execTool("browser_close", {}).catch(() => {});
  }

  // 持久化助手回复
  await a.prisma.message.create({
    data: {
      sessionId: a.binding.sessionId,
      role: "assistant",
      content: result.text,
      model: usedModel,
    },
  });

  return { text: result.text };
}
