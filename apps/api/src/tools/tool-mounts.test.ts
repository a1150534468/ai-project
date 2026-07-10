import { describe, expect, it } from "vitest";
import { TOOL_FS_READ, TOOL_TERMINAL_EXEC, type ConnectorTool } from "@yc/connector-protocol";
import { availableInstalledToolNames, selectMountedTools } from "./tool-mounts.js";

const skillTool: ConnectorTool = {
  name: "skill_10270",
  description: "执行已安装的 skill",
  input_schema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
    },
    required: ["prompt"],
  },
};

describe("selectMountedTools", () => {
  it("默认暴露当前设备支持的内置工具", () => {
    const result = selectMountedTools({
      requestedToolIds: [],
      builtinTools: [
        {
          name: TOOL_TERMINAL_EXEC,
          description: "Run command",
          input_schema: { type: "object", properties: {}, required: [] },
        },
        {
          name: TOOL_FS_READ,
          description: "Read file",
          input_schema: { type: "object", properties: {}, required: [] },
        },
      ],
      installedTools: [],
      deviceCapabilities: [TOOL_FS_READ],
      deviceTools: [],
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([TOOL_FS_READ]);
    expect(result.allowedToolNames).toEqual(new Set([TOOL_FS_READ]));
  });

  it("动态 skill 必须同时满足用户已安装、会话已选择、设备已上报", () => {
    const result = selectMountedTools({
      requestedToolIds: ["skill_10270", "skill_missing"],
      builtinTools: [],
      installedTools: [{
        name: "投资社区",
        toolName: "skill_10270",
        description: "投资社区 skill",
      }],
      deviceCapabilities: ["skill_10270", "skill_missing"],
      deviceTools: [skillTool],
    });

    expect(result.tools).toEqual([skillTool]);
    expect(result.allowedToolNames).toEqual(new Set(["skill_10270"]));
  });
});

describe("availableInstalledToolNames", () => {
  it("只把当前设备已上报且 capability 支持的动态工具标记为本机可用", () => {
    const result = availableInstalledToolNames(
      ["skill_10270", "skill_stale"],
      [
        skillTool,
        {
          ...skillTool,
          name: "skill_missing_capability",
        },
      ],
    );

    expect(result).toEqual(new Set(["skill_10270"]));
  });
});
