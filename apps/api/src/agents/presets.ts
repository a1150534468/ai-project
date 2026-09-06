import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { presetIconAt } from "./icons.js";

/** 一个内置 Agent。`prompt` 直接当 system prompt 用，其余四个字段都是给前端列表看的。 */
export interface AgentPreset {
  /** `preset-<N>`，N 取自 presets.md 的标题编号。会被写进 `Session.agentId`，**改了就等于把老会话认丢**。 */
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
}

/**
 * 提示词全文放在同目录的 presets.md 里，而不是写成 TS 字符串。
 *
 * 理由是那是一份**给人读和改的文档**：81 份提示词、三千行，塞进 .ts 会变成谁都不敢碰的字符串墙，
 * diff 也没法看。代价是它成了运行时资产 —— 打包时必须跟着产物一起走（见 apps/api 的 build 配置），
 * 而不是被 bundler 吃掉。
 */
const PRESETS_PATH = fileURLToPath(new URL("./presets.md", import.meta.url));

/**
 * 从提示词正文里抠一句话当列表页的一句话简介。
 *
 * 不额外维护一份 description，是因为那样一定会和提示词跑偏；从正文里取则改一处即可。
 * 两条规则的顺序有讲究：先找「主要负责：」（职责，更能一句话说清这个 Agent 是干什么的），
 * 再退一步找「适合处理以下任务：」（场景）。两句都是 presets.md 里的约定写法。
 *
 * `[^。\n]+` 只吃到第一个句号或换行 —— 简介要能塞进一行卡片，多了也显示不出来。
 */
function summarizePrompt(prompt: string): string {
  const duty = prompt.match(/主要负责：([^。\n]+)/)?.[1]?.trim();
  if (duty) return duty;

  const scenario = prompt.match(/适合处理以下任务：([^。\n]+)/)?.[1]?.trim();
  if (scenario) return scenario;

  // 兜底：新写的提示词没按约定写那两句。宁可显示得含糊，也不要让这个 Agent 从列表里消失。
  return "通用智能体";
}

/**
 * 解析 presets.md。这就是 presets.md 的全部格式约定，除此之外文件里写什么都不影响运行：
 *
 * - `## N. 名字` 是一个 Agent 的开始，`N` 决定 id，标题文本就是 name；
 * - 一节的范围是「本标题之后到下一个标题之前」，最后一节吃到文件末尾；
 * - 这一节里**第一个** ` ```text ` 代码块的内容（trim 过）就是完整的 system prompt。
 *   一节里的其他代码块会被忽略，所以示例可以放在提示词块后面。
 *
 * 没有 `text` 代码块的节会被**静默跳过**。这一条有点危险：写坏一个围栏（比如少一个结尾 ```），
 * 表现就是那个 Agent 悄悄从列表里没了，没有任何报错。presets.test.ts 因此断言
 * 「标题数 === 解析出的 Agent 数」，把这种事挡在 CI 里。
 */
export function parseAgentPresets(markdown: string): AgentPreset[] {
  // 全局 + 多行：`^` 要能匹配每一行的行首，而不是整段文本的开头。
  const headings = [...markdown.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)];

  const presets: AgentPreset[] = [];

  headings.forEach((heading, idx) => {
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = idx + 1 < headings.length ? (headings[idx + 1].index ?? markdown.length) : markdown.length;
    const prompt = markdown.slice(bodyStart, bodyEnd).match(/```text\s*([\s\S]*?)```/)?.[1]?.trim();
    if (!prompt) return;

    presets.push({
      id: `preset-${heading[1]}`,
      name: heading[2].trim(),
      description: summarizePrompt(prompt),
      prompt,
      // 图标按**出现顺序**取，跟标题编号无关。icons.ts 顶部说明了这个耦合的代价。
      icon: presetIconAt(idx),
    });
  });

  return presets;
}

/**
 * 进程级缓存。presets.md 只在发布时变，没必要每次请求都读盘 + 跑 81 次正则。
 *
 * 反过来说：**改了 presets.md 必须重启进程才能看见**。dev 下热更新不会重新读这个文件。
 */
let cache: AgentPreset[] | null = null;

export function loadAgentPresets(): AgentPreset[] {
  if (!cache) cache = parseAgentPresets(readFileSync(PRESETS_PATH, "utf8"));
  return cache;
}

/** 按 id 找内置 Agent，没有就是 `null`（可能是自建 Agent 的 id，交给上层继续查库）。 */
export function getPresetAgent(id: string): AgentPreset | null {
  return loadAgentPresets().find((preset) => preset.id === id) ?? null;
}
