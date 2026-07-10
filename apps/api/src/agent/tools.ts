import type Anthropic from "@anthropic-ai/sdk";

export const builtinTools: Anthropic.Tool[] = [
  {
    name: "get_time",
    description: "获取当前 UTC 时间。用户询问当前时间时调用。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function execTool(name: string, _input: unknown): Promise<string> {
  switch (name) {
    case "get_time":
      // 注意：测试中通过注入 now 保证可断言；运行时用真实时间
      return new Date().toISOString();
    default:
      return `未知工具: ${name}`;
  }
}
