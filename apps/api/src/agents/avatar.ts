import type Anthropic from "@anthropic-ai/sdk";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const ALLOWED_TAGS = new Set(["g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const ALLOWED_ATTRS = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height",
  "x1", "y1", "x2", "y2", "points",
  "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "transform",
]);

export const MAX_DEPTH = 8;
export const MAX_PATH_D_BYTES = 2048;
export const MAX_TOTAL_BYTES = 8192;
export const MAX_NODES = 60;

const ATTR_PREFIX = "@_";
interface Counters { nodes: number }

function cleanAttrs(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith(ATTR_PREFIX)) continue;
    const name = key.slice(ATTR_PREFIX.length);
    if (!ALLOWED_ATTRS.has(name)) continue;  // 精确匹配、大小写敏感；OnLoad/xlink:href 天然被丢
    const text = String(value);
    if (name === "d" && Buffer.byteLength(text) > MAX_PATH_D_BYTES) throw new Error("d too long");
    out[key] = text;
  }
  return out;
}

function walk(node: unknown, depth: number, counters: Counters): unknown {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  if (typeof node !== "object" || node === null) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith(ATTR_PREFIX)) continue;
    if (key === "#text") continue;

    const children = Array.isArray(value) ? value : [value];

    if (ALLOWED_TAGS.has(key)) {
      // 允许的标签：保留属性和子元素
      const kept: unknown[] = [];
      for (const child of children) {
        counters.nodes += 1;
        if (counters.nodes > MAX_NODES) throw new Error("too many nodes");
        const obj = (typeof child === "object" && child !== null) ? child as Record<string, unknown> : {};
        const inner = walk(obj, depth + 1, counters) as Record<string, unknown> | undefined;
        kept.push({ ...cleanAttrs(obj), ...(inner ?? {}) });
      }
      result[key] = kept.length === 1 ? kept[0] : kept;
    } else {
      // 不允许的标签：递归处理其子元素，提取其中的合法元素
      // 必须也受深度/节点数约束
      for (const child of children) {
        counters.nodes += 1;
        if (counters.nodes > MAX_NODES) throw new Error("too many nodes");
        const obj = (typeof child === "object" && child !== null) ? child as Record<string, unknown> : {};
        const inner = walk(obj, depth + 1, counters) as Record<string, unknown> | undefined;
        if (inner) {
          // 将内部的元素"扁平"到父级结果中
          for (const [k, v] of Object.entries(inner)) {
            if (k in result) {
              const existing = result[k];
              result[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
            } else {
              result[k] = v;
            }
          }
        }
      }
    }
  }
  return result;
}

/**
 * SVG 白名单 sanitizer，用于 Agent 头像。
 * 仅保留 8 个绘图标签（g/path/circle/rect/ellipse/line/polyline/polygon）
 * 和 14 个几何/描边属性。所有其他标签与属性均被丢弃。
 *
 * 任何失败场景——解析错误、格式非法、深度/节点/大小超限——都返回 null。
 * 调用方应在 null 时回落到默认头像。
 *
 * @param input - 用户输入的 SVG 字符串（可能来自 LLM，不可信）
 * @returns 清理后的 SVG 字符串，或 null（任何失败）
 */
export function sanitizeAgentSvg(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed) > MAX_TOTAL_BYTES * 4) return null;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: ATTR_PREFIX,
      allowBooleanAttributes: true,
      processEntities: true,
    });
    const tree = parser.parse(trimmed) as Record<string, unknown>;
    const root = ("svg" in tree ? tree.svg : tree) as Record<string, unknown>;
    if (typeof root !== "object" || root === null) return null;
    const counters: Counters = { nodes: 0 };
    const cleaned = walk(root, 1, counters) as Record<string, unknown>;
    if (!cleaned || Object.keys(cleaned).length === 0) return null;
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: ATTR_PREFIX, suppressEmptyNode: true });
    const out = String(builder.build(cleaned)).trim();
    if (!out) return null;
    if (Buffer.byteLength(out) > MAX_TOTAL_BYTES) return null;
    // 检查是否包含至少一个非-g 的有效绘图标签
    if (!/<(path|circle|ellipse|rect|line|polyline|polygon)[\s/>]/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

const AVATAR_SYSTEM = "你是 SVG 线性图标画师。只输出标签，不要 Markdown，不要解释。";

const AVATAR_PROMPT = (name: string, description: string) =>
  `为这个智能体画一个 24×24 viewBox 的单色线性图标。
名称：${name}
职能：${description}

硬性约束：
- 只使用这些标签：g path circle ellipse rect line polyline polygon
- 最外层必须是一个 <g>，不要输出 <svg>
- 不要 fill、不要 stroke 颜色、不要 style、不要 id、不要 class
- 在最外层 <g> 上写 stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
- 节点数不超过 12 个，构图简洁，一眼能认出职能
- 只输出标签本身`;

/** 生成并净化线稿。任何失败都返回 null，调用方回落到默认图标——绝不阻断 Agent 创建。 */
export async function generateAvatarSvg(
  client: Anthropic,
  model: string,
  name: string,
  description: string,
): Promise<string | null> {
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 900,
      system: AVATAR_SYSTEM,
      messages: [{ role: "user", content: AVATAR_PROMPT(name, description) }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const stripped = text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
    return sanitizeAgentSvg(stripped);
  } catch {
    return null;
  }
}
