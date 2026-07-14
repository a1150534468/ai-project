import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatRoutes } from "./routes.js";

const mocks = vi.hoisted(() => {
  class MockChatModelEmptyResponseError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ChatModelEmptyResponseError";
    }
  }

  class MockChatModelStreamTimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ChatModelStreamTimeoutError";
    }
  }

  const messages: Array<{
    id: string;
    sessionId: string;
    role: string;
    content: string;
    model?: string;
    createdAt: Date;
  }> = [];

  const sessions: Array<{
    id: string;
    userId: string;
    agentId: string | null;
    agentName: string | null;
    agentPrompt: string | null;
  }> = [];

  const mockBilling = {
    listEnabledModels: vi.fn(),
    reserve: vi.fn(),
    settle: vi.fn(),
  };
  const mockRunTurn = vi.fn();
  const mockRelease = vi.fn();

  const mockPrisma = {
    session: {
      create: vi.fn(async ({ data }: { data: { userId: string; agentId?: string | null; agentName?: string | null; agentPrompt?: string | null } }) => {
        const session = {
          id: "session-1",
          userId: data.userId,
          agentId: data.agentId ?? null,
          agentName: data.agentName ?? null,
          agentPrompt: data.agentPrompt ?? null,
        };
        sessions.push(session);
        return session;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        sessions.find((session) => session.id === where.id) ?? null
      ),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(async ({ select }: { select?: { bannedAt?: boolean } }) => {
        if (select?.bannedAt) return { bannedAt: null };
        return { id: "user-1", memoryEnabled: false };
      }),
    },
    message: {
      create: vi.fn(async ({ data, select }: {
        data: { sessionId: string; role: string; content: string; model?: string };
        select?: { id?: boolean };
      }) => {
        const message = {
          id: `message-${messages.length + 1}`,
          sessionId: data.sessionId,
          role: data.role,
          content: data.content,
          model: data.model,
          createdAt: new Date(),
        };
        messages.push(message);
        return select?.id ? { id: message.id } : message;
      }),
      findMany: vi.fn(async ({ where }: { where: { sessionId: string } }) =>
        messages.filter((message) => message.sessionId === where.sessionId)
      ),
    },
    device: {
      findMany: vi.fn(async () => []),
    },
  };

  return {
    messages,
    sessions,
    mockBilling,
    mockPrisma,
    mockRelease,
    mockRunTurn,
    MockChatModelEmptyResponseError,
    MockChatModelStreamTimeoutError,
  };
});

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => mocks.mockPrisma,
  getRedis: () => ({}),
}));

vi.mock("@ai-assistant/llm", () => ({
  createLlmClient: () => ({}),
  loadLlmConfig: () => ({ defaultModel: "glm-5.2" }),
}));

vi.mock("@ai-assistant/billing", () => ({
  InsufficientBalanceError: class InsufficientBalanceError extends Error {},
  createBillingClient: () => mocks.mockBilling,
}));

vi.mock("../agent/run.js", () => ({
  chatMaxOutputTokenBudget: () => 12345,
  ChatModelEmptyResponseError: mocks.MockChatModelEmptyResponseError,
  ChatModelStreamTimeoutError: mocks.MockChatModelStreamTimeoutError,
  runTurn: mocks.mockRunTurn,
}));

vi.mock("./lock.js", () => ({
  acquireSessionLock: vi.fn(async () => mocks.mockRelease),
}));

vi.mock("../agents/service.js", () => ({
  iconForAgentId: () => "mdi:robot-outline",
  resolveAgent: vi.fn(async () => ({
    agentId: null,
    agentName: "默认助手",
    agentPrompt: undefined,
    agentIcon: "mdi:robot-outline",
  })),
}));

vi.mock("../kb/retrieve.js", () => ({
  dedupeKbCitations: vi.fn(() => []),
  filterRelevantChunks: vi.fn(() => []),
  resolveEffectiveKbIds: vi.fn(async () => []),
  retrieveChunks: vi.fn(async () => []),
  shouldRetrieveKbForQuery: vi.fn(() => false),
}));

async function makeApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = "user-1";
  });
  await app.register(chatRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messages.length = 0;
  mocks.sessions.length = 0;
  process.env.BILLING_BASE_URL = "http://billing";
  process.env.BILLING_INTERNAL_TOKEN = "token";
  mocks.mockBilling.listEnabledModels.mockResolvedValue({ data: [{ model: "glm-5.2" }] });
  mocks.mockBilling.reserve.mockResolvedValue({});
  mocks.mockBilling.settle.mockResolvedValue({});
  mocks.mockRunTurn.mockRejectedValue(new mocks.MockChatModelEmptyResponseError("CHAT_MODEL_EMPTY_RESPONSE"));
});

describe("聊天空响应保护", () => {
  it("模型空响应时退回主对话预扣，并且不保存空助手消息", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "写三篇文章", model: "glm-5.2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("模型未返回内容，请重试");
    expect(response.body).not.toContain("event: done");
    expect(mocks.mockBilling.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.mockBilling.reserve).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 10000,
    }));
    expect(mocks.mockBilling.settle).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.stringMatching(/^turn:session-1:/),
      userId: "user-1",
      model: "glm-5.2",
      inputTokens: 0,
      outputTokens: 0,
    }));
    expect(mocks.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    await app.close();
  });
});
