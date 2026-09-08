import { describe, it, expect, vi } from "vitest";
import { extractMemoryActions, extractFacts } from "../fact-extractor.js";

function fakeClient(text: string, stopReason: string | null = "end_turn") {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text }],
        stop_reason: stopReason,
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

  it("平衡扫描器允许括号文字和字符串内的方括号", async () => {
    const actions = await extractMemoryActions(
      fakeClient('说明 [不是 JSON]；结果是 [{"event":"ADD","text":"用户喜欢 [TypeScript]"}]。'),
      "m",
      "x",
      "y",
      [],
    );
    expect(actions).toEqual([{ event: "ADD", text: "用户喜欢 [TypeScript]" }]);
  });

  it("两个有效数组有歧义，拒绝执行任何动作", async () => {
    const failure = vi.fn();
    const actions = await extractMemoryActions(
      fakeClient('[{"event":"ADD","text":"用户喜欢 TS"}] [{"event":"DELETE","id":"m1"}]'),
      "m",
      "x",
      "y",
      [{ id: "m1", text: "old" }],
      failure,
    );
    expect(actions).toEqual([]);
    expect(failure).toHaveBeenCalledWith("framing");
  });

  it("UPDATE / DELETE 只能引用实际展示给模型的 id", async () => {
    const actions = await extractMemoryActions(
      fakeClient('[{"event":"UPDATE","id":"m1","text":"更新"},{"event":"DELETE","id":"missing"}]'),
      "m",
      "x",
      "y",
      [{ id: "m1", text: "old" }],
    );
    expect(actions).toEqual([{ event: "UPDATE", id: "m1", text: "更新" }]);
  });

  it("截断或拒答的内容看起来像 JSON 也不执行", async () => {
    for (const reason of ["max_tokens", "refusal"]) {
      const failure = vi.fn();
      await expect(
        extractMemoryActions(
          fakeClient('[{"event":"ADD","text":"用户喜欢 TS"}]', reason),
          "m",
          "x",
          "y",
          [],
          failure,
        ),
      ).resolves.toEqual([]);
      expect(failure).toHaveBeenCalledWith("stop");
    }
  });

  it("请求失败仍降级为空，并只报一个无内容原因", async () => {
    const failure = vi.fn();
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error("secret body")) } } as never;
    await expect(extractMemoryActions(client, "m", "x", "y", [], failure)).resolves.toEqual([]);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith("request");
  });

  it("非 JSON 返回空数组", async () => {
    await expect(
      extractMemoryActions(fakeClient("抱歉"), "m", "x", "y", []),
    ).resolves.toEqual([]);
  });
});
