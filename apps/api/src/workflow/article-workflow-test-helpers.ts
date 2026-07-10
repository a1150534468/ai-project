import Fastify from "fastify";
import { vi } from "vitest";
import type { ArticleWorkflowImageAsset } from "@yc/article-workflow";
import { articleWorkflowRoutes } from "./article-workflow-routes.js";

export type ProjectRow = {
  id: string;
  userId: string;
  sourceFormat: string;
  sourceText: string;
  generationMode: string;
  title: string;
  summary: string;
  bodyHtml: string;
  imageManifestJson: unknown;
  status: string;
  progressStage: string;
  progressPercent: number;
  progressMessage: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ImageAssetRow = {
  id: string;
  userId: string;
  requestId: string;
  requestIndex: number;
  prompt: string;
  model: string;
  size: string;
  originalUrl: string;
  thumbnailUrl: string;
  objectKey: string | null;
  mime: string;
  createdAt: Date;
};

export function buildArticleWorkflowPlan() {
  return {
    title: "咖啡机夏促",
    summary: "适合公众号摘要",
    bodyMarkdown: [
      "开头第一段。",
      "",
      "第二段继续说明。",
    ].join("\n"),
    images: [
      { slot: "cover" as const, role: "cover" as const, alt: "头图", caption: "", prompt: "cover prompt" },
      { slot: "inline-1" as const, role: "inline" as const, alt: "细节图", caption: "", prompt: "detail prompt" },
    ],
  };
}

export function buildArticleWorkflowHtml(): string {
  return [
    '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
    '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
    '<section data-yc-image-slot="cover"></section>',
    '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段继续说明。</p>',
    '<section data-yc-image-slot="inline-1"></section>',
    "</section>",
  ].join("");
}

export function buildArticleWorkflowImageManifest(): readonly ArticleWorkflowImageAsset[] {
  return [
    {
      slot: "cover",
      role: "cover",
      assetId: "asset-1",
      imageUrl: "https://example.test/cover.png",
      thumbnailUrl: "https://example.test/cover-thumb.png",
      alt: "头图",
      caption: "",
      prompt: "cover prompt",
    },
    {
      slot: "inline-1",
      role: "inline",
      assetId: "asset-2",
      imageUrl: "https://example.test/inline.png",
      thumbnailUrl: "https://example.test/inline-thumb.png",
      alt: "细节图",
      caption: "",
      prompt: "detail prompt",
    },
  ];
}

export function createArticleWorkflowPrismaMock(seed?: {
  projects?: ProjectRow[];
  imageAssets?: ImageAssetRow[];
}) {
  const projects = [...(seed?.projects ?? [])];
  const imageAssets = [...(seed?.imageAssets ?? [])];
  const now = new Date("2026-07-08T06:00:00.000Z");
  return {
    articleWorkflowProject: {
      create: vi.fn(async ({ data }: { data: Omit<ProjectRow, "id" | "createdAt" | "updatedAt"> }) => {
        const row: ProjectRow = { ...data, id: `article-${projects.length + 1}`, createdAt: now, updatedAt: now };
        projects.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, take }: { where?: { userId?: string }; take?: number }) =>
        projects
          .filter((row) => !where?.userId || row.userId === where.userId)
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
          .slice(0, take ?? projects.length)),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
        projects.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) throw new Error("project not found");
        Object.assign(row, data, { updatedAt: new Date("2026-07-08T06:01:00.000Z") });
        return row;
      }),
    },
    imageAsset: {
      create: vi.fn(async ({ data }: { data: Omit<ImageAssetRow, "id" | "createdAt"> }) => {
        const row: ImageAssetRow = {
          ...data,
          id: `asset-${imageAssets.length + 1}`,
          createdAt: new Date("2026-07-08T06:02:00.000Z"),
        };
        imageAssets.push(row);
        return row;
      }),
    },
    __state: { projects, imageAssets },
  };
}

function createLlmResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 120, output_tokens: 480 },
  };
}

export async function buildArticleWorkflowApp(args?: {
  prisma?: ReturnType<typeof createArticleWorkflowPrismaMock>;
  llmResponses?: unknown[];
  scheduleTask?: (work: () => Promise<void>) => void;
  fetchFn?: typeof fetch;
  priceRows?: readonly {
    resourceKey: string;
    displayName: string;
    pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
    rate: number;
    perUnits: number;
    enabled: boolean;
  }[];
}) {
  const prisma = args?.prisma ?? createArticleWorkflowPrismaMock();
  const llmResponses = [...(args?.llmResponses ?? [
    createLlmResponse(JSON.stringify(buildArticleWorkflowPlan())),
    createLlmResponse(buildArticleWorkflowHtml()),
  ])];
  const billing = {
    reserveResource: vi.fn(async () => ({ reserved: 1 })),
    settleResource: vi.fn(async () => ({ settled: 1 })),
    chargeResource: vi.fn(async () => ({ charged: 1 })),
    refundResource: vi.fn(async () => ({ success: true })),
    listResourcePrices: vi.fn(async () => ({ data: [...(args?.priceRows ?? [])] })),
  };
  const llm = {
    messages: {
      create: vi.fn(async () => {
        const next = llmResponses.shift();
        if (next) return next;
        throw new Error("llm response missing");
      }),
    },
  };
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as { userId?: string }).userId = "u1";
  });
  await app.register((instance) => articleWorkflowRoutes(instance, {
    prisma: prisma as never,
    billing: billing as never,
    llm: llm as never,
    fetchFn: args?.fetchFn ?? (vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("png").toString("base64"), mime_type: "image/png" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch),
    scheduleTask: args?.scheduleTask,
    env: {
      IMAGE_API_KEY: "image-key",
      IMAGE_BASE_URL: "https://image.test",
      LLM_DEFAULT_MODEL: "MiniMax-M3",
    },
  }));
  return { app, prisma, billing, llm };
}
