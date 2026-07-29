import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  ARTICLE_WORKFLOW_HTML_ATTRS,
  ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS,
  ARTICLE_WORKFLOW_HTML_TAGS,
  ARTICLE_WORKFLOW_IMAGE_SLOT_ATTR,
  type ArticleWorkflowImageSlot,
} from "@ai-assistant/article-workflow";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";

// 词汇表跟编辑器共用一份，见 packages/article-workflow/src/html-vocabulary.ts
const ALLOWED_TAGS = new Set(ARTICLE_WORKFLOW_HTML_TAGS);
const BLOCKED_TAGS = new Set(ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS);
const ALLOWED_ATTRS = new Set(ARTICLE_WORKFLOW_HTML_ATTRS);

const BLOCKED_STYLE_PROPS = new Set([
  "position",
  "float",
  "clear",
  "z-index",
  "filter",
  "column-count",
  "column-gap",
  "columns",
  "transform",
  "animation",
]);

const FORBIDDEN_VISIBLE_PHRASES = [
  "当前项目直接复用",
  "编辑区只处理输入",
  "自动保存也只在内容真改动后触发",
  "这里看到的是最终要复制到公众号正文区的格式",
  "公众号图文工作流",
  "多平台图文工作流",
];

function validateStyle(styleText: string) {
  for (const declaration of styleText.split(";")) {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim().toLowerCase();
    if (!property) continue;
    if (BLOCKED_STYLE_PROPS.has(property)) {
      throw new Error(`HTML 包含不支持的样式属性: ${property}`);
    }
    if (property.startsWith("margin") && value.includes("-")) {
      throw new Error(`HTML 包含负 margin: ${property}`);
    }
    if (property === "height" && value && value !== "auto") {
      throw new Error("HTML 使用了固定 height");
    }
    if (property === "background-image" || value.includes("url(")) {
      throw new Error("HTML 包含不支持的背景图片样式");
    }
  }
}

function walk(node: any, requiredSlots: Set<string>) {
  if (node.nodeType === node.COMMENT_NODE) {
    throw new Error("HTML 中不能包含注释");
  }
  if (node.nodeType !== node.ELEMENT_NODE) return;

  const element = node as Element;
  const tagName = element.tagName.toLowerCase();
  if (BLOCKED_TAGS.has(tagName)) {
    throw new Error(`HTML 包含不支持的标签: <${tagName}>`);
  }
  if (!ALLOWED_TAGS.has(tagName)) {
    throw new Error(`HTML 包含未允许的标签: <${tagName}>`);
  }

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) {
      throw new Error(`HTML 包含不支持的属性: ${attr.name}`);
    }
    if (name === "style") validateStyle(attr.value);
  }

  const slot = element.getAttribute(ARTICLE_WORKFLOW_IMAGE_SLOT_ATTR)?.trim();
  if (slot) requiredSlots.delete(slot);
  Array.from(element.childNodes).forEach((child) => walk(child, requiredSlots));
}

/**
 * 可见文字的比对形态：去掉段落边界，只留字符序列。
 *
 * 「保留原文」约束的是**字**，不是分段：把一坨 817 字的整段拆成几段正是产品承诺的排版，
 * 而排版提示词本身就要求「paragraph rhythm / improve structure」。
 * 早先逐字比对含换行的可见文字，于是模型一分段就报「HTML 可见文字与预期内容不一致」——
 * 实测纯正文素材必然踩中：只多了 9 个换行，一个字都没改，整单却失败。
 *
 * 改写、增删、重排仍然拦得住：那些都会改变字符序列本身。
 */
function comparableVisibleText(value: string): string {
  return value.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("");
}

/** 收集 HTML 里出现过的图片槽位名。section 和 img 上都有这个属性，所以要去重。 */
function imageSlotNames(html: string): Set<string> {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  const slots = new Set<string>();
  if (!body) return slots;
  const all = body.getElementsByTagName("*");
  for (let index = 0; index < all.length; index += 1) {
    const slot = all[index]?.getAttribute(ARTICLE_WORKFLOW_IMAGE_SLOT_ATTR)?.trim();
    if (slot) slots.add(slot);
  }
  return slots;
}

/**
 * 保存正文时的「不可整体销毁」底线。
 *
 * 编辑器是可以换的，但换任何一个都挡不住这种情况：运营在带样式的 section 里按回车，
 * 浏览器把结构拆了；或者编辑器把它不认识的标签规范化掉。所以最后一道闸放在服务端。
 *
 * 只拦「整体销毁」两种形态，不管细节改动——正常编辑必须一路放行：
 * 1. 原来有字，存进来一个字都不剩；
 * 2. 原来有图片槽位，存进来全没了（槽位丢了会让 applyArticleImageManifestToHtml
 *    找不到锚点，退化成往尾部 appendChild，于是每存一次就重复追加一遍图片）。
 *
 * 判据取「原文有、新文没了」而非绝对值：本来就没有图的文章不该被这条挡住。
 */
export function assertArticleWorkflowBodyNotDestroyed(args: {
  readonly nextHtml: string;
  readonly currentHtml: string;
}): void {
  const currentText = comparableVisibleText(articleWorkflowVisibleTextFromHtml(args.currentHtml));
  const nextText = comparableVisibleText(articleWorkflowVisibleTextFromHtml(args.nextHtml));
  if (currentText && !nextText) {
    throw new Error("保存被拒绝：正文文字会被整体清空");
  }

  const currentSlots = imageSlotNames(args.currentHtml);
  const nextSlots = imageSlotNames(args.nextHtml);
  if (currentSlots.size > 0 && nextSlots.size === 0) {
    throw new Error("保存被拒绝：正文里的图片位置会全部丢失");
  }
}

/** 样式声明里挑掉不支持的属性，其余原样留下。返回 null 表示整条 style 都不用留了。 */
function repairStyle(styleText: string): string | null {
  const kept: string[] = [];
  for (const declaration of styleText.split(";")) {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim().toLowerCase();
    if (!property || !value) continue;
    if (BLOCKED_STYLE_PROPS.has(property)) continue;
    if (property.startsWith("margin") && value.includes("-")) continue;
    if (property === "height" && value !== "auto") continue;
    if (property === "background-image" || value.includes("url(")) continue;
    kept.push(`${property}:${rawValueParts.join(":").trim()}`);
  }
  return kept.length > 0 ? kept.join(";") : null;
}

function repairNode(node: any) {
  const children = Array.from(node.childNodes ?? []) as any[];
  for (const child of children) {
    if (child.nodeType === 8) {
      // 注释：直接摘掉
      node.removeChild(child);
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tagName = String(child.tagName ?? "").toLowerCase();

    if (BLOCKED_TAGS.has(tagName)) {
      node.removeChild(child);
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      // 脱壳：标签本身丢掉，孩子提到当前层。可见文字因此一个字都不少，
      // 后面的「可见文字完全一致」校验照样能过。
      repairNode(child);
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      node.removeChild(child);
      continue;
    }

    for (const attr of Array.from(child.attributes ?? []) as any[]) {
      const name = String(attr.name).toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const repaired = repairStyle(attr.value);
        if (repaired) child.setAttribute("style", repaired);
        else child.removeAttribute("style");
      }
    }

    repairNode(child);
  }
}

/**
 * 把排版模型的输出修到词汇表以内，而不是直接判整单失败。
 *
 * 为什么要这一层：排版是生成链路的**最后一步**，配图早就出完、钱早就花完了。
 * 模型多写一个 `<h2>`（在提示词没列清单时这完全合理）就让整行 failed，用户白掏钱。
 * 所以这里先修——未知标签脱壳、危险标签删掉、越界属性和样式摘掉——修完再交给
 * `assertArticleWorkflowHtmlFragment` 做硬校验。
 *
 * 修的都是**不影响可见文字**的操作，所以「可见文字与原文完全一致」这道闸依然有效：
 * 真正的改写、增删、漏槽位仍然会被拦下来失败，这一层不给它们放水。
 */
export function repairArticleWorkflowHtmlFragment(html: string): string {
  const normalized = html.replaceAll("\r\n", "\n").trim();
  if (!normalized) return normalized;
  const document = new DOMParser().parseFromString(`<body>${normalized}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) return normalized;
  repairNode(body);
  const serializer = new XMLSerializer();
  return Array.from(body.childNodes)
    .map((child) => serializer.serializeToString(child as any))
    .join("")
    .trim();
}

export function assertArticleWorkflowHtmlFragment(args: {
  readonly html: string;
  readonly expectedVisibleText: string;
  readonly requiredImageSlots?: readonly ArticleWorkflowImageSlot[];
}): string {
  const normalizedHtml = args.html.replaceAll("\r\n", "\n").trim();
  if (!normalizedHtml) throw new Error("模型没有返回正文 HTML");
  if (normalizedHtml.includes("<!--")) throw new Error("HTML 中不能包含注释");

  const document = new DOMParser().parseFromString(`<body>${normalizedHtml}</body>`, "text/html");
  const body = document.getElementsByTagName("body")[0];
  if (!body) throw new Error("HTML 解析失败");

  const requiredSlots = new Set(args.requiredImageSlots ?? []);
  Array.from(body.childNodes).forEach((child) => walk(child, requiredSlots));
  if (requiredSlots.size > 0) {
    throw new Error(`HTML 缺少图片槽位: ${Array.from(requiredSlots).join(", ")}`);
  }

  const visibleText = articleWorkflowVisibleTextFromHtml(normalizedHtml);
  if (comparableVisibleText(visibleText) !== comparableVisibleText(args.expectedVisibleText)) {
    throw new Error("HTML 可见文字与预期内容不一致");
  }
  for (const phrase of FORBIDDEN_VISIBLE_PHRASES) {
    if (visibleText.includes(phrase)) {
      throw new Error("HTML 中混入了解释性文案");
    }
  }
  return normalizedHtml;
}
