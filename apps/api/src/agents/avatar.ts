import type Anthropic from "@anthropic-ai/sdk";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

/**
 * Agent 头像的 SVG 白名单清洗。
 *
 * 这里处理的字节来自大模型，也就是**来自不可信的输入**（提示词注入能让它吐任何东西），
 * 而清洗结果会被内联到页面里。所以策略是白名单而不是黑名单：
 * 只放行画线需要的标签和几何属性，其余一概丢掉，不试图去「识别危险的东西」。
 *
 * 黑名单在这里必输：`onload` / `OnLoad` / `&#111;nload` / `<use href="#x">` /
 * `<foreignObject>` 里塞 iframe / `<style>` 里写 `@import`，能绕的花样是列不完的。
 */

/** 真正画得出线的标签。`<g>` 不在里面 —— 只有 `<g>` 的输出等于一张白图，见 sanitizeAgentSvg 末尾的检查。 */
const DRAWING_TAGS = ["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"] as const;

/** 放行的标签：7 个画图元素 + 用来分组和挂描边样式的 `<g>`。 */
const ALLOWED_TAGS = new Set<string>(["g", ...DRAWING_TAGS]);

/** 出片里至少要有一个真画得出东西的标签。名单和 {@link DRAWING_TAGS} 同源，避免两处漂移。 */
const HAS_DRAWING_TAG = new RegExp(`<(${DRAWING_TAGS.join("|")})[\\s/>]`, "i");

/**
 * 放行的属性，20 个，全是**纯几何或纯描边**的。
 *
 * 名单里故意没有：
 * - `fill` / `stroke` / `style` / `class` —— 颜色由页面的 CSS 决定（头像要跟着主题变色），
 *   让模型指定颜色就会出现深色模式下看不见的图标；
 * - `id` —— 内联进页面后会和宿主页面的 id 撞车，`<use href="#id">` 也就没了目标；
 * - 任何 `xlink:*` / `href` —— 引用外部资源就等于开了一条外链通道。
 */
const ALLOWED_ATTRS = new Set([
  // path
  "d",
  // circle / ellipse
  "cx", "cy", "r", "rx", "ry",
  // rect（x/y 也被 text 类标签用，但那些标签本身就没放行）
  "x", "y", "width", "height",
  // line
  "x1", "y1", "x2", "y2",
  // polyline / polygon
  "points",
  // 描边与变换：不带颜色，安全
  "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "transform",
]);

/** 元素嵌套深度上限。一个 24×24 的线稿图标不可能需要 8 层 `<g>`，超了就是在试探解析器。 */
export const MAX_DEPTH = 8;

/** 单条 `d` 的字节上限。路径数据是唯一能无限膨胀的字段。 */
export const MAX_PATH_D_BYTES = 2048;

/** 出片总字节上限。这个值也是输入闸门的基数（输入放宽到 4 倍，因为脏输入里有大量待清理的噪音）。 */
export const MAX_TOTAL_BYTES = 8192;

/** 元素总数上限。挡「一万个 1px 的 rect」这种把浏览器画死的构图。 */
export const MAX_NODES = 60;

/** fast-xml-parser 用它区分属性键和子元素键。 */
const ATTR_PREFIX = "@_";

/** 节点计数在整棵树上共享一份，所以得用对象传引用。 */
interface Counters {
  nodes: number;
}

/**
 * 只留白名单里的属性。
 *
 * 匹配是**精确且大小写敏感**的，这一点是有意的：`OnLoad`、`ONLOAD`、`onload` 都不在名单里，
 * 所以不需要先把属性名归一化再判断 —— 少一步归一化就少一处能写错的地方。
 * 实体编码（`&#111;nload`）在这之前已经被解析器解开了，解开之后同样进不了名单。
 */
function cleanAttrs(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith(ATTR_PREFIX)) continue;

    const name = key.slice(ATTR_PREFIX.length);
    if (!ALLOWED_ATTRS.has(name)) continue;

    const text = String(value);
    // 超长路径直接把整张图判死，而不是截断 —— 截一半的 `d` 画出来是什么样没人知道。
    if (name === "d" && Buffer.byteLength(text) > MAX_PATH_D_BYTES) throw new Error("d too long");

    out[key] = text;
  }

  return out;
}

/**
 * 把 `children` 挂到 `result[tag]` 下面，已经有同名标签就合并成一个平坦数组。
 *
 * 必须**平坦**：非法标签那一支会把内层的合法元素提到父级，于是同一个 tag 很容易被写两次
 * （`<a><path/></a><b><path/><path/></b>`）。如果直接 `[existing, value]`，
 * 第二次写进来的数组会变成数组里的数组，XMLBuilder 拿到嵌套数组会吐出畸形标签。
 *
 * 单个元素仍然存成标量而不是长度 1 的数组，跟 fast-xml-parser 自己解析出的形状保持一致。
 */
function appendChildren(result: Record<string, unknown>, tag: string, children: unknown[]): void {
  if (children.length === 0) return;

  const existing = tag in result ? (Array.isArray(result[tag]) ? (result[tag] as unknown[]) : [result[tag]]) : [];
  const merged = [...existing, ...children];

  result[tag] = merged.length === 1 ? merged[0] : merged;
}

/**
 * 递归重建一棵只含白名单内容的树。
 *
 * 非法标签**不会**连着它的子树一起被删掉，而是「拆掉外壳、把里面的合法元素提到父级」。
 * 这样模型多包一层 `<svg>` / `<symbol>` / `<a>` 不至于让整张图作废。
 * 但拆壳的过程照样计数、照样加深度 —— 否则「一万层 `<a>` 里放一个 path」就能绕开所有上限。
 *
 * 超限一律 `throw`，由 {@link sanitizeAgentSvg} 统一转成 `null`：
 * 这些是「整张图不要了」的判定，不是「这一个节点跳过」。
 */
function walk(node: unknown, depth: number, counters: Counters): Record<string, unknown> | undefined {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  if (typeof node !== "object" || node === null) return undefined;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith(ATTR_PREFIX)) continue; // 属性走 cleanAttrs
    if (key === "#text") continue; // 文字内容一概不要，线稿图标里不该有字

    // 解析器给「只出现一次的标签」标量、给多次的数组，这里先统一成数组。
    const siblings = Array.isArray(value) ? value : [value];
    const allowed = ALLOWED_TAGS.has(key);
    const kept: unknown[] = [];

    for (const sibling of siblings) {
      counters.nodes += 1;
      if (counters.nodes > MAX_NODES) throw new Error("too many nodes");

      // 自闭合标签会被解析成空字符串，统一成对象好让下面两条路径都能处理。
      const child = typeof sibling === "object" && sibling !== null ? (sibling as Record<string, unknown>) : {};
      const inner = walk(child, depth + 1, counters);

      if (allowed) {
        kept.push({ ...cleanAttrs(child), ...(inner ?? {}) });
      } else if (inner) {
        for (const [tag, nested] of Object.entries(inner)) {
          appendChildren(result, tag, Array.isArray(nested) ? nested : [nested]);
        }
      }
    }

    if (allowed) appendChildren(result, key, kept);
  }

  return result;
}

/**
 * 把不可信的 SVG 洗成可以内联进页面的线稿片段；洗不出干净结果就返回 `null`。
 *
 * **所有失败都收敛成 `null`**（解析报错、结构不对、超深、超大、节点太多、洗完啥也不剩），
 * 调用方看到 `null` 就回落到默认图标。这里不抛错也不区分原因：对调用方来说
 * 「这张图不能用」和「为什么不能用」没有行为差别，而少一个错误分支就少一处漏判。
 *
 * @param input 模型吐出来的 SVG 文本，完全不可信
 * @returns 清洗后的片段（通常是一个 `<g>`），或 `null`
 */
export function sanitizeAgentSvg(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 输入闸门放到出片上限的 4 倍：脏输入里可能有大量会被洗掉的属性和注释，
  // 但也不能无限大 —— 解析器是在超限检查之前跑的，得先挡住明显的巨型输入。
  if (Buffer.byteLength(trimmed) > MAX_TOTAL_BYTES * 4) return null;

  try {
    const parser = new XMLParser({
      ignoreAttributes: false, // 属性必须拿到手里才能过白名单
      attributeNamePrefix: ATTR_PREFIX,
      allowBooleanAttributes: true, // `<path d="…" hidden>` 这种不该让整棵树解析失败
      processEntities: true, // 先把 `&#111;nload` 解开，再让它撞在白名单上
    });

    const tree = parser.parse(trimmed) as Record<string, unknown>;
    // 提示词要的是一个 `<g>`，但模型经常自己包一层 `<svg>`；两种都收。
    const root = ("svg" in tree ? tree.svg : tree) as Record<string, unknown>;
    if (typeof root !== "object" || root === null) return null;

    const cleaned = walk(root, 1, { nodes: 0 });
    if (!cleaned || Object.keys(cleaned).length === 0) return null;

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: ATTR_PREFIX,
      suppressEmptyNode: true, // 出 `<path/>` 而不是 `<path></path>`
    });
    const out = String(builder.build(cleaned)).trim();
    if (!out) return null;

    // 上限判在出片上，而不是输入上 —— 洗完才知道真正会进页面的是多少字节。
    if (Buffer.byteLength(out) > MAX_TOTAL_BYTES) return null;

    // 只剩 `<g>` 的结果是一张什么都没有的图。这种情况下宁可用默认图标，
    // 也不要在界面上留一块「明明有头像但看不见」的空白。
    if (!HAS_DRAWING_TAG.test(out)) return null;

    return out;
  } catch {
    return null;
  }
}

/**
 * 画图那一路的 system prompt。
 *
 * 导出是给测试用的：routes.test.ts 里的假模型要靠它把「画头像」和「生成 Agent 配置」
 * 这两次 `messages.create` 分开。用常量比较比 `system.includes("SVG")` 这种子串猜测靠得住。
 */
export const AVATAR_SYSTEM = "你是 SVG 线性图标画师。只输出标签，不要 Markdown，不要解释。";

/** 提示词里报给模型的可用标签，和 sanitizer 的白名单同源 —— 免得放宽了白名单却忘了告诉模型。 */
const TAG_LIST = ["g", ...DRAWING_TAGS].join(" ");

/**
 * 约束写得这么细，是因为不满足约束的部分会被 {@link sanitizeAgentSvg} 直接洗掉：
 * 模型给了颜色也不会生效，给了 `<text>` 会整块消失。与其事后清理，不如先说清楚。
 */
const AVATAR_PROMPT = (name: string, description: string) =>
  `画一个能代表这个智能体的单色线性图标，画布是 24×24 的 viewBox。

智能体：${name}
它负责：${description}

必须守的规矩：
- 可用标签只有 ${TAG_LIST}，别的一个都不许出现
- 最外层就是一个 <g>，不要再套 <svg>
- 描边写在最外层 <g> 上：stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
- 不要 fill、不要 stroke 颜色、不要 style / id / class —— 颜色由页面决定
- 元素总数控制在 12 个以内，构图简到一眼能看出它干什么
- 直接输出标签，前后不要任何说明文字，也不要代码围栏`;

/**
 * 让模型画一张头像线稿并清洗。
 *
 * **任何失败都返回 `null`**（模型报错、超时、输出洗不干净），调用方回落到默认图标。
 * 头像是锦上添花的东西，绝不能因为它画不出来就让 Agent 创建失败 —— 用户要的是那个 Agent，
 * 不是那张图。
 */
export async function generateAvatarSvg(
  client: Anthropic,
  model: string,
  name: string,
  description: string,
): Promise<string | null> {
  try {
    const resp = await client.messages.create({
      model,
      // 一张 12 个节点以内的线稿几百 token 就够；给太多只会让模型开始写解释。
      max_tokens: 900,
      system: AVATAR_SYSTEM,
      messages: [{ role: "user", content: AVATAR_PROMPT(name, description) }],
    });

    const text = resp.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // 明说了不要围栏，模型还是会加。这条正则把开围栏（带不带语言都行）和闭围栏一起吃掉。
    return sanitizeAgentSvg(text.replace(/```[a-z]*\n?/gi, "").trim());
  } catch {
    return null;
  }
}
