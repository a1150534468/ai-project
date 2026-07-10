import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWechatTurn, WECHAT_MODEL } from "./turn.js";

describe("runWechatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("强制 MiniMax-M3、预扣→跑→结算，返回回复文本并落库", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 1 })),
    };
    const runTurn = vi.fn(async () => ({
      text: "机器人回复",
      usage: { inputTokens: 3, outputTokens: 5 },
      messages: [],
      toolCalls: 0,
      stoppedByMaxIterations: false,
    }));
    const prisma = {
      message: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "msg1" })),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "你是助手",
        })),
      },
    };

    const result = await runWechatTurn({
      prisma: prisma as never,
      billing: billing as never,
      runTurn: runTurn as never,
      client: {} as never,
      binding: {
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent",
        targetId: "a1",
        sessionId: "s1", model: "MiniMax-M3",
      },
      text: "你好",
      buildComputerTools: async () => null, // P1/P2：无设备工具
    });

    expect(WECHAT_MODEL).toBe("MiniMax-M3");
    expect(billing.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        model: "MiniMax-M3",
        type: "chat",
      })
    );
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "MiniMax-M3" })
    );
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        model: "MiniMax-M3",
        outputTokens: 5,
      })
    );
    expect(result.text).toBe("机器人回复");
    expect(prisma.message.create).toHaveBeenCalledTimes(2); // user + assistant
  });

  it("runTurn 抛错时预扣被结算/释放（不泄漏），并把错误抛出", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 0 })),
    };
    const runTurn = vi.fn(async () => {
      throw new Error("llm boom");
    });
    const prisma = {
      message: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "msg1" })),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "x",
        })),
      },
    };

    await expect(
      runWechatTurn({
        prisma: prisma as never,
        billing: billing as never,
        runTurn: runTurn as never,
        client: {} as never,
        binding: {
          userId: "u1",
          deviceId: "dev1",
          targetType: "agent",
          targetId: "a1",
          sessionId: "s1", model: "MiniMax-M3",
        },
        text: "hi",
        buildComputerTools: async () => null, // P1/P2：无设备工具
      })
    ).rejects.toThrow(/llm boom/);

    // 关键：即使失败，也要结算预扣（settle 被调用，outputTokens=0），避免预扣悬挂
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        model: "MiniMax-M3",
        inputTokens: 0,
        outputTokens: 0,
      })
    );
  });

  it("会话不存在时抛错，且不调用 runTurn", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 0 })),
    };
    const runTurn = vi.fn();
    const prisma = {
      message: {
        findMany: vi.fn(async () => []),
        create: vi.fn(),
      },
      session: {
        findUnique: vi.fn(async () => null),
      },
    };

    await expect(
      runWechatTurn({
        prisma: prisma as never,
        billing: billing as never,
        runTurn: runTurn as never,
        client: {} as never,
        binding: {
          userId: "u1",
          deviceId: "dev1",
          targetType: "agent",
          targetId: "a1",
          sessionId: "s1", model: "MiniMax-M3",
        },
        text: "hi",
        buildComputerTools: async () => null, // P1/P2：无设备工具
      })
    ).rejects.toThrow(/会话不存在/);

    expect(runTurn).not.toHaveBeenCalled();
    expect(billing.settle).not.toHaveBeenCalled();
  });

  it("会话属于不同用户时抛错", async () => {
    const billing = {
      reserve: vi.fn(),
      settle: vi.fn(),
    };
    const runTurn = vi.fn();
    const prisma = {
      message: {
        findMany: vi.fn(),
        create: vi.fn(),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u2", // 不同用户
          agentPrompt: "x",
        })),
      },
    };

    await expect(
      runWechatTurn({
        prisma: prisma as never,
        billing: billing as never,
        runTurn: runTurn as never,
        client: {} as never,
        binding: {
          userId: "u1",
          deviceId: "dev1",
          targetType: "agent",
          targetId: "a1",
          sessionId: "s1", model: "MiniMax-M3",
        },
        text: "hi",
        buildComputerTools: async () => null, // P1/P2：无设备工具
      })
    ).rejects.toThrow(/会话不存在或不属于绑定用户/);

    expect(runTurn).not.toHaveBeenCalled();
  });

  it("reserve 失败时不调用 runTurn，但不结算（因为预扣未成功）", async () => {
    const billing = {
      reserve: vi.fn(async () => {
        throw new Error("reserve failed");
      }),
      settle: vi.fn(),
    };
    const runTurn = vi.fn();
    const prisma = {
      message: {
        findMany: vi.fn(async () => []),
        create: vi.fn(),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "x",
        })),
      },
    };

    await expect(
      runWechatTurn({
        prisma: prisma as never,
        billing: billing as never,
        runTurn: runTurn as never,
        client: {} as never,
        binding: {
          userId: "u1",
          deviceId: "dev1",
          targetType: "agent",
          targetId: "a1",
          sessionId: "s1", model: "MiniMax-M3",
        },
        text: "hi",
        buildComputerTools: async () => null, // P1/P2：无设备工具
      })
    ).rejects.toThrow(/reserve failed/);

    expect(runTurn).not.toHaveBeenCalled();
    expect(billing.settle).not.toHaveBeenCalled(); // 未预扣就不结算
  });

  it("带图片 media：转 attachment 喂 M3，当前用户消息为多模态 content", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 1 })),
    };
    let seenHistory: any;
    const runTurn = vi.fn(async (a: any) => {
      seenHistory = a.history;
      return {
        text: "看到了",
        usage: { inputTokens: 3, outputTokens: 5 },
        messages: [],
        toolCalls: 0,
        stoppedByMaxIterations: false,
      };
    });
    const prisma = {
      message: {
        findMany: vi.fn(async () => [
          { id: "u1", role: "user", content: "看图[附件]\n\n[附件]\n- wx.jpg（图片，1KB）", createdAt: new Date() },
        ]),
        create: vi.fn(async () => ({ id: "u1" })),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "x",
        })),
      },
    };

    const out = await runWechatTurn({
      prisma: prisma as never,
      billing: billing as never,
      runTurn: runTurn as never,
      client: {} as never,
      binding: {
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent",
        targetId: "a1",
        sessionId: "s1", model: "MiniMax-M3",
      },
      text: "看图",
      media: [
        {
          kind: "image",
          name: "wx.jpg",
          mime: "image/jpeg",
          dataBase64: Buffer.from([255, 216, 255]).toString("base64"),
        },
      ],
      buildComputerTools: async () => null, // P1/P2：无设备工具
    });

    expect(out.text).toBe("看到了");
    const last = seenHistory[seenHistory.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content.some((b: any) => b.type === "image")).toBe(true);
  });

  it("无 media 时保持纯文字（向后兼容 P1）", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 1 })),
    };
    let seenHistory: any;
    const runTurn = vi.fn(async (a: any) => {
      seenHistory = a.history;
      return {
        text: "纯文字回复",
        usage: { inputTokens: 3, outputTokens: 5 },
        messages: [],
        toolCalls: 0,
        stoppedByMaxIterations: false,
      };
    });
    const prisma = {
      message: {
        findMany: vi.fn(async () => [
          { id: "u1", role: "user", content: "你好", createdAt: new Date() },
        ]),
        create: vi.fn(async () => ({ id: "u1" })),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "x",
        })),
      },
    };

    const out = await runWechatTurn({
      prisma: prisma as never,
      billing: billing as never,
      runTurn: runTurn as never,
      client: {} as never,
      binding: {
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent",
        targetId: "a1",
        sessionId: "s1", model: "MiniMax-M3",
      },
      text: "你好",
      buildComputerTools: async () => null, // P1/P2：无设备工具
    });

    expect(out.text).toBe("纯文字回复");
    const last = seenHistory[seenHistory.length - 1];
    expect(typeof last.content).toBe("string"); // 无 media 时仍为 string
  });

  it("单 agent：挂载绑定设备电脑工具传给 runTurn", async () => {
    const billing = {
      reserve: vi.fn(async () => ({ reserved: 1 })),
      settle: vi.fn(async () => ({ settled: 1 })),
    };
    let seenTools: any;
    let seenExecTool: any;
    const runTurn = vi.fn(async (a: any) => {
      seenTools = a.tools;
      seenExecTool = a.execTool;
      return {
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1 },
        messages: [],
        toolCalls: 0,
        stoppedByMaxIterations: false,
      };
    });
    const prisma = {
      message: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "msg1" })),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
          agentPrompt: "p",
        })),
      },
    };
    const fakeTools = {
      tools: [
        {
          name: "terminal_exec",
          description: "执行终端命令",
          input_schema: { type: "object" as const },
        },
      ],
      execTool: vi.fn(async () => ""),
    };

    await runWechatTurn({
      prisma: prisma as never,
      billing: billing as never,
      runTurn: runTurn as never,
      client: {} as never,
      binding: {
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent",
        targetId: "a1",
        sessionId: "s1", model: "MiniMax-M3",
      },
      text: "看",
      buildComputerTools: async () => fakeTools as never,
    });

    expect(seenTools).toBe(fakeTools.tools);
    expect(seenExecTool).toBe(fakeTools.execTool);
  });

  it("targetType team → 走团队执行，返回 finalReport 并落库 assistant", async () => {
    const runTeam = vi.fn(async () => ({ text: "团队最终报告" }));
    const prisma = {
      message: {
        create: vi.fn(async () => ({ id: "u1" })),
        findMany: vi.fn(async () => []),
      },
      session: {
        findUnique: vi.fn(async () => ({
          id: "s1",
          userId: "u1",
        })),
      },
    };

    const result = await runWechatTurn({
      prisma: prisma as never,
      billing: { reserve: vi.fn(), settle: vi.fn() } as never,
      runTurn: vi.fn() as never,
      client: {} as never,
      binding: {
        userId: "u1",
        deviceId: "dev1",
        targetType: "team",
        targetId: "team1",
        sessionId: "s1", model: "MiniMax-M3",
      },
      text: "帮我干活",
      buildComputerTools: async () => null,
      runTeam: runTeam as never,
    });

    expect(runTeam).toHaveBeenCalledWith({
      prisma,
      binding: expect.objectContaining({
        userId: "u1",
        targetType: "team",
        targetId: "team1",
        sessionId: "s1", model: "MiniMax-M3",
      }),
      text: "帮我干活",
    });
    expect(result.text).toBe("团队最终报告");
    // 应落库 assistant 消息
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "assistant",
          content: "团队最终报告",
        }),
      })
    );
  });
});
