import type Anthropic from "@anthropic-ai/sdk";

type BuiltinHandler = (input: unknown) => string | Promise<string>;

const handlers: Readonly<Record<string, BuiltinHandler>> = Object.freeze({
  get_time: () => new Date().toISOString(),
});

export const builtinTools: Anthropic.Tool[] = [
  {
    name: "get_time",
    description: "获取当前 UTC 时间。用户询问当前时间时调用。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function execTool(name: string, input: unknown): Promise<string> {
  const handler = handlers[name];
  return handler ? await handler(input) : `未知工具: ${name}`;
}
