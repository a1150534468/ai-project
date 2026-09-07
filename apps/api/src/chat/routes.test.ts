import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatRoutes } from "./routes.js";

interface StoredSession {
  id: string;
  userId: string;
  agentId: string | null;
  agentName: string | null;
  agentPrompt: string | null;
  attachedKbIds: string[];
  kbAttachAllOwn: boolean;
  updatedAt: Date;
}

interface StoredMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  model?: string;
  createdAt: Date;
}

interface RunArgsDouble {
  history: unknown[];
  model: string;
  system?: string;
  onText?: (text: string) => void;
  onResetText?: () => void;
}

const mocks = vi.hoisted(() => {
  class EmptyResponseError extends Error {
    constructor() {
      super("CHAT_MODEL_EMPTY_RESPONSE");
      this.name = "ChatModelEmptyResponseError";
    }
  }

  class StreamTimeoutError extends Error {
    constructor() {
      super("CHAT_MODEL_STREAM_TIMEOUT");
      this.name = "ChatModelStreamTimeoutError";
    }
  }

  const state = {
    user: null as { id: string; bannedAt: Date | null; memoryEnabled: boolean } | null,
    sessions: [] as StoredSession[],
    messages: [] as StoredMessage[],
    nextMessage: 1,
  };

  const session = {
    create: vi.fn(
      async ({
        data,
      }: {
        data: {
          userId: string;
          agentId?: string | null;
          agentName?: string | null;
          agentPrompt?: string | null;
        };
      }) => {
        const row: StoredSession = {
          id: "session-new",
          userId: data.userId,
          agentId: data.agentId ?? null,
          agentName: data.agentName ?? null,
          agentPrompt: data.agentPrompt ?? null,
          attachedKbIds: [],
          kbAttachAllOwn: false,
          updatedAt: new Date("2026-09-07T08:00:00.000Z"),
        };
        state.sessions.push(row);
        return row;
      },
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) => state.sessions.find((row) => row.id === where.id) ?? null,
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { updatedAt?: Date; attachedKbIds?: string[]; kbAttachAllOwn?: boolean };
      }) => {
        const row = state.sessions.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("session missing");
        if (data.updatedAt) row.updatedAt = data.updatedAt;
        if (data.attachedKbIds !== undefined) row.attachedKbIds = [...data.attachedKbIds];
        if (data.kbAttachAllOwn !== undefined) row.kbAttachAllOwn = data.kbAttachAllOwn;
        return row;
      },
    ),
    findMany: vi.fn(async () => []),
    delete: vi.fn(async () => null),
  };

  const message = {
    create: vi.fn(async ({ data }: { data: { sessionId: string; role: string; content: string; model?: string } }) => {
      const row: StoredMessage = {
        id: "message-" + state.nextMessage++,
        sessionId: data.sessionId,
        role: data.role,
        content: data.content,
        model: data.model,
        createdAt: new Date(),
      };
      state.messages.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where: { sessionId: string } }) =>
      state.messages.filter((row) => row.sessionId === where.sessionId),
    ),
  };

  const mockPrisma = {
    user: { findUnique: vi.fn(async () => state.user) },
    session,
    message,
    $transaction: vi.fn(),
  };
  mockPrisma.$transaction.mockImplementation(async (work: (tx: typeof mockPrisma) => Promise<unknown>) =>
    work(mockPrisma),
  );

  return {
    state,
    mockPrisma,
    config: {
      defaultModel: "glm-5.2",
      provider: "bailian" as const,
      modelRoutes: undefined as Array<{ model: string }> | undefined,
    },
    client: {},
    runTurn: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    resolveAgent: vi.fn(),
    resolveEffectiveKbIds: vi.fn(),
    shouldRetrieveKbForQuery: vi.fn(),
    retrieveChunks: vi.fn(),
    filterRelevantChunks: vi.fn(),
    dedupeKbCitations: vi.fn(),
    loadEmbeddingConfig: vi.fn(),
    embed: vi.fn(),
    searchMemory: vi.fn(),
    addTurn: vi.fn(),
    EmptyResponseError,
    StreamTimeoutError,
  };
});

vi.mock("@ai-assistant/db", () => ({
  getPrisma: () => mocks.mockPrisma,
  getRedis: () => ({}),
}));

vi.mock("@ai-assistant/llm", () => ({
  createLlmClient: () => mocks.client,
  loadLlmConfig: () => mocks.config,
}));

vi.mock("../agent/run.js", () => ({
  ChatModelEmptyResponseError: mocks.EmptyResponseError,
  ChatModelStreamTimeoutError: mocks.StreamTimeoutError,
  runTurn: mocks.runTurn,
}));

vi.mock("../agents/service.js", () => ({
  iconForAgentId: (agentId: string | null) => (agentId ? "icon:" + agentId : "icon:default"),
  resolveAgent: mocks.resolveAgent,
}));

vi.mock("../kb/retrieve.js", () => ({
  dedupeKbCitations: mocks.dedupeKbCitations,
  filterRelevantChunks: mocks.filterRelevantChunks,
  resolveEffectiveKbIds: mocks.resolveEffectiveKbIds,
  retrieveChunks: mocks.retrieveChunks,
  shouldRetrieveKbForQuery: mocks.shouldRetrieveKbForQuery,
}));

vi.mock("../memory/embedding-client.js", () => ({
  embed: mocks.embed,
  loadEmbeddingConfig: mocks.loadEmbeddingConfig,
}));

vi.mock("../memory/memory-service.js", () => ({
  addTurn: mocks.addTurn,
  search: mocks.searchMemory,
}));

vi.mock("./lock.js", () => ({
  acquireSessionLock: mocks.acquireLock,
}));

const apps: FastifyInstance[] = [];

function runResult(
  overrides: Partial<{
    text: string;
    toolCalls: number;
    stoppedByMaxIterations: boolean;
  }> = {},
) {
  return {
    text: "answer",
    toolCalls: 0,
    stoppedByMaxIterations: false,
    messages: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    ...overrides,
  };
}

function addSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const row: StoredSession = {
    id: "session-1",
    userId: "user-1",
    agentId: "agent-1",
    agentName: "会话助手",
    agentPrompt: "会话提示词",
    attachedKbIds: [],
    kbAttachAllOwn: false,
    updatedAt: new Date("2026-09-07T08:00:00.000Z"),
    ...overrides,
  };
  mocks.state.sessions.push(row);
  return row;
}

async function makeApp(userId = "user-1"): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  await app.register(chatRoutes);
  await app.ready();
  apps.push(app);
  return app;
}

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(body: string): ParsedSseEvent[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      if (!event || !data) throw new Error("invalid SSE event: " + chunk);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.user = { id: "user-1", bannedAt: null, memoryEnabled: false };
  mocks.state.sessions.length = 0;
  mocks.state.messages.length = 0;
  mocks.state.nextMessage = 1;
  mocks.config.defaultModel = "glm-5.2";
  mocks.config.modelRoutes = undefined;

  mocks.releaseLock.mockResolvedValue(undefined);
  mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
  mocks.resolveAgent.mockResolvedValue({
    agentId: "preset-1",
    agentName: "默认助手",
    agentPrompt: "默认提示词",
    agentIcon: "icon:preset-1",
  });
  mocks.resolveEffectiveKbIds.mockResolvedValue([]);
  mocks.shouldRetrieveKbForQuery.mockReturnValue(false);
  mocks.retrieveChunks.mockResolvedValue([]);
  mocks.filterRelevantChunks.mockImplementation((hits: unknown[]) => hits);
  mocks.dedupeKbCitations.mockImplementation((hits: Array<{ docName: string; ordinal: number }>) =>
    hits.map((hit) => ({ docName: hit.docName, ordinal: hit.ordinal })),
  );
  mocks.loadEmbeddingConfig.mockReturnValue({});
  mocks.embed.mockResolvedValue({ vector: [0.1, 0.2] });
  mocks.searchMemory.mockResolvedValue([]);
  mocks.addTurn.mockResolvedValue(undefined);
  mocks.runTurn.mockImplementation(async (args: RunArgsDouble) => {
    args.onText?.("answer");
    return runResult();
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("POST /api/chat request guards", () => {
  it("rejects unauthenticated requests before reading user state", async () => {
    const app = await makeApp("");
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hello" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "未登录" });
    expect(mocks.mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty turn", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not create a session for a deleted or banned user", async () => {
    const app = await makeApp();

    mocks.state.user = null;
    const missing = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hello" },
    });
    expect(missing.statusCode).toBe(401);

    mocks.state.user = {
      id: "user-1",
      bannedAt: new Date("2026-09-07T00:00:00.000Z"),
      memoryEnabled: false,
    };
    const banned = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hello" },
    });
    expect(banned.statusCode).toBe(403);
    expect(banned.json()).toEqual({ error: "账号已被封禁" });
    expect(mocks.mockPrisma.session.create).not.toHaveBeenCalled();
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("hides missing and foreign sessions behind the same 403", async () => {
    const app = await makeApp();
    addSession({ id: "foreign", userId: "user-2" });

    const foreign = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "foreign", message: "hello" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "missing", message: "hello" },
    });

    expect(foreign.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
  });

  it("returns 409 without opening SSE when the session lease is occupied", async () => {
    const app = await makeApp();
    addSession();
    mocks.acquireLock.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "hello" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "该会话正在处理中" });
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat turn lifecycle", () => {
  it("sends session first, appends the current turn after old history, and touches the session", async () => {
    const app = await makeApp();
    addSession();
    mocks.state.messages.push(
      {
        id: "old-1",
        sessionId: "session-1",
        role: "user",
        content: "old question",
        createdAt: new Date("2026-09-07T07:00:00.000Z"),
      },
      {
        id: "old-2",
        sessionId: "session-1",
        role: "assistant",
        content: "old answer",
        createdAt: new Date("2026-09-07T07:00:00.000Z"),
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "new question" },
    });
    const events = parseSse(response.body);
    const runArgs = mocks.runTurn.mock.calls[0]?.[0] as RunArgsDouble;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(events.map((event) => event.event)).toEqual(["session", "text", "done"]);
    expect(events[0]?.data).toMatchObject({
      sessionId: "session-1",
      agentId: "agent-1",
      model: "glm-5.2",
    });
    expect(runArgs.history).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ]);
    expect(mocks.mockPrisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    expect(mocks.mockPrisma.message.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mockPrisma.message.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(mocks.state.messages.filter((message) => message.role === "assistant").at(-1)).toMatchObject({
      content: "answer",
      model: "glm-5.2",
    });
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("creates a new session with the resolved agent snapshot", async () => {
    const app = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "hello", agentId: "preset-9" },
    });
    const events = parseSse(response.body);

    expect(response.statusCode).toBe(200);
    expect(mocks.resolveAgent).toHaveBeenCalledWith(mocks.mockPrisma, "user-1", "preset-9");
    expect(mocks.mockPrisma.session.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        agentId: "preset-1",
        agentName: "默认助手",
        agentPrompt: "默认提示词",
      },
    });
    expect(events[0]?.data.sessionId).toBe("session-new");
  });

  it("releases the lease and does not store an assistant message when the model fails", async () => {
    const app = await makeApp();
    addSession();
    mocks.runTurn.mockRejectedValueOnce(new mocks.EmptyResponseError());

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "hello" },
    });
    const events = parseSse(response.body);

    expect(events.map((event) => event.event)).toEqual(["session", "error"]);
    expect(events[1]?.data).toEqual({ message: "模型未返回内容，请重试" });
    expect(mocks.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(mocks.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("still closes a completed stream when Redis release reports an error", async () => {
    const app = await makeApp();
    addSession();
    mocks.releaseLock.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "hello" },
    });

    expect(parseSse(response.body).at(-1)?.event).toBe("done");
    expect(response.statusCode).toBe(200);
  });

  it("reports malformed attachment data before persisting the user turn", async () => {
    const app = await makeApp();
    addSession();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-1",
        message: "",
        attachments: [
          {
            name: "broken.txt",
            mime: "text/plain",
            sizeBytes: 1,
            kind: "file",
            dataBase64: "%%%%",
          },
        ],
      },
    });
    const events = parseSse(response.body);

    expect(events.map((event) => event.event)).toEqual(["session", "error"]);
    expect(events[1]?.data.message).toContain("Base64");
    expect(mocks.mockPrisma.message.create).not.toHaveBeenCalled();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("uses a vision fallback and sends the current image as a multimodal history entry", async () => {
    const app = await makeApp();
    addSession();
    const image = Buffer.from([7]).toString("base64");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-1",
        message: "",
        model: "glm-5.2",
        attachments: [
          {
            name: "pixel.png",
            mime: "image/png",
            sizeBytes: 1,
            kind: "image",
            dataBase64: image,
          },
        ],
      },
    });
    const events = parseSse(response.body);
    const runArgs = mocks.runTurn.mock.calls[0]?.[0] as RunArgsDouble;

    expect(events[0]?.data).toMatchObject({
      model: "qwen3.7-plus",
      requestedModel: "glm-5.2",
      fallbackReason: "image_requires_multimodal",
    });
    expect(runArgs.model).toBe("qwen3.7-plus");
    expect(runArgs.history.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "请根据附件内容回答。" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: image },
        },
      ],
    });
  });
});

describe("POST /api/chat context and persistence", () => {
  it("persists only permission-filtered knowledge IDs and emits citations", async () => {
    const app = await makeApp();
    addSession();
    const hits = [
      {
        content: "approved reference",
        docName: "handbook.pdf",
        ordinal: 3,
        score: 0.9,
      },
    ];
    mocks.resolveEffectiveKbIds.mockResolvedValueOnce(["kb-owned"]);
    mocks.shouldRetrieveKbForQuery.mockReturnValueOnce(true);
    mocks.retrieveChunks.mockResolvedValueOnce(hits);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-1",
        message: "use the handbook",
        kbIds: ["kb-owned", "kb-foreign"],
      },
    });
    const events = parseSse(response.body);
    const runArgs = mocks.runTurn.mock.calls[0]?.[0] as RunArgsDouble;

    expect(mocks.resolveEffectiveKbIds).toHaveBeenCalledWith(mocks.mockPrisma, "user-1", {
      attachedKbIds: ["kb-owned", "kb-foreign"],
      kbAttachAllOwn: false,
    });
    expect(mocks.retrieveChunks).toHaveBeenCalledWith(mocks.mockPrisma, ["kb-owned"], [0.1, 0.2], 8);
    expect(mocks.mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: {
        updatedAt: expect.any(Date),
        attachedKbIds: ["kb-owned"],
        kbAttachAllOwn: false,
      },
    });
    expect(runArgs.system).toContain("参考资料：");
    expect(runArgs.system).toContain("handbook.pdf#3: approved reference");
    expect(events.find((event) => event.event === "citation")?.data).toEqual({
      memories: [],
      kb: [{ docName: "handbook.pdf", ordinal: 3 }],
    });
  });

  it("reuses a session knowledge selection when the request omits it", async () => {
    const app = await makeApp();
    addSession({ attachedKbIds: ["kb-stored"], kbAttachAllOwn: true });
    mocks.resolveEffectiveKbIds.mockResolvedValueOnce(["kb-stored", "kb-new-own"]);
    mocks.shouldRetrieveKbForQuery.mockReturnValueOnce(true);

    await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "search again" },
    });

    expect(mocks.resolveEffectiveKbIds).toHaveBeenCalledWith(mocks.mockPrisma, "user-1", {
      attachedKbIds: ["kb-stored"],
      kbAttachAllOwn: true,
    });
    expect(mocks.retrieveChunks).toHaveBeenCalledWith(mocks.mockPrisma, ["kb-stored", "kb-new-own"], [0.1, 0.2], 8);
    expect(mocks.mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("does not overwrite a saved selection when permission resolution fails", async () => {
    const app = await makeApp();
    addSession({ attachedKbIds: ["kb-stored"] });
    mocks.resolveEffectiveKbIds.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        sessionId: "session-1",
        message: "hello",
        kbIds: ["kb-unverified"],
      },
    });

    expect(parseSse(response.body).at(-1)?.event).toBe("done");
    expect(mocks.mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(mocks.state.sessions[0]?.attachedKbIds).toEqual(["kb-stored"]);
    expect(mocks.retrieveChunks).not.toHaveBeenCalled();
  });

  it("injects memory once and stores the finalized answer for extraction", async () => {
    mocks.state.user = { id: "user-1", bannedAt: null, memoryEnabled: true };
    mocks.searchMemory.mockResolvedValueOnce([{ id: "memory-1", text: "用户偏好简短回答", score: 0.8 }]);
    const app = await makeApp();
    addSession();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "hello" },
    });
    const runArgs = mocks.runTurn.mock.calls[0]?.[0] as RunArgsDouble;

    expect(runArgs.system).toContain("相关记忆：\n- 用户偏好简短回答");
    expect(parseSse(response.body).find((event) => event.event === "citation")?.data).toEqual({
      memories: ["memory-1"],
      kb: [],
    });
    await vi.waitFor(() => {
      expect(mocks.addTurn).toHaveBeenCalledWith({}, mocks.client, "glm-5.2", "user-1", "hello", "answer", {
        sessionId: "session-1",
      });
    });
  });

  it("keeps streamed text and the stored fallback aligned at the tool limit", async () => {
    const app = await makeApp();
    addSession();
    mocks.runTurn.mockImplementationOnce(async (args: RunArgsDouble) => {
      args.onText?.("partial answer");
      return runResult({
        text: "partial answer",
        toolCalls: 256,
        stoppedByMaxIterations: true,
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId: "session-1", message: "work" },
    });
    const events = parseSse(response.body);
    const visibleText = events
      .filter((event) => event.event === "text")
      .map((event) => String(event.data.text))
      .join("");
    const stored = mocks.state.messages.find((message) => message.role === "assistant");

    expect(events.some((event) => event.event === "reset")).toBe(false);
    expect(visibleText).toContain("partial answer");
    expect(visibleText).toContain("达到单轮上限");
    expect(stored?.content).toBe(visibleText);
  });
});
