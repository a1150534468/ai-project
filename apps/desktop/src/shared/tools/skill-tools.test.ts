import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillTools, executeSkillTool, installMarketSkillTool } from "./skill-tools.js";

describe("skill tools", () => {
  it("扫描本地 skill manifest 并按 manifest 执行命令", async () => {
    const root = await mkdtemp(join(tmpdir(), "yc-skill-"));
    const skillDir = join(root, "10270");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "yun-claude-tool.json"),
      JSON.stringify({
        tools: [{
          name: "skill_10270",
          description: "投资社区",
          input_schema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
          },
          command: "node run.mjs",
        }],
      }),
      "utf8",
    );
    await writeFile(
      join(skillDir, "run.mjs"),
      [
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
        "console.log(`skill:${input.prompt}`);",
      ].join("\n"),
      "utf8",
    );

    const tools = await discoverSkillTools(root);
    expect(tools).toEqual([{
      name: "skill_10270",
      description: "投资社区",
      input_schema: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    }]);

    await expect(executeSkillTool("skill_10270", { prompt: "hello" }, { skillsDir: root, timeoutMs: 5000 }))
      .resolves
      .toContain("skill:hello");
  });

  it("安装市场 skill 时创建可注册的本地 manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "yc-skill-install-"));
    const output = await installMarketSkillTool(
      { marketId: "10270", name: "投资社区" },
      { skillsDir: root, timeoutMs: 5000 },
    );
    expect(JSON.parse(output)).toMatchObject({
      tool: {
        name: "skill_10270",
        description: expect.stringContaining("投资社区"),
      },
    });
    await expect(executeSkillTool("skill_10270", { prompt: "hello" }, { skillsDir: root, timeoutMs: 5000 }))
      .resolves
      .toContain("\"prompt\": \"hello\"");
  });
});
