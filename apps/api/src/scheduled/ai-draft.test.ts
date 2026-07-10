import { describe, it, expect } from "vitest";
import { parseScheduledDraft } from "./ai-draft.js";

const MODELS = ["MiniMax-M3", "claude-x"];

describe("parseScheduledDraft", () => {
  it("合法 JSON → 结构化草稿", () => {
    const raw = JSON.stringify({
      title: "每日早报", prompt: "汇总今日要闻", model: "claude-x",
      schedule: { hour: 8, minute: 30 }, oneShot: false, emailTo: "a@b.com",
    });
    const d = parseScheduledDraft(raw, MODELS, "每天早上八点半汇总要闻发我邮箱");
    expect(d.title).toBe("每日早报");
    expect(d.prompt).toBe("汇总今日要闻");
    expect(d.model).toBe("claude-x");
    expect(d.hour).toBe(8);
    expect(d.minute).toBe(30);
    expect(d.cron).toBe("30 8 * * *");
    expect(d.timezone).toBe("Asia/Shanghai");
    expect(d.oneShot).toBe(false);
    expect(d.emailTo).toBe("a@b.com");
  });

  it("脏 JSON（前后有解释文字）→ jsonrepair 兜底解析", () => {
    const raw = '好的，这是结果：{ "title": "巡检", "schedule": { "hour": 9, "minute": 0 } } 希望有用';
    const d = parseScheduledDraft(raw, MODELS, "每天九点巡检");
    expect(d.title).toBe("巡检");
    expect(d.hour).toBe(9);
    expect(d.cron).toBe("0 9 * * *");
  });

  it("model 不在白名单 → 回退首个白名单模型", () => {
    const raw = JSON.stringify({ title: "T", model: "gpt-9-not-exist", schedule: { hour: 7, minute: 0 } });
    const d = parseScheduledDraft(raw, MODELS, "desc");
    expect(d.model).toBe("MiniMax-M3");
  });

  it("时分越界/缺失 → 回退每天 09:00", () => {
    const raw = JSON.stringify({ title: "T", schedule: { hour: 99 } });
    const d = parseScheduledDraft(raw, MODELS, "desc");
    expect(d.hour).toBe(9);
    expect(d.minute).toBe(0);
    expect(d.cron).toBe("0 9 * * *");
  });

  it("非法邮箱置空；title/prompt 缺失用描述兜底", () => {
    const raw = JSON.stringify({ emailTo: "not-an-email", schedule: { hour: 6, minute: 0 } });
    const d = parseScheduledDraft(raw, MODELS, "每天六点抓取行情数据并汇总");
    expect(d.emailTo).toBe("");
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.prompt).toBe("每天六点抓取行情数据并汇总");
  });

  it("完全无法解析（空文本）→ 返回安全默认草稿，不抛错", () => {
    const d = parseScheduledDraft("", MODELS, "随便一句话");
    expect(d.model).toBe("MiniMax-M3");
    expect(d.cron).toBe("0 9 * * *");
    expect(d.prompt).toBe("随便一句话");
  });
});
