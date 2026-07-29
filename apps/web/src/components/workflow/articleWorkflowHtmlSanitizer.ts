import {
  ARTICLE_WORKFLOW_HTML_ATTRS,
  ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS,
  ARTICLE_WORKFLOW_HTML_TAGS,
} from "@ai-assistant/article-workflow";

const ALLOWED_TAGS = new Set(ARTICLE_WORKFLOW_HTML_TAGS);
const BLOCKED_TAGS = new Set(ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS);
const ALLOWED_ATTRS = new Set(ARTICLE_WORKFLOW_HTML_ATTRS);

/** javascript: / data: 这类可执行 URL 不放行，图片的 data: 例外（本地开发会内联 base64） */
function safeUrl(value: string, allowInlineData: boolean): boolean {
  // 先剥掉空白和控制字符再判协议：`java\tscript:` 这种写法浏览器照样执行
  const normalized = value.toLowerCase().replace(/[\u0000-\u0020\u00a0\u2000-\u200f\u2028-\u202f\ufeff]/g, "");
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) return false;
  if (normalized.startsWith("data:")) return allowInlineData && normalized.startsWith("data:image/");
  return true;
}

/**
 * 按共用词汇表清洗节点树，原地改。
 *
 * 与服务端 guard 的区别：guard 遇到不合规就抛错（模型输出必须合规），
 * 这里是尽量救——用户粘贴来的东西该洗掉的洗掉，剩下的留着，不能让粘贴一次就整篇报废。
 * 白名单内的标签、属性、内联样式原样保留，这是替换编辑器的全部目的。
 */
function sanitizeNode(node: Element) {
  // 游标式遍历而不是先快照：脱壳会把孩子提到当前层，那些孩子也得过一遍
  let child = node.firstElementChild;
  while (child) {
    const tagName = child.tagName.toLowerCase();

    if (BLOCKED_TAGS.has(tagName)) {
      const next = child.nextElementSibling;
      child.remove();
      child = next;
      continue;
    }

    // 白名单外的标签：拆掉标签本身，保留里面的内容，别把用户的字一起删了
    if (!ALLOWED_TAGS.has(tagName)) {
      const parent = child.parentNode;
      const lifted = child.firstElementChild;
      const next = child.nextElementSibling;
      if (parent) {
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
      }
      // 退回到第一个被提上来的节点，它可能同样是白名单外的
      child = lifted ?? next;
      continue;
    }

    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) {
        child.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !safeUrl(attr.value, name === "src")) {
        child.removeAttribute(attr.name);
      }
    }

    sanitizeNode(child);
    child = child.nextElementSibling;
  }
}

/**
 * Squire 的 sanitizeToDOMFragment：把 HTML 变成 DOM 片段。
 *
 * 用 template 元素解析——它的内容是惰性的，脚本不执行、图片不发请求。
 * 不引 DOMPurify：词汇表是我们自己定的，共用一份反而比第三方默认值可控。
 */
export function articleWorkflowSanitizeToFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = document.createElement("div");
  root.appendChild(template.content.cloneNode(true));
  sanitizeNode(root);
  const fragment = document.createDocumentFragment();
  while (root.firstChild) fragment.appendChild(root.firstChild);
  return fragment;
}

/** 测试和调试用：跑一遍 sanitize 再序列化回字符串 */
export function articleWorkflowSanitizeHtml(html: string): string {
  const container = document.createElement("div");
  container.appendChild(articleWorkflowSanitizeToFragment(html));
  return container.innerHTML;
}
