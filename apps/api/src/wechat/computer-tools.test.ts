import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildWechatComputerTools } from "./computer-tools.js";

describe("buildWechatComputerTools", () => {
  it("绑定设备在线有工具 → 返回 tools + execTool（execTool 带 skipConfirm 下发到绑定设备）", async () => {
    const dispatched: any[] = [];
    const dispatcher = {
      dispatchTool: vi.fn(async (a: any) => {
        dispatched.push(a);
        return "done";
      }),
    };
    const prisma = {
      device: {
        findUnique: vi.fn(async () => ({
          id: "dev1",
          userId: "u1",
          capabilities: ["terminal_exec"],
          tools: [
            {
              name: "terminal_exec",
              description: "run",
              input_schema: { type: "object", properties: {}, required: [] },
            },
          ],
        })),
      },
    };
    const binding = {
      userId: "u1",
      deviceId: "dev1",
      targetType: "agent" as const,
      targetId: "a1",
      sessionId: "s1", model: "MiniMax-M3",
    };

    const r = await buildWechatComputerTools(
      prisma as never,
      binding,
      dispatcher as never,
    );
    expect(r).not.toBeNull();
    expect(
      (r?.tools ?? []).some(
        (t: Anthropic.Tool) => t.name === "terminal_exec",
      ),
    ).toBe(true);

    await r!.execTool("terminal_exec", { command: "ls" });
    expect(dispatched[0]).toMatchObject({
      deviceId: "dev1",
      userId: "u1",
      deviceUserId: "u1",
      tool: "terminal_exec",
      skipConfirm: true,
    });
  });

  it("设备不存在 → null", async () => {
    const prisma = {
      device: { findUnique: vi.fn(async () => null) },
    };
    const binding = {
      userId: "u1",
      deviceId: "devX",
      targetType: "agent" as const,
      targetId: "a1",
      sessionId: "s1", model: "MiniMax-M3",
    };
    const r = await buildWechatComputerTools(
      prisma as never,
      binding,
      { dispatchTool: vi.fn() } as never,
    );
    expect(r).toBeNull();
  });

  it("设备属于他人 → null（不越权挂别人设备工具）", async () => {
    const prisma = {
      device: {
        findUnique: vi.fn(async () => ({
          id: "dev1",
          userId: "u2",
          capabilities: [],
          tools: [],
        })),
      },
    };
    const binding = {
      userId: "u1",
      deviceId: "dev1",
      targetType: "agent" as const,
      targetId: "a1",
      sessionId: "s1", model: "MiniMax-M3",
    };
    const r = await buildWechatComputerTools(
      prisma as never,
      binding,
      { dispatchTool: vi.fn() } as never,
    );
    expect(r).toBeNull();
  });

  it("未授权工具名不下发", async () => {
    const dispatched: any[] = [];
    const dispatcher = {
      dispatchTool: vi.fn(async (a: any) => {
        dispatched.push(a);
        return "done";
      }),
    };
    const prisma = {
      device: {
        findUnique: vi.fn(async () => ({
          id: "dev1",
          userId: "u1",
          capabilities: ["terminal_exec"],
          tools: [
            {
              name: "terminal_exec",
              description: "run",
              input_schema: { type: "object", properties: {}, required: [] },
            },
          ],
        })),
      },
    };
    const binding = {
      userId: "u1",
      deviceId: "dev1",
      targetType: "agent" as const,
      targetId: "a1",
      sessionId: "s1", model: "MiniMax-M3",
    };

    const r = await buildWechatComputerTools(
      prisma as never,
      binding,
      dispatcher as never,
    );

    // 调用未授权工具
    const result = await r!.execTool("unknown_tool", { arg: "value" });
    expect(result).toContain("未授权工具");
    expect(dispatched.length).toBe(0); // 未下发
  });
});
