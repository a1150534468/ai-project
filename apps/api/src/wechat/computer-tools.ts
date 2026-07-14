import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@ai-assistant/db";
import { localTools } from "@ai-assistant/connector-protocol";
import type { Dispatcher } from "../connector/dispatch.js";
import { getDispatcher } from "../connector/hub.js";
import { makeLocalExecTool } from "../connector/local-tools.js";
import {
  selectMountedTools,
  parseDeviceTools,
} from "../tools/tool-mounts.js";
import type { ResolvedBinding } from "./binding.js";

export interface WechatComputerTools {
  tools: Anthropic.Tool[];
  execTool: (name: string, input: unknown) => Promise<string>;
}

/**
 * 为微信绑定设备构造电脑工具集。
 * 安全：owner 明确选择"完全放开、无二次确认"——execTool 以 skipConfirm 下发到绑定设备，桌面端不弹高危确认。风险已接受。
 */
export async function buildWechatComputerTools(
  prisma: PrismaClient,
  binding: ResolvedBinding,
  dispatcher: Pick<Dispatcher, "dispatchTool"> = getDispatcher(),
): Promise<WechatComputerTools | null> {
  const device = await prisma.device.findUnique({
    where: { id: binding.deviceId },
    select: { id: true, userId: true, capabilities: true, tools: true },
  });
  if (!device || device.userId !== binding.userId) return null;

  const mounted = selectMountedTools({
    requestedToolIds: [],
    builtinTools: localTools,
    installedTools: [],
    deviceCapabilities: device.capabilities,
    deviceTools: parseDeviceTools(device.tools),
  });
  if (mounted.tools.length === 0) return null;

  const exec = makeLocalExecTool(
    dispatcher,
    binding.userId,
    binding.deviceId,
    device.userId,
    { skipConfirm: true },
  );
  const execTool = (name: string, input: unknown) =>
    mounted.allowedToolNames.has(name)
      ? exec(name, input)
      : Promise.resolve(`[未授权工具: ${name}]`);
  return { tools: mounted.tools, execTool };
}
