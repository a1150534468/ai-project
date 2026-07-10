import { describe, expect, it } from "vitest";
import { buildInstallRecord, marketToolName, toolDefinitionForInstall } from "./market-tools.js";

describe("market tools", () => {
  it("把市场 skill 转成稳定的工具名和安装记录", () => {
    expect(marketToolName("10270")).toBe("skill_10270");
    expect(buildInstallRecord({
      categoryKey: "finance",
      marketId: "10270",
      name: "投资社区",
    })).toMatchObject({
      categoryKey: "finance",
      marketId: "10270",
      name: "投资社区",
      toolName: "skill_10270",
      status: "installed",
    });
  });

  it("安装记录可生成给模型使用的工具定义", () => {
    const tool = toolDefinitionForInstall({
      name: "投资社区",
      toolName: "skill_10270",
      description: "投资社区 skill",
    });
    expect(tool).toMatchObject({
      name: "skill_10270",
      description: expect.stringContaining("投资社区"),
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
        },
        required: ["prompt"],
      },
    });
  });
});
