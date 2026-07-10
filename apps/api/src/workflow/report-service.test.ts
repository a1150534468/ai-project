import { describe, it, expect, vi } from "vitest";
import {
  truncateToTokenBudget,
  estimateInputTokens,
  buildSystemPrompt,
  generateReportBody,
  splitIntoSheets,
  planChunks,
  generateReportSection,
  buildDigest,
  buildOverviewSystemPrompt,
  generateReportOverview,
} from "./report-service.js";

function fakeMessage(text: string, stop: string) {
  return { content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20 } };
}

describe("truncateToTokenBudget", () => {
  it("未超预算原样返回", () => {
    const r = truncateToTokenBudget("abc", 64000);
    expect(r).toEqual({ text: "abc", truncated: false });
  });
  it("超预算按 tokens*3 字符截断并标记", () => {
    const long = "a".repeat(10);
    const r = truncateToTokenBudget(long, 2); // 预算 6 字符
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(6);
  });
});

describe("buildSystemPrompt", () => {
  it("含动效与 body-only 约束，intent 存在时并入", () => {
    const p = buildSystemPrompt("给老板看的季度总结");
    expect(p).toContain("gsap");
    expect(p).toContain("给老板看的季度总结");
    expect(p.toLowerCase()).toContain("body");
    // 必须禁用 ScrollTrigger（未内联）并强调内容默认可见，防止整页空白
    expect(p).toContain("ScrollTrigger");
    expect(p).toContain("默认可见");
    expect(p).toContain("reveal");
    // 核心：优先图表、尽量少表格
    expect(p).toContain("尽量少用表格");
    expect(p).toContain("KPI");
  });
});

describe("buildSystemPrompt exhaustive", () => {
  it("exhaustive=true 时并入全面详尽穷尽指令，但强调用图表承载而非堆表格", () => {
    const p = buildSystemPrompt("", true);
    expect(p).toContain("全面详尽");
    expect(p).toContain("图表来承载");
    expect(p).not.toContain("用表格逐行列出"); // 旧的堆表格指令必须已移除
    expect(buildSystemPrompt("", false)).not.toContain("全面详尽");
  });
});

describe("splitIntoSheets", () => {
  it("按 # 表名 头切分多分表", () => {
    const r = splitIntoSheets("# 表A\na\tb\n# 表B\nc\td");
    expect(r).toEqual([
      { title: "表A", body: "a\tb" },
      { title: "表B", body: "c\td" },
    ]);
  });
  it("无表头(纯文本)返回单一单元", () => {
    const r = splitIntoSheets("一段没有表头的长文本");
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe("内容");
    expect(r[0].body).toBe("一段没有表头的长文本");
  });
});

describe("planChunks", () => {
  it("多个小分表按预算打包进尽量少的块", () => {
    const units = [
      { title: "A", body: "x".repeat(30) },
      { title: "B", body: "y".repeat(30) },
    ];
    // 预算 100 字符(约 33 token) 足以容纳两表
    const chunks = planChunks(units, 34);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("A、B");
    expect(chunks[0].text).toContain("# A");
    expect(chunks[0].text).toContain("# B");
  });
  it("超预算时拆到多块", () => {
    const units = [
      { title: "A", body: "x".repeat(60) },
      { title: "B", body: "y".repeat(60) },
    ];
    const chunks = planChunks(units, 30); // 90 字符预算，一块放不下两表
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
  it("单个分表超预算按行再切成多部分", () => {
    const bigBody = Array.from({ length: 20 }, (_, i) => `row${i}`).join("\n");
    const units = [{ title: "巨表", body: bigBody }];
    const chunks = planChunks(units, 10); // 30 字符预算，单表远超
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].title).toContain("巨表");
    expect(chunks[0].title).toContain("/");
  });
});

describe("buildDigest / overview", () => {
  it("buildDigest 每表只取前若干行做摘要", () => {
    const bigBody = Array.from({ length: 100 }, (_, i) => `row${i}`).join("\n");
    const d = buildDigest([{ title: "表A", body: bigBody }]);
    expect(d).toContain("# 表A");
    expect(d).toContain("row0");
    expect(d).not.toContain("row50"); // 只取前 14 行，第 50 行不应出现
  });
  it("buildOverviewSystemPrompt 要求做精美总览封面(总标题+KPI+图表)", () => {
    const p = buildOverviewSystemPrompt();
    expect(p).toContain("总览");
    expect(p).toContain("KPI");
    expect(p).toContain("总标题");
  });
  it("generateReportOverview operationId 前缀含 overview", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("<h1>总览</h1>", "end_turn"));
    const reserve = vi.fn().mockResolvedValue(undefined);
    const out = await generateReportOverview({
      digest: "# 表A\n数据", model: "MiniMax-M3", userId: "u1", maxOutputTokens: 4096, taskId: "t1",
      llm: { messages: { create } } as any,
      billing: { reserve, settle: vi.fn().mockResolvedValue(undefined) } as any,
    });
    expect(out.body).toContain("总览");
    expect(reserve.mock.calls[0][0].operationId).toContain("overview");
  });
});

describe("generateReportSection", () => {
  it("生成一段并计费，section prompt 含分表标题", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("<h2>表A</h2><p>x</p>", "end_turn"));
    const reserve = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn().mockResolvedValue(undefined);
    const out = await generateReportSection({
      title: "表A", text: "# 表A\n数据", index: 1, total: 3,
      model: "MiniMax-M3", userId: "u1", maxOutputTokens: 4096, taskId: "t1",
      llm: { messages: { create } } as any,
      billing: { reserve, settle } as any,
    });
    expect(out.body).toContain("<h2>表A</h2>");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    // 分段的 operationId 前缀含 sec，避免与其它段/主报告撞
    expect(reserve.mock.calls[0][0].operationId).toContain("sec1");
  });
});

describe("generateReportBody", () => {
  it("stop_reason=max_tokens 触发续写，直到 end_turn 或达上限，拼接结果并每轮计费", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(fakeMessage("<h1>A</h1>", "max_tokens"))
      .mockResolvedValueOnce(fakeMessage("<p>B</p>", "end_turn"));
    const reserve = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn().mockResolvedValue(undefined);
    const out = await generateReportBody({
      text: "数据", intent: "", model: "MiniMax-M3", userId: "u1",
      maxOutputTokens: 4096, taskId: "t1",
      llm: { messages: { create } } as any,
      billing: { reserve, settle } as any,
    });
    expect(out.body).toBe("<h1>A</h1><p>B</p>");
    expect(out.rounds).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(out.outputTokens).toBe(40);
  });

  it("最多 10 轮，一直 max_tokens 也停在 10", async () => {
    const create = vi.fn().mockResolvedValue(fakeMessage("x", "max_tokens"));
    const out = await generateReportBody({
      text: "数据", intent: "", model: "MiniMax-M3", userId: "u1",
      maxOutputTokens: 4096, taskId: "t1",
      llm: { messages: { create } } as any,
      billing: { reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) } as any,
    });
    expect(out.rounds).toBe(10);
    expect(create).toHaveBeenCalledTimes(10);
  });

  it("LLM 抛错时兜底 settle(0) 并抛出", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const settle = vi.fn().mockResolvedValue(undefined);
    await expect(generateReportBody({
      text: "数据", intent: "", model: "MiniMax-M3", userId: "u1",
      maxOutputTokens: 4096, taskId: "t1",
      llm: { messages: { create } } as any,
      billing: { reserve: vi.fn().mockResolvedValue(undefined), settle } as any,
    })).rejects.toThrow("boom");
    expect(settle).toHaveBeenCalled();
  });
});
