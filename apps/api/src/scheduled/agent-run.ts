import type { PrismaClient } from "@yc/db";
import type Anthropic from "@anthropic-ai/sdk";
import { localTools } from "@yc/connector-protocol";
import { runTurn } from "../agent/run.js";
import { execTool as execDefaultTool } from "../agent/tools.js";
import { resolveAgent } from "../agents/service.js";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import { parseDeviceTools, selectMountedTools } from "../tools/tool-mounts.js";
import { SCHED } from "./config.js";
import type { RunAgentArgs, RunAgentFn, RunAgentResult } from "./types.js";

export interface RunAgentDeps {
  readonly prisma: PrismaClient;
  readonly client: Anthropic;
}

export function createRunAgent(deps: RunAgentDeps): RunAgentFn {
  return async (args: RunAgentArgs): Promise<RunAgentResult> => {
    const { prisma, client } = deps;

    // 系统提示词：Agent 人设（可选）
    let system: string | undefined;
    if (args.agentId) {
      const agent = await resolveAgent(prisma, args.userId, args.agentId);
      system = agent.agentPrompt || undefined;
    }

    // 有绑定在线设备则挂 connector 本地工具（终端/文件等），操控用户本机
    let tools: Anthropic.Tool[] | undefined;
    let execTool: ((name: string, input: unknown) => Promise<string>) | undefined;
    if (args.deviceId) {
      const device = await prisma.device.findFirst({
        where: { id: args.deviceId, userId: args.userId, online: true, revokedAt: null },
        select: { id: true, userId: true, capabilities: true, tools: true },
      });
      if (device) {
        const mounted = selectMountedTools({
          requestedToolIds: [],
          builtinTools: localTools,
          installedTools: [],
          deviceCapabilities: device.capabilities,
          deviceTools: parseDeviceTools(device.tools),
        });
        if (mounted.tools.length > 0) {
          const localExec = makeLocalExecTool(getDispatcher(), args.userId, device.id, device.userId);
          tools = mounted.tools;
          execTool = (name, input) =>
            mounted.allowedToolNames.has(name) ? localExec(name, input) : execDefaultTool(name, input);
        }
      }
    }

    // 注：KB 注入（args.kbIds）留待 P1 后续接通前端 KB 选择后补；定时任务不读写长期记忆。
    const result = await runTurn({
      client,
      model: args.model,
      history: [{ role: "user", content: args.prompt }],
      system,
      tools,
      execTool: execTool ?? execDefaultTool,
      maxOutputTokens: SCHED.maxOutputTokens,
      maxIterations: SCHED.maxIterations,
      streamTotalTimeoutMs: SCHED.streamTotalTimeoutMs,
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  };
}
