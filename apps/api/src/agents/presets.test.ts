import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESET_AGENT_ICONS } from "./icons.js";
import { loadAgentPresets, parseAgentPresets } from "./presets.js";

/** 造一段符合 presets.md 约定的 markdown。围栏用拼接写，免得和这个文件自己的代码块打架。 */
function section(no: number, name: string, prompt: string, extra = ""): string {
  return ["", `## ${no}. ${name}`, "", "```text", prompt, "```", extra].join("\n");
}

describe("parseAgentPresets", () => {
  it("标题给 id 和名字，围栏里的内容整段当提示词", () => {
    const presets = parseAgentPresets(section(1, "默认助手", "你是「默认助手」。") + section(2, "产品经理", "你是「产品经理」。"));

    expect(presets).toHaveLength(2);
    expect(presets[0]).toMatchObject({ id: "preset-1", name: "默认助手", prompt: "你是「默认助手」。" });
    expect(presets[1]).toMatchObject({ id: "preset-2", name: "产品经理", prompt: "你是「产品经理」。" });
  });

  // 一节里可以放示例代码块，约定是「第一个 text 围栏才是提示词」
  it("一节里只认第一个 text 围栏", () => {
    const presets = parseAgentPresets(section(1, "默认助手", "真正的提示词", "\n```text\n示例，不该被当成提示词\n```\n"));

    expect(presets[0].prompt).toBe("真正的提示词");
  });

  // 围栏写坏（比如少一个结尾）就会走到这条路上，所以下面「内置文件」那组用例必须把数量钉死
  it("没有 text 围栏的节直接跳过，不占位", () => {
    const presets = parseAgentPresets(`\n## 1. 没写提示词\n\n正文而已。\n${section(2, "产品经理", "你是「产品经理」。")}`);

    expect(presets.map((preset) => preset.id)).toEqual(["preset-2"]);
  });

  it("id 跟着标题编号走，不是跟着顺序走", () => {
    const presets = parseAgentPresets(section(7, "产品运营", "你是「产品运营」。"));

    expect(presets[0].id).toBe("preset-7");
  });

  it("简介优先取「主要负责：」那一句", () => {
    const presets = parseAgentPresets(section(1, "甲", "你是「甲」。\n主要负责：把需求写清楚。\n你适合处理以下任务：写文档。"));

    expect(presets[0].description).toBe("把需求写清楚");
  });

  it("没有职责句才退到「适合处理以下任务：」", () => {
    const presets = parseAgentPresets(section(1, "乙", "你是「乙」。\n你适合处理以下任务：写文档、改稿子。"));

    expect(presets[0].description).toBe("写文档、改稿子");
  });

  it("两句都没写就叫通用智能体，但仍然出现在列表里", () => {
    const presets = parseAgentPresets(section(1, "丙", "你是「丙」。什么都不说。"));

    expect(presets[0].description).toBe("通用智能体");
  });
});

describe("内置的 presets.md", () => {
  const presets = loadAgentPresets();
  const markdown = readFileSync(fileURLToPath(new URL("./presets.md", import.meta.url)), "utf8");
  const headings = markdown.match(/^##\s+\d+\.\s+.+$/gm) ?? [];

  // 数量必须相等：少一个就说明有 Agent 的围栏写坏了，而那种事故本身是静默的
  it("每个标题都解析出了一个 Agent，一个都没漏", () => {
    expect(headings.length).toBeGreaterThan(0);
    expect(presets).toHaveLength(headings.length);
  });

  it("第一个是默认助手（preset-1 是全站的默认 Agent）", () => {
    expect(presets[0]).toMatchObject({ id: "preset-1", name: "默认助手" });
  });

  // icons.ts 靠下标和 presets.md 对齐，没有任何运行时校验，只能靠这条用例守
  it("图标数量和 Agent 数量一致，且逐位对齐", () => {
    expect(PRESET_AGENT_ICONS).toHaveLength(presets.length);
    expect(presets.map((preset) => preset.icon)).toEqual([...PRESET_AGENT_ICONS]);
  });

  it("没有两个 Agent 共用一个图标", () => {
    expect(new Set(PRESET_AGENT_ICONS).size).toBe(PRESET_AGENT_ICONS.length);
  });

  // 落到兜底文案说明那份提示词没按约定写职责句，列表上会显示成一句没用的话
  it("没有一个 Agent 落到「通用智能体」兜底简介", () => {
    expect(presets.filter((preset) => preset.description === "通用智能体")).toEqual([]);
  });

  it("每个 Agent 都有名字、提示词和图标", () => {
    for (const preset of presets) {
      expect(preset.name).not.toBe("");
      expect(preset.prompt.length).toBeGreaterThan(50);
      expect(preset.icon).toMatch(/^mdi:/);
    }
  });
});
