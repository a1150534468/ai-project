import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { fanoutRoutes } from "./fanout-routes.js";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = { product: "AI助手", audience: "白领", sellingPoints: ["效率"], style: "口语", scene: "汇报" };

function build(deps: Parameters<typeof fanoutRoutes>[1]) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as { userId?: string }).userId = "u1"; });
  app.register((a) => fanoutRoutes(a, deps));
  return app;
}

describe("fanout routes", () => {
  it("POST /extract 返回 brief", async () => {
    const app = build({ extract: vi.fn().mockResolvedValue(brief) });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/extract", payload: { raw: "我们的AI助手一键生成PPT" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.brief.product).toBe("AI助手");
  });

  it("POST /extract 空原文返回 400", async () => {
    const app = build({ extract: vi.fn() });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/extract", payload: { raw: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /generate enum 缺 dimension 返回 400", async () => {
    const app = build({ generate: vi.fn() });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "enum", brief, count: 10 } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /generate 返回变体", async () => {
    const generate = vi.fn().mockResolvedValue({ variants: [{ id: "1", text: "a", label: "小红书", charCount: 1, similarity: 0, highSimilarity: false }], requested: 10, delivered: 1, avgSimilarity: 0, partialFailure: false, stoppedByBalance: false });
    const app = build({ generate });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "enum", dimension: "platform", brief, count: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.variants).toHaveLength(1);
  });

  it("POST /generate 允许较多卖点（防御：extract 可能返回多条含标点卖点）", async () => {
    const generate = vi.fn().mockResolvedValue({ variants: [], requested: 10, delivered: 0, avgSimilarity: 0, partialFailure: false, stoppedByBalance: false });
    const app = build({ generate });
    const manyPoints = Array.from({ length: 15 }, (_, i) => `卖点${i}：一句话说明，含中文逗号也不应被拒`);
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "enum", dimension: "platform", brief: { ...brief, sellingPoints: manyPoints }, count: 10 } });
    expect(res.statusCode).toBe(200);
  });

  it("POST /generate 接受自定义条数（非预设档，如 7）", async () => {
    const generate = vi.fn().mockResolvedValue({ variants: [], requested: 7, delivered: 0, avgSimilarity: 0, partialFailure: false, stoppedByBalance: false });
    const app = build({ generate });
    const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "matrix", brief, count: 7 } });
    expect(res.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ count: 7 }));
  });

  it("POST /generate 条数越界(0/101/小数)返回 400", async () => {
    const app = build({ generate: vi.fn() });
    for (const count of [0, 101, 3.5]) {
      const res = await app.inject({ method: "POST", url: "/api/workflow/fanout/generate", payload: { mode: "matrix", brief, count } });
      expect(res.statusCode).toBe(400);
    }
  });
});
