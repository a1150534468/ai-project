import Fastify from "fastify";
import { vi } from "vitest";
import type { ArticleWorkflowImageAsset } from "@ai-assistant/article-workflow";
import { articleWorkflowRoutes } from "./article-workflow-routes.js";

export type ProjectRow = {
  id: string;
  userId: string;
  creationMode: string;
  creationConfigJson: unknown;
  sourceFormat: string;
  sourceText: string;
  generationMode: string;
  platform: string;
  batchId: string | null;
  theme: string;
  themeColor: string | null;
  title: string;
  summary: string;
  bodyHtml: string;
  bodyMarkdown: string;
  captionText: string;
  tagsJson: unknown;
  imageManifestJson: unknown;
  status: string;
  progressStage: string;
  progressPercent: number;
  progressMessage: string | null;
  error: string | null;
  billingOperationId?: string | null;
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

export function buildArticleWorkflowCaptionPlan() {
  return {
    title: "夏天必囤的咖啡机",
    captionText: "第一次用就回不去了。\n\n出杯快，清洗也简单。",
    tags: ["#咖啡机", "居家好物", "夏日饮品"],
    images: [
      { slot: "cover" as const, role: "cover" as const, alt: "封面", caption: "", prompt: "cover prompt" },
      { slot: "inline-1" as const, role: "inline" as const, alt: "细节", caption: "", prompt: "detail prompt" },
    ],
  };
}

export function buildArticleWorkflowHtml(): string {
  return [
    '<section style="width:100%;max-width:667px;margin:0 auto;box-sizing:border-box;">',
    '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">开头第一段。</p>',
    '<section data-ai-assistant-image-slot="cover"></section>',
    '<p style="font-size:16px;line-height:1.8em;margin:0 0 16px 0;">第二段继续说明。</p>',
    '<section data-ai-assistant-image-slot="inline-1"></section>',
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

/** Prisma 的 undefined 表示「不改这一列」，桩要保持同样语义，否则稀疏写会把别的列擦成 undefined */
function assignDefined(row: ProjectRow, data: Partial<ProjectRow>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) (row as Record<string, unknown>)[key] = value;
  }
}

/** 列默认值的唯一来源，对齐 schema.prisma；create 与 seed 都过它。 */
const PROJECT_ROW_DEFAULTS = {
  creationMode: "source",
  creationConfigJson: { mode: "source", generateImages: true } as unknown,
  generationMode: "preserve-text",
  platform: "wechat",
  batchId: null,
  theme: "auto",
  themeColor: null,
  title: "",
  summary: "",
  bodyHtml: "",
  bodyMarkdown: "",
  captionText: "",
  tagsJson: [] as unknown,
  imageManifestJson: [] as unknown,
  status: "draft",
  progressStage: "draft",
  progressPercent: 0,
  progressMessage: null,
  error: null,
} satisfies Partial<ProjectRow>;

export type ArticleProjectRowSeed =
  Partial<ProjectRow> & Pick<ProjectRow, "id" | "userId" | "sourceFormat" | "sourceText" | "createdAt" | "updatedAt">;

export function articleProjectRow(seed: ArticleProjectRowSeed): ProjectRow {
  return { ...PROJECT_ROW_DEFAULTS, ...seed };
}

export function createArticleWorkflowPrismaMock(seed?: {
  projects?: readonly ArticleProjectRowSeed[];
  imageAssets?: ImageAssetRow[];
}) {
  const projects = (seed?.projects ?? []).map((row) => articleProjectRow(row));
  const imageAssets = [...(seed?.imageAssets ?? [])];
  const now = new Date("2026-07-08T06:00:00.000Z");
  return {
    articleWorkflowProject: {
      create: vi.fn(async ({ data }: {
        data: Partial<ProjectRow> & Pick<ProjectRow, "userId" | "sourceFormat" | "sourceText">;
      }) => {
        // 路由不传的列由库补默认，mock 也得补，否则序列化时 row.captionText.trim() 会炸。
        const row = articleProjectRow({
          ...data,
          id: `article-${projects.length + 1}`,
          createdAt: now,
          updatedAt: now,
        });
        projects.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, take, orderBy }: {
        where?: { userId?: string; batchId?: string; status?: { in: string[] }; updatedAt?: { lt?: Date } };
        take?: number;
        orderBy?: { createdAt?: "asc" | "desc"; updatedAt?: "asc" | "desc" };
      }) => {
        const rows = projects
          .filter((row) => !where?.userId || row.userId === where.userId)
          .filter((row) => where?.batchId === undefined || row.batchId === where.batchId)
          .filter((row) => !where?.status || where.status.in.includes(row.status))
          .filter((row) => !where?.updatedAt?.lt || row.updatedAt.getTime() < where.updatedAt.lt.getTime());
        const ascending = orderBy?.createdAt === "asc" || orderBy?.updatedAt === "asc";
        const key = orderBy?.createdAt ? "createdAt" : "updatedAt";
        rows.sort((left, right) => ascending
          ? left[key].getTime() - right[key].getTime()
          : right[key].getTime() - left[key].getTime());
        return rows.slice(0, take ?? rows.length);
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
        projects.find((row) => (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)) ?? null),
      deleteMany: vi.fn(async ({ where }: {
        where: { id?: string; userId?: string; batchId?: string };
      }) => {
        let count = 0;
        for (let index = projects.length - 1; index >= 0; index -= 1) {
          const row = projects[index]!;
          if (where.id && row.id !== where.id) continue;
          if (where.userId && row.userId !== where.userId) continue;
          if (where.batchId && row.batchId !== where.batchId) continue;
          projects.splice(index, 1);
          count += 1;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { id: string; status?: string | { in: string[] }; updatedAt?: { lt?: Date } };
        data: Partial<ProjectRow>;
      }) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) return { count: 0 };
        // status 既可能是精确值（reaper 的乐观锁），也可能是 { in: [...] }（终态条件写）
        if (typeof where.status === "string" && row.status !== where.status) return { count: 0 };
        if (typeof where.status === "object" && !where.status.in.includes(row.status)) return { count: 0 };
        if (where.updatedAt?.lt && row.updatedAt.getTime() >= where.updatedAt.lt.getTime()) return { count: 0 };
        assignDefined(row, data);
        row.updatedAt = new Date("2026-07-08T06:01:00.000Z");
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
        const row = projects.find((item) => item.id === where.id);
        if (!row) throw new Error("project not found");
        assignDefined(row, data);
        row.updatedAt = new Date("2026-07-08T06:01:00.000Z");
        return row;
      }),
    },
    imageAsset: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
        imageAssets.find((row) =>
          (!where.id || row.id === where.id) && (!where.userId || row.userId === where.userId)
        ) ?? null),
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

type BillingCallArgs = {
  operationId: string;
  userId: string;
  resourceKey: string;
  units: number;
};

export function createArticleWorkflowLlmResponse(text: string) {
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
  loadImageBlob?: (objectKey: string) => Promise<Buffer>;
  /** 追加到默认 env 上，用来打开依赖环境变量的分支（如配图签名要 SESSION_SECRET） */
  envPatch?: Record<string, string>;
  /** 关掉默认注入的登录态，验「不带会话」的路径 */
  anonymous?: boolean;
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
    createArticleWorkflowLlmResponse(JSON.stringify(buildArticleWorkflowPlan())),
    createArticleWorkflowLlmResponse(buildArticleWorkflowHtml()),
  ])];
  const billing = {
    reserveResource: vi.fn(async (_args: BillingCallArgs) => ({ reserved: 1 })),
    settleResource: vi.fn(async (_args: Omit<BillingCallArgs, "userId">) => ({ settled: 1 })),
    chargeResource: vi.fn(async (_args: BillingCallArgs) => ({ charged: 1 })),
    refundResource: vi.fn(async (_operationId: string) => ({ success: true })),
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
  if (!args?.anonymous) {
    app.addHook("preHandler", async (req) => {
      (req as { userId?: string }).userId = "u1";
    });
  }
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
    loadImageBlob: args?.loadImageBlob,
    env: {
      IMAGE_API_KEY: "image-key",
      IMAGE_BASE_URL: "https://image.test",
      LLM_DEFAULT_MODEL: "MiniMax-M3",
      // 系统兜底重试的退避在测试里归零：只验重试次数与终态，不真等 2s + 4s
      ARTICLE_WORKFLOW_RETRY_BASE_MS: "0",
      ...args?.envPatch,
    },
  }));
  return { app, prisma, billing, llm };
}
