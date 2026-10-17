/**
 * 上传路由回归测试：blocker 级修复的覆盖。
 * 1. multipart 字段必须从 parts 流解析（未开 attachFieldsToBody 时 req.body 不可用）。
 * 2. 重复提交（requestId 撞唯一约束）不得删除原任务的音频文件。
 */
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(),
}));

vi.mock("../../storage/s3-objects.js", () => ({
  deleteObject: mocks.deleteObject,
  putObject: vi.fn(),
  getObject: vi.fn(),
}));

import { registerTranscriptionTaskRoutes } from "./transcription-task-routes.js";
import type { TranscriptionRouteContext } from "./transcription-route-context.js";

const BOUNDARY = "test-boundary-12345";

function multipartPayload(options: {
  fields?: Record<string, string>;
  fileFirst?: boolean;
  filename?: string;
  fileContent?: Buffer;
}): Buffer {
  const { fields = {}, fileFirst = false, filename = "test.mp3", fileContent = Buffer.from("fake-audio-bytes") } = options;
  const chunks: Buffer[] = [];
  const pushField = (name: string, value: string): void => {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const pushFile = (): void => {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
    );
    chunks.push(fileContent);
    chunks.push(Buffer.from("\r\n"));
  };
  if (fileFirst) {
    pushFile();
    for (const [name, value] of Object.entries(fields)) pushField(name, value);
  } else {
    for (const [name, value] of Object.entries(fields)) pushField(name, value);
    pushFile();
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

async function makeApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    req.userId = "user-1";
  });
  // 注意：刻意不开 attachFieldsToBody，复现生产配置（server-foundation.ts）
  await app.register(multipart);
  const context: TranscriptionRouteContext = {
    app,
    prisma: { transcriptionTask: { create: mocks.create } } as never,
    fetchFn: fetch,
    s3: {} as never,
    loadRunnerConfig: () => { throw new Error("not needed"); },
    maxBytes: 200 * 1024 * 1024,
    staleTaskMs: 60_000,
    storeAudio: vi.fn().mockResolvedValue(undefined),
    startTask: vi.fn(),
    resumeStale: vi.fn().mockResolvedValue(0),
  };
  registerTranscriptionTaskRoutes(context);
  await app.ready();
  return { app, context };
}

const FIELDS = { requestId: "cuid-request-id-1", language: "zh-CN" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "task-1",
    ...args.data,
    status: "queued",
    createdAt: new Date("2026-10-17T00:00:00Z"),
    updatedAt: new Date("2026-10-17T00:00:00Z"),
  }));
});

describe("POST /api/workflow/transcription/tasks", () => {
  it("字段在文件之前：正常上传成功", async () => {
    const { app, context } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/transcription/tasks",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartPayload({ fields: FIELDS }),
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const created = mocks.create.mock.calls[0][0].data;
    expect(created.requestId).toBe("cuid-request-id-1");
    expect(created.language).toBe("zh-CN");
    expect((context.startTask as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("字段在文件之后：也能正确解析（顺序无关）", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/transcription/tasks",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartPayload({ fields: FIELDS, fileFirst: true }),
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(mocks.create.mock.calls[0][0].data.requestId).toBe("cuid-request-id-1");
  });

  it("缺字段时返回 400", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workflow/transcription/tasks",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartPayload({ fields: { language: "zh-CN" } }),
    });
    await app.close();
    expect(response.statusCode).toBe(400);
  });

  it("重复 requestId：返回 409，且不删除原任务音频", async () => {
    const { app, context } = await makeApp();
    const storeAudio = context.storeAudio as ReturnType<typeof vi.fn>;
    // 第一次成功
    const first = await app.inject({
      method: "POST",
      url: "/api/workflow/transcription/tasks",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartPayload({ fields: FIELDS }),
    });
    expect(first.statusCode).toBe(200);
    const firstKey = storeAudio.mock.calls[0][0] as string;
    // 第二次撞唯一约束
    mocks.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const second = await app.inject({
      method: "POST",
      url: "/api/workflow/transcription/tasks",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartPayload({ fields: FIELDS }),
    });
    await app.close();
    expect(second.statusCode).toBe(409);
    // 两次上传的 key 必须不同，且 deleteObject 删的是第二次的孤儿文件，不是第一次的
    const secondKey = storeAudio.mock.calls[1][0] as string;
    expect(secondKey).not.toBe(firstKey);
    expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObject.mock.calls[0][1]).toBe(secondKey);
  });
});
