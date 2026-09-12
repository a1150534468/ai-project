import { DOMParser } from "@xmldom/xmldom";
import {
  ARTICLE_WORKFLOW_IMAGE_SLOT_ATTR,
  type ArticleWorkflowImageSlot,
} from "@ai-assistant/article-workflow";
import { articleWorkflowVisibleTextFromHtml } from "./article-workflow-html-visible-text.js";
import {
  ARTICLE_BLOCKED_STYLE_PROPERTIES,
  ARTICLE_FORBIDDEN_VISIBLE_PHRASES,
  ARTICLE_HTML_ATTRIBUTES,
  ARTICLE_HTML_BLOCKED_TAGS,
  ARTICLE_HTML_TAGS,
} from "./article-workflow-html-policy.js";
export { repairArticleWorkflowHtmlFragment } from "./article-workflow-html-repair.js";

function validateStyle(styleText: string) {
  for (const declaration of styleText.split(";")) {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim().toLowerCase();
    if (!property) continue;
    if (ARTICLE_BLOCKED_STYLE_PROPERTIES.has(property)) {
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
  if (ARTICLE_HTML_BLOCKED_TAGS.has(tagName)) {
    throw new Error(`HTML 包含不支持的标签: <${tagName}>`);
  }
  if (!ARTICLE_HTML_TAGS.has(tagName)) {
    throw new Error(`HTML 包含未允许的标签: <${tagName}>`);
  }

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ARTICLE_HTML_ATTRIBUTES.has(name)) {
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
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("");
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

export function assertArticleWorkflowHtmlFragment(args: {
  readonly html: string;
  readonly expectedVisibleText: string;
  readonly requiredImageSlots?: readonly ArticleWorkflowImageSlot[];
  /**
   * 确定性渲染（非 auto 主题）下为 true：渲染器保证可见文字 = Markdown 可见文字，
   * 且不会产出解释性文案，只需守标签/属性白名单与注释禁令。
   * 可见文字的「不丢字」校验已前移到 plan 阶段（preserve-text 对比 bodyMarkdown vs 原文）。
   */
  readonly skipVisibleTextCheck?: boolean;
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

  if (!args.skipVisibleTextCheck) {
    const visibleText = articleWorkflowVisibleTextFromHtml(normalizedHtml);
    if (comparableVisibleText(visibleText) !== comparableVisibleText(args.expectedVisibleText)) {
      throw new Error("HTML 可见文字与预期内容不一致");
    }
    for (const phrase of ARTICLE_FORBIDDEN_VISIBLE_PHRASES) {
      if (visibleText.includes(phrase)) {
        throw new Error("HTML 中混入了解释性文案");
      }
    }
  }
  return normalizedHtml;
}
