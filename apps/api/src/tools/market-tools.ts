import type Anthropic from "@anthropic-ai/sdk";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface MarketInstallInput {
  categoryKey: string;
  marketId: string;
  name: string;
}

export interface ToolInstallRecord {
  categoryKey: string;
  marketId: string;
  name: string;
  toolName: string;
  description: string;
  status: "installed";
}

export interface InstalledToolDefinitionInput {
  name: string;
  toolName: string;
  description: string;
}

export function marketToolName(marketId: string): string {
  const normalized = marketId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 58);
  const name = `skill_${normalized}`;
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(`INVALID_MARKET_TOOL_ID: ${marketId}`);
  }
  return name;
}

export function buildInstallRecord(input: MarketInstallInput): ToolInstallRecord {
  return {
    categoryKey: input.categoryKey,
    marketId: input.marketId,
    name: input.name,
    toolName: marketToolName(input.marketId),
    description: `${input.name} skill`,
    status: "installed",
  };
}

export function toolDefinitionForInstall(input: InstalledToolDefinitionInput): Anthropic.Tool {
  return {
    name: input.toolName,
    description: `在用户本机执行已安装的 skill「${input.name}」。${input.description}`,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "要交给该 skill 处理的任务或输入" },
        context: { type: "string", description: "可选上下文" },
      },
      required: ["prompt"],
    },
  };
}
