import type { Dispatcher } from "./dispatch.js";

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;

function localToolTimeoutMs(): number {
  const raw = Number(process.env.CONNECTOR_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOOL_TIMEOUT_MS;
}

// 返回一个 execTool(name,input)：把工具调用经 dispatcher 路由到设备，
// 失败时把错误码原样喂给模型（绝不抛，避免崩整轮 / 触发重跑）。
export function makeLocalExecTool(
  dispatcher: Pick<Dispatcher, "dispatchTool">,
  userId: string,
  deviceId: string,
  deviceUserId: string,
  opts?: { skipConfirm?: boolean },
): (name: string, input: unknown) => Promise<string> {
  return async (name, input) => {
    try {
      return await dispatcher.dispatchTool({
        deviceId,
        userId,
        deviceUserId,
        tool: name,
        args: (input ?? {}) as Record<string, unknown>,
        timeoutMs: localToolTimeoutMs(),
        skipConfirm: opts?.skipConfirm,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `[工具执行失败: ${message}] 这一步结果未知，请勿假设已成功；可先检查状态再决定是否重试。`;
    }
  };
}
