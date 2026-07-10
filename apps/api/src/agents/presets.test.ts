import { describe, it, expect } from "vitest";
import { loadAgentPresets, parseAgentPresets } from "./presets.js";

describe("agent presets parser", () => {
  it("parses heading name and fenced prompt", () => {
    const presets = parseAgentPresets(`
## 1. 默认助手

\`\`\`text
# 默认助手｜预制 System Prompt

你现在扮演「默认助手」。
\`\`\`

## 2. 产品经理

\`\`\`text
# 产品经理｜预制 System Prompt

你现在扮演「产品经理」。
\`\`\`
`);

    expect(presets).toHaveLength(2);
    expect(presets[0]).toMatchObject({ id: "preset-1", name: "默认助手", icon: expect.any(String) });
    expect(presets[0].prompt).toContain("你现在扮演");
    expect(presets[1]).toMatchObject({ id: "preset-2", name: "产品经理", icon: expect.any(String) });
  });

  it("loads all bundled presets", () => {
    const presets = loadAgentPresets();
    expect(presets.length).toBeGreaterThanOrEqual(80);
    expect(presets[0].name).toBe("默认助手");
    expect(new Set(presets.slice(0, 20).map((preset) => preset.icon)).size).toBe(20);
    expect(presets.some((preset) => preset.name === "前端工程师")).toBe(true);
  });
});
