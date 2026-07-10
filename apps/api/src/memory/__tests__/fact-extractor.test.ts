import { describe, it, expect, vi } from "vitest";
import { extractMemoryActions, extractFacts } from "../fact-extractor.js";

function fakeClient(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text }],
      })),
    },
  } as never;
}

describe("fact-extractor", () => {
  it("解析结构化记忆动作", async () => {
    const actions = await extractMemoryActions(
      fakeClient(
        '[{"event":"ADD","title":"OpenClaw","text":"用户正在做 OpenClaw 项目","type":"CORE","importance":90,"tags":["项目"]}]',
      ),
      "m",
      "我在做 OpenClaw",
      "好的",
      [],
    );
    expect(actions).toEqual([
      {
        event: "ADD",
        title: "OpenClaw",
        text: "用户正在做 OpenClaw 项目",
        type: "CORE",
        importance: 90,
        tags: ["项目"],
      },
    ]);
  });

  it("兼容旧字符串数组为 ADD 动作", async () => {
    const facts = await extractFacts(
      fakeClient('["用户喜欢 TS"]'),
      "m",
      "我喜欢 TS",
      "好的",
    );
    expect(facts).toEqual(["用户喜欢 TS"]);
  });

  it("extractFacts 只保留 ADD 文本", async () => {
    const facts = await extractFacts(
      fakeClient(
        '[{"event":"ADD","text":"用户在维护 OpenClaw"},{"event":"UPDATE","id":"m1","text":"用户在维护 Memory Galaxy"},{"event":"DELETE","id":"m2"},{"event":"NONE"}]',
      ),
      "m",
      "我在维护 OpenClaw",
      "好的",
    );
    expect(facts).toEqual(["用户在维护 OpenClaw"]);
  });

  it("忽略非法 type 但保留有效 ADD 动作", async () => {
    const actions = await extractMemoryActions(
      fakeClient(
        '[{"event":"ADD","text":"用户在维护记忆系统","type":"INVALID","importance":70}]',
      ),
      "m",
      "我在维护记忆系统",
      "好的",
      [],
    );
    expect(actions).toEqual([
      {
        event: "ADD",
        text: "用户在维护记忆系统",
        importance: 70,
      },
    ]);
  });

  it("非 JSON 返回空数组", async () => {
    await expect(
      extractMemoryActions(fakeClient("抱歉"), "m", "x", "y", []),
    ).resolves.toEqual([]);
  });
});
