import { describe, it, expect } from "vitest";
import { presetToCron, humanizeSchedule, draftToFormPatch } from "./scheduledState";

describe("scheduledState", () => {
  it("presetToCron 生成表达式", () => {
    expect(presetToCron({ kind: "daily", hour: 8, minute: 0 })).toBe("0 8 * * *");
    expect(presetToCron({ kind: "weekly", weekday: 1, hour: 9, minute: 30 })).toBe("30 9 * * 1");
  });

  it("humanizeSchedule 输出中文", () => {
    expect(humanizeSchedule("0 8 * * *")).toContain("每天");
    expect(humanizeSchedule("30 * * * *")).toContain("每小时");
    expect(humanizeSchedule("0 9 * * 1")).toContain("每周");
    expect(humanizeSchedule("15 3 5 * *")).toContain("每月");
    expect(humanizeSchedule("*/2 3 * * *")).toBe("*/2 3 * * *"); // 非预设原样返回
  });

  it("draftToFormPatch 把 AI 草稿映射成表单字段（daily 预设）", () => {
    const patch = draftToFormPatch({
      title: "每日早报", prompt: "汇总要闻", model: "claude-x",
      cron: "30 9 * * *", timezone: "Asia/Shanghai", hour: 9, minute: 30,
      oneShot: false, emailTo: "a@b.com",
    });
    expect(patch).toEqual({
      title: "每日早报", prompt: "汇总要闻", model: "claude-x", emailTo: "a@b.com",
      oneShot: false, preset: { kind: "daily", hour: 9, minute: 30 },
    });
  });

  it("draftToFormPatch 越界时分回退 0，空邮箱透传空串", () => {
    const patch = draftToFormPatch({
      title: "T", prompt: "P", model: "m", cron: "0 0 * * *",
      timezone: "Asia/Shanghai", hour: 99, minute: -5, oneShot: true, emailTo: "",
    });
    expect(patch.preset).toEqual({ kind: "daily", hour: 0, minute: 0 });
    expect(patch.emailTo).toBe("");
    expect(patch.oneShot).toBe(true);
  });
});
