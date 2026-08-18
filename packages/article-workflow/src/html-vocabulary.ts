/**
 * 公众号正文 HTML 的词汇表：允许出现的标签和属性。
 *
 * 这份清单是编辑器和服务端共用的契约。之所以要共用，是因为踩过一次：
 * 编辑器（wangEditor / Slate）不认识 `section`，载入时就把版式拍平，
 * 自动保存再把拍平的结果写回库里，成品被冲掉。编辑器能放行什么、
 * 服务端 guard 要求什么，必须是同一份定义，不然迟早再次漂移。
 *
 * 服务端 guard（article-workflow-html-guard.ts）拿它做校验，
 * 编辑器（articleWorkflowHtmlSanitizer.ts）拿它做 sanitize。
 */

/**
 * 允许的标签。都是公众号编辑器粘贴后能存活的。
 *
 * `h1`–`h6`、`pre`、`code`、`thead`、`tfoot` 是补进来的：素材是 Markdown，
 * 有 `##` 就会排成 `<h2>`，有围栏代码块就会排成 `<pre><code>`。
 * 少了它们，排版模型给出完全合理的 HTML 却整单失败——线上实测踩过。
 */
export const ARTICLE_WORKFLOW_HTML_TAGS: readonly string[] = [
  "section",
  "div",
  "p",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "mark",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "img",
  "svg",
  "a",
  "blockquote",
  "pre",
  "code",
  "hr",
];

/**
 * 允许的属性。
 *
 * `data-ai-assistant-image-slot` 是承重的：服务端靠它定位图片槽位，
 * 找不到就退化成往正文尾部 appendChild，于是每保存一次就重复追加一遍图片。
 * 任何编辑器都必须原样保留它。
 */
export const ARTICLE_WORKFLOW_HTML_ATTRS: readonly string[] = [
  "style",
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "viewbox",
  "fill",
  "stroke",
  "stroke-width",
  "xmlns",
  "colspan",
  "rowspan",
  "data-ai-assistant-image-slot",
  "target",
  "rel",
];

/** 一律删掉的标签：带副作用或会破坏粘贴的。 */
export const ARTICLE_WORKFLOW_HTML_BLOCKED_TAGS: readonly string[] = [
  "html",
  "head",
  "body",
  "meta",
  "title",
  "link",
  "style",
  "script",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "iframe",
  "audio",
  "video",
  "object",
  "embed",
  "foreignobject",
];

export const ARTICLE_WORKFLOW_IMAGE_SLOT_ATTR = "data-ai-assistant-image-slot";
