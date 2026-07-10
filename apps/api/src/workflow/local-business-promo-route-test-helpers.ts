import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import {
  createBillingMock as createBillingMockSupport,
  createEmptyMaterials as createEmptyMaterialsSupport,
  createPrismaMock as createPrismaMockSupport,
  seedProject as seedProjectSupport,
  type PrismaMock,
} from "./local-business-promo-route-test-support.js";

const { getObjectMock, putObjectMock } = vi.hoisted(() => ({
  getObjectMock: vi.fn(async (_s3: unknown, key: string) => Buffer.from(`blob:${key}`)),
  putObjectMock: vi.fn(async () => undefined),
}));

vi.mock("../storage/s3.js", () => ({
  loadS3Config: vi.fn(() => ({
    endpoint: "http://s3.test",
    region: "us-east-1",
    bucket: "test-bucket",
    accessKey: "key",
    secretKey: "secret",
    forcePathStyle: true,
  })),
  makeS3: vi.fn(() => ({
    client: {},
    bucket: "test-bucket",
  })),
  putObject: putObjectMock,
  getObject: getObjectMock,
}));

import { localBusinessPromoRoutes } from "./local-business-promo-routes.js";

export async function createApp(options?: {
  prisma?: PrismaMock;
  userId?: string;
  generateScript?: ReturnType<typeof vi.fn>;
  enqueueRun?: ReturnType<typeof vi.fn>;
  billing?: {
    reserve: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    chargeResource: ReturnType<typeof vi.fn>;
    refundResource: ReturnType<typeof vi.fn>;
  };
  fetchFn?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const billing = options?.billing ?? createBillingMockSupport();
  await app.register(multipart);
  app.decorateRequest("userId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { userId: string }).userId = options?.userId ?? "u1";
  });
  await app.register(localBusinessPromoRoutes, {
    prisma: (options?.prisma ?? createPrismaMockSupport()) as unknown as PrismaClient,
    fetchFn: options?.fetchFn as typeof fetch | undefined,
    generateScript: options?.generateScript,
    enqueueRun: options?.enqueueRun,
    billing: billing as never,
  });
  await app.ready();
  return { app };
}

export function createMultipartPayload(args: {
  readonly filename: string;
  readonly mime: string;
  readonly content: string;
}) {
  const boundary = "----CodexFormBoundaryAudio";
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${args.filename}"\r\n` +
    `Content-Type: ${args.mime}\r\n` +
    `\r\n` +
    args.content +
    `\r\n--${boundary}--\r\n`;
  return {
    payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function createMimoFetchMock() {
  const audioBase64 = Buffer.from("fake wav bytes").toString("base64");
  return vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { audio: { data: audioBase64 } } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

export const createBillingMock = (...args: Parameters<typeof createBillingMockSupport>) => createBillingMockSupport(...args);
export const createEmptyMaterials = (...args: Parameters<typeof createEmptyMaterialsSupport>) => createEmptyMaterialsSupport(...args);
export const createPrismaMock = (...args: Parameters<typeof createPrismaMockSupport>) => createPrismaMockSupport(...args);
export const seedProject = (...args: Parameters<typeof seedProjectSupport>) => seedProjectSupport(...args);

export { getObjectMock, putObjectMock };
