import { describe, expect, it, vi } from "vitest";
import { extractFacts, extractMemoryActions } from "../fact-extractor.js";

function modelReply(text: string, stopReason: string | null = "end_turn") {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text }],
        stop_reason: stopReason,
      })),
    },
  } as never;
}

const addJson = (text: string, extras = "") =>
  `[{"event":"ADD","text":${JSON.stringify(text)}${extras}}]`;

describe("long-term memory action extraction", () => {
  it("keeps all valid fields from a structured ADD", async () => {
    const actions = await extractMemoryActions(
      modelReply(addJson("用户长期维护 Atlas", ',"title":"Atlas","type":"CORE","importance":90,"tags":["产品"]')),
      "extractor-model",
      "Atlas 会长期维护",
      "收到",
      [],
    );
    expect(actions).toEqual([{
      event: "ADD",
      title: "Atlas",
      text: "用户长期维护 Atlas",
      type: "CORE",
      importance: 90,
      tags: ["产品"],
    }]);
  });

  it("turns the legacy string-array response into ADD facts", async () => {
    const facts = await extractFacts(
      modelReply('["用户偏好 Rust"]'),
      "extractor-model",
      "以后用 Rust",
      "收到",
    );
    expect(facts).toEqual(["用户偏好 Rust"]);
  });

  it("extractFacts projects ADD entries and ignores every other action", async () => {
    const response = JSON.stringify([
      { event: "UPDATE", id: "known", text: "更新" },
      { event: "ADD", text: "用户持续开发桌面应用" },
      { event: "DELETE", id: "old" },
      { event: "NONE" },
    ]);
    await expect(
      extractFacts(modelReply(response), "extractor-model", "本轮", "收到"),
    ).resolves.toEqual(["用户持续开发桌面应用"]);
  });

  it("drops an unknown type without dropping the otherwise valid action", async () => {
    await expect(
      extractMemoryActions(
        modelReply(addJson("用户长期研究检索系统", ',"type":"UNKNOWN","importance":66')),
        "extractor-model",
        "本轮",
        "收到",
        [],
      ),
    ).resolves.toEqual([{ event: "ADD", text: "用户长期研究检索系统", importance: 66 }]);
  });

  it("finds one balanced array around prose and brackets inside strings", async () => {
    const response = `note [not-json] ${addJson("用户偏好 [TypeScript]")}`;
    await expect(
      extractMemoryActions(modelReply(response), "extractor-model", "x", "y", []),
    ).resolves.toEqual([{ event: "ADD", text: "用户偏好 [TypeScript]" }]);
  });

  it("rejects two parseable arrays because choosing either would be arbitrary", async () => {
    const diagnostic = vi.fn();
    const response = `${addJson("用户偏好简洁回答")} [{"event":"DELETE","id":"m1"}]`;
    await expect(
      extractMemoryActions(modelReply(response), "extractor-model", "x", "y", [{ id: "m1", text: "old" }], diagnostic),
    ).resolves.toEqual([]);
    expect(diagnostic).toHaveBeenCalledWith("framing");
  });

  it("allows UPDATE and DELETE only for ids included in the visible catalog", async () => {
    const response = JSON.stringify([
      { event: "UPDATE", id: "visible", text: "新版事实" },
      { event: "DELETE", id: "invented" },
    ]);
    await expect(
      extractMemoryActions(modelReply(response), "extractor-model", "x", "y", [{ id: "visible", text: "旧版事实" }]),
    ).resolves.toEqual([{ event: "UPDATE", id: "visible", text: "新版事实" }]);
  });

  it("does not apply content cut off by token limits or provider refusal", async () => {
    for (const reason of ["max_tokens", "refusal"]) {
      const diagnostic = vi.fn();
      await expect(
        extractMemoryActions(modelReply(addJson("用户偏好简洁回答"), reason), "extractor-model", "x", "y", [], diagnostic),
      ).resolves.toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith("stop");
    }
  });

  it("turns request failures into one content-free diagnostic", async () => {
    const diagnostic = vi.fn();
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error("provider body")) } } as never;
    await expect(
      extractMemoryActions(client, "extractor-model", "x", "y", [], diagnostic),
    ).resolves.toEqual([]);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("request");
  });

  it("returns no actions when the response has no JSON array", async () => {
    await expect(
      extractMemoryActions(modelReply("没有需要记录的内容"), "extractor-model", "x", "y", []),
    ).resolves.toEqual([]);
  });
});
